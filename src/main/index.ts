import { join } from 'node:path'
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type {
  CreatePortForwardInput,
  CreateProjectInput,
  StartTerminalInput
} from '../shared/types'
import { ConversationIndexer } from './conversation-indexer'
import { listLocalFiles, previewLocalFile, writeLocalFile } from './file-service'
import { discoverRepository } from './git'
import { PortForwardManager, testSshConnection } from './port-forward-manager'
import { projectTypeServices } from './project-type-services'
import { RemoteConversationIndexer } from './remote-conversation-indexer'
import {
  listRemoteFiles,
  listRemoteFolders,
  previewRemoteFile,
  writeRemoteFile
} from './remote-file-service'
import { discoverSshAliases } from './ssh-config'
import { Store } from './store'
import { TerminalManager } from './terminal-manager'

let mainWindow: BrowserWindow | null = null
let store: Store
let terminals: TerminalManager
let conversations: ConversationIndexer
let remoteConversations: RemoteConversationIndexer
let portForwards: PortForwardManager

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

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('connections:list', () => store.listConnections())
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
    projectTypeServices.get('terminal')!.validateCreate(input, connection)
    const repositoryUrl = connection.kind === 'local' ? discoverRepository(input.folder) : null
    return store.createProject({
      name: input.name.trim(),
      connectionId: input.connectionId,
      folder: input.folder.trim(),
      repositoryUrl
    })
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
  ipcMain.handle('projects:open-repository', async (_event, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only web repository URLs can be opened.')
    await shell.openExternal(url)
  })

  ipcMain.handle('terminals:start', (_event, input: StartTerminalInput) => terminals.start(input))
  ipcMain.handle(
    'terminals:attach',
    (_event, sessionId: string, cols: number, rows: number) =>
      terminals.attach(sessionId, cols, rows)
  )
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
  ipcMain.handle('terminals:resume-agent', (_event, sessionId: string) => {
    terminals.resumeAgent(sessionId)
  })
  ipcMain.handle('terminals:rename', (_event, sessionId: string, name: string) => {
    terminals.rename(sessionId, name)
  })
  ipcMain.handle('terminals:set-pinned', (_event, sessionId: string, pinned: boolean) => {
    terminals.setPinned(sessionId, pinned)
  })
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

  ipcMain.handle('files:list', (_event, projectId: string, relativePath = '.') => {
    const project = store.getProject(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return connection.kind === 'local'
      ? listLocalFiles(project.folder, relativePath)
      : listRemoteFiles(connection.sshAlias!, project.folder, relativePath)
  })
  ipcMain.handle('files:preview', (_event, projectId: string, relativePath: string) => {
    const project = store.getProject(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return connection.kind === 'local'
      ? previewLocalFile(project.folder, relativePath)
      : previewRemoteFile(connection.sshAlias!, project.folder, relativePath)
  })
  ipcMain.handle(
    'files:save',
    (_event, projectId: string, relativePath: string, content: string) => {
      const project = store.getProject(projectId)
      if (!project) throw new Error('Project not found.')
      const connection = store.getConnection(project.connectionId)
      if (!connection) throw new Error('Project connection not found.')
      if (connection.kind === 'local') {
        writeLocalFile(project.folder, relativePath, content)
      } else {
        writeRemoteFile(connection.sshAlias!, project.folder, relativePath, content)
      }
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

  ipcMain.handle('system:copy-text', (_event, text: string) => {
    clipboard.writeText(text)
  })
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

app
  .whenReady()
  .then(() => {
    store = new Store(app.getPath('userData'))
    store.syncConnections(discoverSshAliases())
    conversations = new ConversationIndexer()
    remoteConversations = new RemoteConversationIndexer()
    terminals = new TerminalManager(
      store,
      () => mainWindow,
      conversations,
      remoteConversations
    )
    portForwards = new PortForwardManager(store, () => {
      mainWindow?.webContents.send('port-forward:changed')
    })
    registerIpc()
    createWindow()
    void terminals.discoverSavedProviderSessions()

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

app.on('before-quit', () => {
  terminals?.shutdown()
  portForwards?.shutdown()
  store?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
