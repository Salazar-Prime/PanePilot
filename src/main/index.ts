import { basename, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  powerMonitor,
  protocol,
  shell
} from 'electron'
import type {
  ConnectGoogleDriveInput,
  CreateLatexCommentInput,
  CreatePortForwardInput,
  CreateProjectInput,
  CreateProjectActionInput,
  LatexChatMode,
  PrintLatexPdfInput,
  ProjectFolderSelectionPurpose,
  SendLatexInlineEditInput,
  StartLatexChatInput,
  StartTerminalInput,
  UpdateLatexProjectInput,
  UpdateProjectActionInput
} from '../shared/types'
import { ConversationIndexer } from './conversation-indexer'
import { CodexSubagentReader } from './codex-subagents'
import {
  createLocalDirectory,
  createLocalFile,
  downloadLocalFile,
  listLocalFiles,
  openLocalPath,
  previewLocalFile,
  previewLocalFileAsync,
  resolveLocalFilePath,
  renameLocalEntry,
  searchLocalFiles,
  writeLocalFile
} from './file-service'
import { GoogleDriveService } from './google-drive-service'
import { GitService } from './git'
import { LatexProjectService } from './latex-project-service'
import { normalizeOptionalWebUrl } from './latex-paths'
import { printLatexPdf } from './pdf-printer'
import { PortForwardManager, testSshConnection } from './port-forward-manager'
import { ProjectMetadataService } from './project-metadata-service'
import { projectTypeServices } from './project-type-services'
import { RemoteConversationIndexer } from './remote-conversation-indexer'
import {
  createRemoteDirectory,
  createRemoteFile,
  downloadRemoteFile,
  listRemoteFilesAsync,
  listRemoteFolders,
  openRemotePath,
  previewRemoteFileAsync,
  renameRemoteEntry,
  searchRemoteFiles,
  writeRemoteFileAsync
} from './remote-file-service'
import { discoverSshAliases } from './ssh-config'
import { Store } from './store'
import { TerminalManager } from './terminal-manager'
import { HostTerminalService } from './host-terminal-service'
import { TerminalDropService } from './terminal-drop-service'
import { AppUpdateService } from './app-update-service'
import { HTML_PREVIEW_SCHEME, HTML_PREVIEW_PRIVILEGES, InteractiveHtmlPreviewService, guardInteractiveHtmlNavigation, isInteractiveHtmlUrl } from './html-interactive-preview'
import type { OpenInteractiveHtmlInput } from '../shared/types'

protocol.registerSchemesAsPrivileged([{ scheme: HTML_PREVIEW_SCHEME, privileges: HTML_PREVIEW_PRIVILEGES }])

