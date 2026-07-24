import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { CreateProjectInput, StartTerminalInput } from '../shared/types'
import { listLocalFiles, previewLocalFile } from './file-service'
import { discoverRepository } from './git'
import { projectTypeServices } from './project-type-services'
import { discoverSshAliases } from './ssh-config'
import { Store } from './store'
import { TerminalManager } from './terminal-manager'

let mainWindow: BrowserWindow | null = null
let store: Store
let terminals: TerminalManager

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
  ipcMain.handle('terminals:rename', (_event, sessionId: string, name: string) => {
    terminals.rename(sessionId, name)
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
    if (connection?.kind !== 'local') {
      throw new Error('Remote file browsing is not available in this first build.')
    }
    return listLocalFiles(project.folder, relativePath)
  })
  ipcMain.handle('files:preview', (_event, projectId: string, relativePath: string) => {
    const project = store.getProject(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = store.getConnection(project.connectionId)
    if (connection?.kind !== 'local') {
      throw new Error('Remote file previews are not available in this first build.')
    }
    return previewLocalFile(project.folder, relativePath)
  })
}

app
  .whenReady()
  .then(() => {
    store = new Store(app.getPath('userData'))
    store.syncConnections(discoverSshAliases())
    terminals = new TerminalManager(store, () => mainWindow)
    registerIpc()
    createWindow()

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
  store?.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
