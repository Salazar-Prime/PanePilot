import { basename, join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  powerMonitor,
  shell
} from 'electron'
import type {
  CreatePortForwardInput,
  CreateProjectInput,
  CreateProjectActionInput,
  LatexChatMode,
  SynthesizeSpeechInput,
  StartLatexChatInput,
  StartTerminalInput,
  UpdateLatexProjectInput,
  UpdateProjectActionInput,
  UpdateSpeechSettingsInput
} from '../shared/types'
import { ConversationIndexer } from './conversation-indexer'
import {
  downloadLocalFile,
  listLocalFiles,
  openLocalPath,
  previewLocalFile,
  searchLocalFiles,
  writeLocalFile
} from './file-service'
import { LatexProjectService } from './latex-project-service'
import { normalizeOptionalWebUrl } from './latex-paths'
import { PortForwardManager, testSshConnection } from './port-forward-manager'
import { ProjectMetadataService } from './project-metadata-service'
import { projectTypeServices } from './project-type-services'
import { RemoteConversationIndexer } from './remote-conversation-indexer'
import {
  downloadRemoteFile,
  listRemoteFilesAsync,
  listRemoteFolders,
  openRemotePath,
  previewRemoteFileAsync,
  searchRemoteFiles,
  writeRemoteFileAsync
} from './remote-file-service'
import { discoverSshAliases } from './ssh-config'
import { SpeechService } from './speech-service'
import { Store } from './store'
import { TerminalManager } from './terminal-manager'

let mainWindow: BrowserWindow | null = null
let store: Store
let terminals: TerminalManager
let conversations: ConversationIndexer
let remoteConversations: RemoteConversationIndexer
let portForwards: PortForwardManager
let latex: LatexProjectService
let metadata: ProjectMetadataService
let speech: SpeechService

// Keep the existing application-data identity when the packaged product name is PanePilot.
app.setName('PanePilot')
app.setPath('userData', join(app.getPath('appData'), 'project-console'))
const ownsSingleInstanceLock = app.requestSingleInstanceLock()