let mainWindow: BrowserWindow | null = null
let store: Store
let terminals: TerminalManager
let hostTerminals: HostTerminalService
let terminalDrops: TerminalDropService
let conversations: ConversationIndexer
let remoteConversations: RemoteConversationIndexer
const codexSubagents = new CodexSubagentReader()
const interactiveHtml = new InteractiveHtmlPreviewService(async (projectId, path) => {
  const project = store.getProjectForRuntime(projectId)
  if (!project || project.archived) throw new Error('Project not found.')
  const connection = store.getConnection(project.connectionId)
  if (!connection) throw new Error('Project connection not found.')
  return connection.kind === 'local' ? previewLocalFileAsync(project.folder, path)
    : previewRemoteFileAsync(connection.sshAlias ?? connection.name, project.folder, path)
})
let portForwards: PortForwardManager
let latex: LatexProjectService
let metadata: ProjectMetadataService
let googleDrive: GoogleDriveService
let gitService: GitService
const appUpdates = new AppUpdateService({
  platform: process.platform, packaged: app.isPackaged, currentVersion: app.getVersion(),
  readConfig: async () => JSON.parse(await readFile(join(process.resourcesPath, 'panepilot-updates.json'), 'utf8')),
  loadBridge: async () => (await import('electron-sparkle-updater')).loadSparkleBridgeForApp(),
  notify: (state) => { if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('updates:changed', state) },
  restartBlocker: () => terminalDrops?.hasActiveTransfers() ? 'Wait for file transfers to finish before updating.' : terminals?.updateRestartBlocker() ?? hostTerminals?.updateRestartBlocker() ?? null
})

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
      nodeIntegrationInSubFrames: false,
      nodeIntegration: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.on('blur', () => {
    mainWindow?.webContents.setIgnoreMenuShortcuts(false)
  })
  mainWindow.webContents.on('did-start-loading', () => {
    mainWindow?.webContents.setIgnoreMenuShortcuts(false)
  })
  guardInteractiveHtmlNavigation(mainWindow.webContents, interactiveHtml)
  mainWindow.webContents.setWindowOpenHandler(({ url, referrer }) => {
    if (isInteractiveHtmlUrl(referrer.url) || isInteractiveHtmlUrl(url)) return { action: 'deny' }
    void openExternalWebUrl(url).catch((error) => {
      console.error('Could not open external URL.', error)
    })
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  const hostTerminalSender = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid host terminal sender.')
  }
  ipcMain.handle('host-terminals:list', (event) => { hostTerminalSender(event); return hostTerminals.list() })
  ipcMain.handle('host-terminals:create', (event) => { hostTerminalSender(event); return hostTerminals.create() })
  ipcMain.handle('host-terminals:close', async (event, id: string) => {
    hostTerminalSender(event)
    const session = store.getHostTerminal(id)
    if (!session) throw new Error('Host terminal not found.')
    const response = await dialog.showMessageBox(mainWindow!, {
      type: 'warning', title: `Close ${session.name}?`, message: `Close ${session.name}?`,
      detail: 'This stops only this local host terminal and its running commands. Project terminals are not affected.',
      buttons: ['Cancel', 'Close terminal'], defaultId: 0, cancelId: 0, noLink: true
    })
    if (response.response === 1) await hostTerminals.close(id)
  })
  ipcMain.handle('host-terminals:attach', (event, id: string, cols: number, rows: number) => { hostTerminalSender(event); return hostTerminals.attach(id, cols, rows) })
  ipcMain.handle('host-terminals:retry-attach', (event, id: string, cols: number, rows: number) => { hostTerminalSender(event); return hostTerminals.retryAttach(id, cols, rows) })
  ipcMain.handle('host-terminals:write', (event, id: string, data: string) => { hostTerminalSender(event); hostTerminals.write(id, data) })
  ipcMain.handle('host-terminals:resize', (event, id: string, cols: number, rows: number) => { hostTerminalSender(event); hostTerminals.resize(id, cols, rows) })
  ipcMain.handle('host-terminals:capture-buffer', (event, id: string) => { hostTerminalSender(event); return hostTerminals.captureBuffer(id) })
  const updateSender = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid update sender.')
  }
  ipcMain.handle('updates:get', (event) => { updateSender(event); return appUpdates.get() })
  ipcMain.handle('updates:check', (event) => { updateSender(event); return appUpdates.check() })
  ipcMain.handle('updates:restart', (event) => { updateSender(event); return appUpdates.restart() })
  ipcMain.handle('files:interactive-html:open', (event, input: OpenInteractiveHtmlInput) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid HTML preview sender.')
    return interactiveHtml.open(event.sender.id, input)
  })
  ipcMain.handle('files:interactive-html:close', (event, id: string) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || typeof id !== 'string') throw new Error('Invalid HTML preview sender.')
    interactiveHtml.close(event.sender.id, id)
  })
  ipcMain.handle('quick-notes:get', (event) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid quick notes sender.')
    return store.getQuickNotes()
  })
  ipcMain.handle('quick-notes:save', (event, document: unknown) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid quick notes sender.')
    return store.saveQuickNotes(document)
  })
  ipcMain.handle('files:import', (event, projectId: string, parentPath: string, paths: string[]) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid file import sender.')
    return terminalDrops.copyToProject(projectId, parentPath, paths)
  })
  ipcMain.handle('terminal-drops:drop', (event, sessionId: string, paths: string[]) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Invalid upload sender.')
    return terminalDrops.drop(sessionId, paths)
  })
  ipcMain.handle('terminal-drops:list', (event) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Invalid upload sender.')
    return terminalDrops.list()
  })
  ipcMain.on(
    'workspace-history:set-switcher-open',
    (event, open: unknown) => {
      if (event.sender !== mainWindow?.webContents) return
      event.sender.setIgnoreMenuShortcuts(open === true)
    }
  )
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
  ipcMain.handle('projects:list', () => store.listProjectsForRenderer())
  ipcMain.handle('projects:get', (_event, projectId: string) =>
    store.getProjectForRenderer(projectId)
  )
  ipcMain.handle('projects:choose-folder', async (_event, rawPurpose?: unknown) => {
    const purpose: ProjectFolderSelectionPurpose =
      rawPurpose === 'parent' ? 'parent' : 'project'
    const result = await dialog.showOpenDialog(mainWindow!, {
      title:
        purpose === 'parent'
          ? 'Choose where to create the new project folder'
          : 'Choose a project folder',
      buttonLabel: purpose === 'parent' ? 'Choose Location' : 'Choose Project',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('projects:create', async (_event, input: CreateProjectInput) => {
    const connection = store.getConnection(input.connectionId)
    if (!connection) throw new Error('Choose a valid connection.')
    const service = projectTypeServices.get(input.type)
    if (!service) throw new Error('Choose a supported project type.')
    return service.create(store, input, connection)
  })
  ipcMain.handle('projects:rename', (_event, projectId: string, name: string) => {
    store.renameProject(projectId, name)
  })
  ipcMain.handle(
    'projects:set-icon',
    (_event, projectId: string, icon: string | null) => {
      store.setProjectIcon(projectId, icon)
    }
  )
  ipcMain.handle('projects:archive', (_event, projectId: string) => {
    terminals.archiveProject(projectId)
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
  ipcMain.handle('git:status', (_event, projectId: string) =>
    gitService.status(projectId)
  )
  ipcMain.handle('git:repository-visibility', (_event, projectId: string) =>
    gitService.repositoryVisibility(projectId)
  )
  ipcMain.handle(
    'git:commits',
    (_event, projectId: string, offset?: number, limit?: number, tipHash?: string) =>
      gitService.commits(projectId, offset, limit, tipHash)
  )
  ipcMain.handle('git:branches', (_event, projectId: string) =>
    gitService.branches(projectId)
  )

  ipcMain.handle('terminals:start', (_event, input: StartTerminalInput) => terminals.start(input))
  ipcMain.handle('terminals:preview', (event, sessionId: string) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || typeof sessionId !== 'string') {
      throw new Error('Invalid terminal preview request.')
    }
    return terminals.preview(sessionId)
  })
  const readSubagents = async (event: Electron.IpcMainInvokeEvent, sessionId: string, summaryOnly: boolean) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Invalid sub-agent viewer sender.')
    }
    if (typeof sessionId !== 'string') throw new Error('Choose a Codex terminal.')
    const session = store.getSession(sessionId)
    if (!session || session.archived || session.profile !== 'codex' ||
      (session.kind !== 'terminal' && (session.kind !== 'latex-chat' || session.latexChat?.purpose !== 'writing'))) {
      throw new Error('Choose an active Codex terminal or writing chat.')
    }
    const project = store.getProjectForRuntime(session.projectId)
    if (!project || project.archived) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    if (!session.providerSessionId) throw new Error('This terminal has no linked Codex thread yet. Wait for it to connect, then try again.')
    return codexSubagents[summaryOnly ? 'summary' : 'read'](session.providerSessionId, project.folder,
      connection.kind === 'ssh' ? connection.sshAlias ?? connection.name : undefined)
  }
  ipcMain.handle('terminals:subagents', (event, sessionId: string) => readSubagents(event, sessionId, false))
  ipcMain.handle('terminals:subagent-summary', (event, sessionId: string) => readSubagents(event, sessionId, true))
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
  ipcMain.handle('temporary-chats:start', (_event, projectId: string) =>
    terminals.startTemporaryCodexChat(projectId)
  )
  ipcMain.handle('temporary-chats:clear', (_event, sessionId: string) => {
    terminals.clearTemporaryCodexChat(sessionId)
  })
  ipcMain.handle(
    'temporary-chats:send-prompt',
    (_event, sessionId: string, prompt: string) => {
      terminals.sendTemporaryCodexChatPrompt(sessionId, prompt)
    }
  )
  ipcMain.handle('terminals:discover', (_event, connectionId?: string) =>
    terminals.reconcileSessions(connectionId)
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
  ipcMain.handle('latex:source-revision', (_event, projectId: string) =>
    latex.sourceRevision(projectId)
  )
  ipcMain.handle('latex:get-pdf', (_event, projectId: string) =>
    latex.getPdf(projectId)
  )
  ipcMain.handle('latex:compile', (_event, projectId: string) =>
    appUpdates.protectRestartWhile(() => latex.compile(projectId))
  )
  ipcMain.handle('latex:print-pdf', (_event, input: PrintLatexPdfInput) =>
    printLatexPdf(input)
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
    return latex.sendPrompt(sessionId, prompt)
  })
  ipcMain.handle(
    'latex:send-inline-edit',
    (_event, input: SendLatexInlineEditInput) => {
      return appUpdates.protectRestartWhile(() => latex.sendInlineEdit(input))
    }
  )
  ipcMain.handle('latex:list-inline-edits', (_event, projectId: string) =>
    latex.listInlineEdits(projectId)
  )
  ipcMain.handle('latex:rollback-inline-edit', (_event, editId: string) =>
    appUpdates.protectRestartWhile(() => latex.rollbackInlineEdit(editId))
  )
  ipcMain.handle('latex:delete-inline-edit', (_event, editId: string) => {
    latex.deleteInlineEdit(editId)
  })
  ipcMain.handle('latex:list-comments', (_event, projectId: string) =>
    latex.listComments(projectId)
  )
  ipcMain.handle(
    'latex:create-comment',
    (_event, input: CreateLatexCommentInput) => appUpdates.protectRestartWhile(() => latex.createComment(input))
  )
  ipcMain.handle(
    'latex:delete-comment',
    (_event, projectId: string, commentId: string) =>
      appUpdates.protectRestartWhile(() => latex.deleteComment(projectId, commentId))
  )
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
    (_event, sessionId: string) => {
      terminals.resumeAgent(sessionId)
    }
  )
  ipcMain.handle('terminals:force-reload-agent', (_event, sessionId: string) =>
    terminals.forceReloadAgent(sessionId)
  )
  ipcMain.handle('terminals:rename', (_event, sessionId: string, name: string) => {
    terminals.rename(sessionId, name)
  })
  ipcMain.handle(
    'terminals:transfer',
    (_event, sessionId: string, targetProjectId: string) =>
      terminals.transferSession(sessionId, targetProjectId)
  )
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
  ipcMain.handle('terminals:delete', (_event, sessionId: string) =>
    terminals.delete(sessionId)
  )

  ipcMain.handle('files:list', async (_event, projectId: string, relativePath = '.') => {
    const project = store.getProjectForRuntime(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return connection.kind === 'local'
      ? listLocalFiles(project.folder, relativePath)
      : listRemoteFilesAsync(connection.sshAlias!, project.folder, relativePath)
  })

  ipcMain.handle('files:search', async (_event, projectId: string, query: string) => {
    const project = store.getProjectForRuntime(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return connection.kind === 'local'
      ? searchLocalFiles(project.folder, query)
      : searchRemoteFiles(connection.sshAlias!, project.folder, query)
  })

  ipcMain.handle(
    'files:create-file',
    async (_event, projectId: string, parentPath: string, name: string) => {
      const project = store.getProjectForRuntime(projectId)
      if (!project) throw new Error('Project not found.')
      const connection = store.getConnection(project.connectionId)
      if (!connection) throw new Error('Project connection not found.')
      return connection.kind === 'local'
        ? createLocalFile(project.folder, parentPath, name)
        : createRemoteFile(
            connection.sshAlias!,
            project.folder,
            parentPath,
            name
          )
    }
  )
  ipcMain.handle(
    'files:create-directory',
    async (_event, projectId: string, parentPath: string, name: string) => {
      const project = store.getProjectForRuntime(projectId)
      if (!project) throw new Error('Project not found.')
      const connection = store.getConnection(project.connectionId)
      if (!connection) throw new Error('Project connection not found.')
      return connection.kind === 'local'
        ? createLocalDirectory(project.folder, parentPath, name)
        : createRemoteDirectory(
            connection.sshAlias!,
            project.folder,
            parentPath,
            name
          )
    }
  )
  ipcMain.handle(
    'files:rename',
    async (_event, projectId: string, relativePath: string, name: string) => {
      const project = store.getProjectForRuntime(projectId)
      if (!project) throw new Error('Project not found.')
      const connection = store.getConnection(project.connectionId)
      if (!connection) throw new Error('Project connection not found.')
      return connection.kind === 'local'
        ? renameLocalEntry(project.folder, relativePath, name)
        : renameRemoteEntry(
            connection.sshAlias!,
            project.folder,
            relativePath,
            name
          )
    }
  )

  ipcMain.handle('notes:list', (_event, projectId: string) =>
    metadata.listNotes(projectId)
  )
  ipcMain.handle('notes:create', (_event, projectId: string, name: string) =>
    appUpdates.protectRestartWhile(() => metadata.createNote(projectId, name))
  )
  ipcMain.handle('notes:read', (_event, projectId: string, path: string) =>
    metadata.readNote(projectId, path)
  )
  ipcMain.handle(
    'notes:write',
    (_event, projectId: string, path: string, content: string) =>
      appUpdates.protectRestartWhile(() => metadata.writeNote(projectId, path, content))
  )
  ipcMain.handle(
    'notes:rename',
    (_event, projectId: string, path: string, name: string) =>
      appUpdates.protectRestartWhile(() => metadata.renameNote(projectId, path, name))
  )
  ipcMain.handle('notes:delete', (_event, projectId: string, path: string) => {
    return appUpdates.protectRestartWhile(() => metadata.deleteNote(projectId, path))
  })
  ipcMain.handle('files:preview', async (_event, projectId: string, relativePath: string) => {
    const project = store.getProjectForRuntime(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return connection.kind === 'local'
      ? previewLocalFile(project.folder, relativePath)
      : previewRemoteFileAsync(connection.sshAlias!, project.folder, relativePath)
  })
  ipcMain.handle('files:open', async (_event, projectId: string, relativePath: string) => {
    const project = store.getProjectForRuntime(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return connection.kind === 'local'
      ? openLocalPath(project.folder, relativePath)
      : openRemotePath(connection.sshAlias!, project.folder, relativePath)
  })
  ipcMain.handle(
    'files:save',
    async (_event, projectId: string, relativePath: string, content: string) => appUpdates.protectRestartWhile(async () => {
      const project = store.getProjectForRuntime(projectId)
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
    })
  )
  ipcMain.handle(
    'files:download',
    async (_event, projectId: string, relativePath: string) => {
      const project = store.getProjectForRuntime(projectId)
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
  ipcMain.handle(
    'files:show-in-folder',
    (_event, projectId: string, relativePath: string) => {
      const project = store.getProjectForRuntime(projectId)
      if (!project) throw new Error('Project not found.')
      const connection = store.getConnection(project.connectionId)
      if (connection?.kind !== 'local') {
        throw new Error('Only files stored on this Mac can be shown in Finder.')
      }
      shell.showItemInFolder(resolveLocalFilePath(project.folder, relativePath))
    }
  )

  ipcMain.handle('google-drive:status', (_event, projectId: string) =>
    googleDrive.status(projectId)
  )
  ipcMain.handle('google-drive:list-remotes', () => googleDrive.listRemotes())
  ipcMain.handle(
    'google-drive:connect',
    (_event, input: ConnectGoogleDriveInput) =>
      googleDrive.connect(input.projectId, input.remoteName, input.folderPath)
  )
  ipcMain.handle('google-drive:disconnect', (_event, projectId: string) => {
    googleDrive.disconnect(projectId)
  })
  ipcMain.handle('google-drive:open-folder', (_event, projectId: string) =>
    googleDrive.openFolder(projectId)
  )
  ipcMain.handle(
    'google-drive:upload-file',
    (_event, projectId: string, relativePath: string) =>
      googleDrive.uploadFile(projectId, relativePath)
  )
  ipcMain.handle(
    'google-drive:create-public-link',
    (_event, projectId: string, relativePath: string) =>
      googleDrive.createPublicLink(projectId, relativePath)
  )
  ipcMain.handle(
    'google-drive:remove-public-link',
    (_event, projectId: string, relativePath: string) =>
      googleDrive.removePublicLink(projectId, relativePath)
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
  ipcMain.handle('system:read-text', () => clipboard.readText())
  ipcMain.handle('system:open-project-folder', async (_event, projectId: string) => {
    const project = store.getProjectForRuntime(projectId)
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

  ipcMain.handle('conversations:list', async (_event, projectId: string, query = '', hiddenCount = 0) => {
    const project = store.getProjectForRuntime(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return connection.kind === 'local'
      ? conversations.list(project.folder, query, hiddenCount)
      : remoteConversations.list(
          connection.sshAlias ?? connection.name,
          project.folder,
          query,
          hiddenCount
        )
  })
  ipcMain.handle(
    'conversations:get',
    async (_event, projectId: string, conversationId: string, query = '') => {
      const project = store.getProjectForRuntime(projectId)
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
      protocol.handle(HTML_PREVIEW_SCHEME, (request) => interactiveHtml.handle(request))
      store = new Store(app.getPath('userData'))
      const hostTerminalEvent = (channel: string, payload: unknown) => {
        if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, payload)
      }
      hostTerminals = new HostTerminalService(store, app.getPath('userData'), {
        changed: (sessions) => hostTerminalEvent('host-terminals:changed', sessions),
        data: (event) => hostTerminalEvent('host-terminals:data', event),
        transport: (event) => hostTerminalEvent('host-terminals:transport', event)
      })
      terminalDrops = new TerminalDropService(store, (progress) => {
        if (mainWindow && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('terminal-drops:progress', progress)
      })
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
      const restoredLocalSessions = terminals.prepareLocalSessionsAfterReboot()
      if (restoredLocalSessions > 0) {
        console.info(
          `Prepared ${restoredLocalSessions} local tmux session${restoredLocalSessions === 1 ? '' : 's'} for on-demand recovery after reboot.`
        )
      }
      latex = new LatexProjectService(store, terminals, metadata)
      googleDrive = new GoogleDriveService(store)
      gitService = new GitService(store)
      portForwards = new PortForwardManager(store, () => {
        mainWindow?.webContents.send('port-forward:changed')
      })
      registerIpc()
      createWindow()
      void appUpdates.initialize()
      setTimeout(() => {
        void terminals.removeLegacyProjectQnaSessions().catch((error) => {
          console.warn('Could not retire legacy Project Q&A sessions:', error)
        })
      }, 1_000)
      powerMonitor.on('resume', () => {
        terminals.reconnectAfterWake()
      })
      void terminals
        .reconcileSessions()
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
  appUpdates.dispose()
  terminalDrops?.shutdown()
  terminals?.shutdown()
  hostTerminals?.shutdown()
  portForwards?.shutdown()
  store?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