async function openExternalWebUrl(rawUrl: string): Promise<void> {
  const url = normalizeOptionalWebUrl(rawUrl, 'External URL')
  if (!url) throw new Error('External URL is required.')
  await shell.openExternal(url)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 650,
    title: 'PanePilot',
    backgroundColor: '#090b10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 17, y: 17 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalWebUrl(url).catch((error) => {
      console.error('Could not open external URL.', error)
    })
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('connections:list', () => store.listConnections())
  ipcMain.handle('connections:refresh', () => {
    store.syncConnections(discoverSshAliases())
    return store.listConnections()
  })
  ipcMain.handle('connections:test', (_event, connectionId: string) => {
    const connection = store.getConnection(connectionId)
    if (!connection || connection.kind !== 'ssh' || !connection.sshAlias) {
      throw new Error('Choose a valid SSH connection.')
    }
    return testSshConnection(connection.sshAlias)
  })
  ipcMain.handle('projects:list', () => store.listProjects())
  ipcMain.handle('projects:choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('projects:create', (_event, input: CreateProjectInput) => {
    const connection = store.getConnection(input.connectionId)
    if (!connection) throw new Error('Choose a valid connection.')
    const service = projectTypeServices.get(input.type)
    if (!service) throw new Error('Choose a supported project type.')
    return service.create(store, input, connection)
  })
  ipcMain.handle('projects:rename', (_event, projectId: string, name: string) => {
    store.renameProject(projectId, name)
  })
  ipcMain.handle('projects:archive', (_event, projectId: string) => {
    store.archiveProject(projectId, true)
  })
  ipcMain.handle('projects:restore', (_event, projectId: string) => {
    store.archiveProject(projectId, false)
  })
  ipcMain.handle('projects:delete', (_event, projectId: string) => {
    store.deleteProject(projectId)
  })
  ipcMain.handle(
    'projects:update-repository',
    (_event, projectId: string, rawUrl: string | null) => {
      store.updateProjectRepository(
        projectId,
        normalizeOptionalWebUrl(rawUrl ?? undefined, 'Repository URL')
      )
    }
  )
  ipcMain.handle('projects:open-repository', async (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only web repository URLs can be opened.')
    await shell.openExternal(url)
  })

  ipcMain.handle('terminals:start', (_event, input: StartTerminalInput) => terminals.start(input))
  ipcMain.handle('actions:sync', (_event, projectId: string) =>
    terminals.syncActions(projectId)
  )
  ipcMain.handle('actions:create', (_event, input: CreateProjectActionInput) =>
    terminals.createAction(input)
  )
  ipcMain.handle('actions:update', (_event, input: UpdateProjectActionInput) =>
    terminals.updateAction(input)
  )
  ipcMain.handle('actions:run', (_event, actionId: string) =>
    terminals.runAction(actionId)
  )
  ipcMain.handle('actions:stop', (_event, actionId: string) => {
    terminals.stopAction(actionId)
  })
  ipcMain.handle('actions:delete', (_event, actionId: string) => {
    terminals.deleteAction(actionId)
  })
  ipcMain.handle('project-qna:start', (_event, projectId: string) =>
    terminals.startProjectQna(projectId)
  )
  ipcMain.handle('project-qna:reset', (_event, projectId: string) => {
    terminals.resetProjectQna(projectId)
  })
  ipcMain.handle(
    'project-qna:send-prompt',
    (_event, sessionId: string, prompt: string) => {
      terminals.sendProjectQnaPrompt(sessionId, prompt)
    }
  )
  ipcMain.handle('terminals:discover', (_event, connectionId?: string) =>
    terminals.reconcileRemoteSessions(connectionId)
  )
  ipcMain.handle(
    'terminals:attach',
    (_event, sessionId: string, cols: number, rows: number) =>
      terminals.attach(sessionId, cols, rows)
  )
  ipcMain.handle(
    'terminals:retry-attach',
    (_event, sessionId: string, cols: number, rows: number) =>
      terminals.retryAttach(sessionId, cols, rows)
  )
  ipcMain.handle('terminals:capture-buffer', (_event, sessionId: string) =>
    terminals.captureBuffer(sessionId)
  )

  ipcMain.handle('latex:get-workspace', (_event, projectId: string) =>
    latex.getWorkspace(projectId)
  )
  ipcMain.handle('latex:get-pdf', (_event, projectId: string) =>
    latex.getPdf(projectId)
  )
  ipcMain.handle('latex:update', (_event, input: UpdateLatexProjectInput) =>
    latex.update(input)
  )
  ipcMain.handle('latex:start-chat', (_event, input: StartLatexChatInput) =>
    latex.startChat(input)
  )
  ipcMain.handle(
    'latex:set-chat-mode',
    (_event, sessionId: string, mode: LatexChatMode) => {
      latex.setChatMode(sessionId, mode)
    }
  )
  ipcMain.handle('latex:send-prompt', (_event, sessionId: string, prompt: string) => {
    latex.sendPrompt(sessionId, prompt)
  })
  ipcMain.handle('latex:changes', (_event, sessionId: string) =>
    latex.changes(sessionId)
  )
  ipcMain.handle('latex:clear-changes', (_event, sessionId: string) => {
    latex.clearChanges(sessionId)
  })
  ipcMain.handle('terminals:write', (_event, sessionId: string, data: string) => {
    terminals.write(sessionId, data)
  })
  ipcMain.handle(
    'terminals:resize',
    (_event, sessionId: string, cols: number, rows: number) => {
      terminals.resize(sessionId, cols, rows)
    }
  )
  ipcMain.handle('terminals:acknowledge', (_event, sessionId: string) => {
    terminals.acknowledge(sessionId)
  })
  ipcMain.handle(
    'terminals:resume-agent',
    (_event, sessionId: string, dangerousModeConfirmed = false) => {
      terminals.resumeAgent(sessionId, dangerousModeConfirmed)
    }
  )
  ipcMain.handle('terminals:rename', (_event, sessionId: string, name: string) => {
    terminals.rename(sessionId, name)
  })
  ipcMain.handle('terminals:set-pinned', (_event, sessionId: string, pinned: boolean) => {
    terminals.setPinned(sessionId, pinned)
  })
  ipcMain.handle(
    'terminals:set-flagged',
    (_event, sessionId: string, flagged: boolean) => {
      terminals.setFlagged(sessionId, flagged)
    }
  )
  ipcMain.handle('terminals:stop', (_event, sessionId: string) => terminals.stop(sessionId))
  ipcMain.handle('terminals:archive', (_event, sessionId: string) =>
    terminals.archive(sessionId)
  )
  ipcMain.handle('terminals:restore', (_event, sessionId: string) =>
    terminals.restore(sessionId)
  )
  ipcMain.handle('terminals:delete', (_event, sessionId: string) =>
    terminals.delete(sessionId)
  )

  ipcMain.handle('files:list', async (_event, projectId: string, relativePath = '.') => {
    const project = store.getProject(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return connection.kind === 'local'
      ? listLocalFiles(project.folder, relativePath)
      : listRemoteFilesAsync(connection.sshAlias!, project.folder, relativePath)
  })

  ipcMain.handle('files:search', async (_event, projectId: string, query: string) => {
    const project = store.getProject(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return connection.kind === 'local'
      ? searchLocalFiles(project.folder, query)
      : searchRemoteFiles(connection.sshAlias!, project.folder, query)
  })

  ipcMain.handle('notes:list', (_event, projectId: string) =>
    metadata.listNotes(projectId)
  )
  ipcMain.handle('notes:create', (_event, projectId: string, name: string) =>
    metadata.createNote(projectId, name)
  )
  ipcMain.handle('notes:read', (_event, projectId: string, path: string) =>
    metadata.readNote(projectId, path)
  )
  ipcMain.handle(
    'notes:write',
    (_event, projectId: string, path: string, content: string) =>
      metadata.writeNote(projectId, path, content)
  )
  ipcMain.handle(
    'notes:rename',
    (_event, projectId: string, path: string, name: string) =>
      metadata.renameNote(projectId, path, name)
  )
  ipcMain.handle('notes:delete', (_event, projectId: string, path: string) => {
    metadata.deleteNote(projectId, path)
  })
  ipcMain.handle('files:preview', async (_event, projectId: string, relativePath: string) => {
    const project = store.getProject(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return connection.kind === 'local'
      ? previewLocalFile(project.folder, relativePath)
      : previewRemoteFileAsync(connection.sshAlias!, project.folder, relativePath)
  })
  ipcMain.handle('files:open', async (_event, projectId: string, relativePath: string) => {
    const project = store.getProject(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return connection.kind === 'local'
      ? openLocalPath(project.folder, relativePath)
      : openRemotePath(connection.sshAlias!, project.folder, relativePath)
  })
  ipcMain.handle(
    'files:save',
    async (_event, projectId: string, relativePath: string, content: string) => {
      const project = store.getProject(projectId)
      if (!project) throw new Error('Project not found.')
      const connection = store.getConnection(project.connectionId)
      if (!connection) throw new Error('Project connection not found.')
      if (connection.kind === 'local') {
        writeLocalFile(project.folder, relativePath, content)
      } else {
        await writeRemoteFileAsync(
          connection.sshAlias!,
          project.folder,
          relativePath,
          content
        )
      }
    }
  )
  ipcMain.handle(
    'files:download',
    async (_event, projectId: string, relativePath: string) => {
      const project = store.getProject(projectId)
      if (!project) throw new Error('Project not found.')
      const connection = store.getConnection(project.connectionId)
      if (!connection) throw new Error('Project connection not found.')
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: 'Download project file',
        defaultPath: join(app.getPath('downloads'), basename(relativePath))
      })
      if (result.canceled || !result.filePath) return false
      if (connection.kind === 'local') {
        downloadLocalFile(project.folder, relativePath, result.filePath)
      } else {
        await downloadRemoteFile(
          connection.sshAlias!,
          project.folder,
          relativePath,
          result.filePath
        )
      }
      return true
    }
  )

  ipcMain.handle('port-forwards:list', (_event, connectionId: string) => {
    const connection = store.getConnection(connectionId)
    if (!connection || connection.kind !== 'ssh') {
      throw new Error('Choose a valid SSH connection.')
    }
    return portForwards.list(connectionId)
  })
  ipcMain.handle(
    'port-forwards:create',
    (_event, input: CreatePortForwardInput) => portForwards.create(input)
  )
  ipcMain.handle('port-forwards:start', (_event, id: string) => portForwards.start(id))
  ipcMain.handle('port-forwards:stop', (_event, id: string) => {
    portForwards.stop(id)
  })
  ipcMain.handle('port-forwards:delete', (_event, id: string) => {
    portForwards.delete(id)
  })

  ipcMain.handle('speech:status', () => speech.status())
  ipcMain.handle(
    'speech:update-settings',
    (_event, input: UpdateSpeechSettingsInput) => speech.updateSettings(input)
  )
  ipcMain.handle('speech:test-connection', () => speech.testConnection())
  ipcMain.handle('speech:synthesize', (_event, input: SynthesizeSpeechInput) =>
    speech.synthesize(input)
  )

  ipcMain.handle('system:copy-text', (_event, text: string) => {
    clipboard.writeText(text)
  })
  ipcMain.handle('system:read-text', () => clipboard.readText())
  ipcMain.handle('system:open-project-folder', async (_event, projectId: string) => {
    const project = store.getProject(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (connection?.kind !== 'local') {
      throw new Error('Remote projects do not have a local Finder folder.')
    }
    const error = await shell.openPath(project.folder)
    if (error) throw new Error(error)
  })
  ipcMain.handle('system:open-external', async (_event, rawUrl: string) => {
    await openExternalWebUrl(rawUrl)
  })

  ipcMain.handle(
    'remote-folders:list',
    (_event, connectionId: string, path?: string) => {
      const connection = store.getConnection(connectionId)
      if (!connection || connection.kind !== 'ssh' || !connection.sshAlias) {
        throw new Error('Choose a valid SSH connection.')
      }
      return listRemoteFolders(connection.sshAlias, path)
    }
  )

  ipcMain.handle('conversations:list', async (_event, projectId: string, query = '') => {
    const project = store.getProject(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return connection.kind === 'local'
      ? conversations.list(project.folder, query)
      : remoteConversations.list(
          connection.sshAlias ?? connection.name,
          project.folder,
          query
        )
  })
  ipcMain.handle(
    'conversations:get',
    async (_event, projectId: string, conversationId: string, query = '') => {
      const project = store.getProject(projectId)
      if (!project) throw new Error('Project not found.')
      const connection = store.getConnection(project.connectionId)
      if (!connection) throw new Error('Project connection not found.')
      return connection.kind === 'local'
        ? conversations.get(project.folder, conversationId, query)
        : remoteConversations.get(
            connection.sshAlias ?? connection.name,
            project.folder,
            conversationId,
            query
          )
    }
  )
}

if (!ownsSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app
    .whenReady()
    .then(() => {
      store = new Store(app.getPath('userData'))
      store.syncConnections(discoverSshAliases())
      conversations = new ConversationIndexer()
      remoteConversations = new RemoteConversationIndexer()
      metadata = new ProjectMetadataService(store)
      terminals = new TerminalManager(
        store,
        () => mainWindow,
        conversations,
        remoteConversations,
        metadata
      )
      latex = new LatexProjectService(store, terminals)
      speech = new SpeechService(store)
      portForwards = new PortForwardManager(store, () => {
        mainWindow?.webContents.send('port-forward:changed')
      })
      registerIpc()
      createWindow()
      powerMonitor.on('resume', () => {
        terminals.reconnectAfterWake()
      })
      void terminals
        .reconcileRemoteSessions()
        .catch(() => 0)
        .then(() => terminals.discoverSavedProviderSessions())

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.stack || error.message : String(error)
      console.error(message)
      dialog.showErrorBox('PanePilot could not start', message)
      app.quit()
    })
}

app.on('before-quit', () => {
  speech?.close()
  terminals?.shutdown()
  portForwards?.shutdown()
  store?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
