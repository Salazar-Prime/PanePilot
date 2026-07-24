import { contextBridge, ipcRenderer } from 'electron'
import type {
  CreateProjectInput,
  ProjectConsoleApi,
  StartTerminalInput,
  TerminalDataEvent,
  TerminalStateEvent
} from '../shared/types'

const api: ProjectConsoleApi = {
  connections: {
    list: () => ipcRenderer.invoke('connections:list')
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (input: CreateProjectInput) => ipcRenderer.invoke('projects:create', input),
    chooseFolder: () => ipcRenderer.invoke('projects:choose-folder'),
    openRepository: (url: string) => ipcRenderer.invoke('projects:open-repository', url)
  },
  terminals: {
    start: (input: StartTerminalInput) => ipcRenderer.invoke('terminals:start', input),
    attach: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminals:attach', sessionId, cols, rows),
    write: (sessionId: string, data: string) =>
      ipcRenderer.invoke('terminals:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminals:resize', sessionId, cols, rows),
    acknowledge: (sessionId: string) => ipcRenderer.invoke('terminals:acknowledge', sessionId),
    rename: (sessionId: string, name: string) =>
      ipcRenderer.invoke('terminals:rename', sessionId, name),
    stop: (sessionId: string) => ipcRenderer.invoke('terminals:stop', sessionId),
    archive: (sessionId: string) => ipcRenderer.invoke('terminals:archive', sessionId),
    restore: (sessionId: string) => ipcRenderer.invoke('terminals:restore', sessionId),
    delete: (sessionId: string) => ipcRenderer.invoke('terminals:delete', sessionId),
    onData: (listener: (event: TerminalDataEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void =>
        listener(payload)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.removeListener('terminal:data', handler)
    },
    onState: (listener: (event: TerminalStateEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: TerminalStateEvent): void =>
        listener(payload)
      ipcRenderer.on('terminal:state', handler)
      return () => ipcRenderer.removeListener('terminal:state', handler)
    }
  },
  files: {
    list: (projectId: string, relativePath = '.') =>
      ipcRenderer.invoke('files:list', projectId, relativePath),
    preview: (projectId: string, relativePath: string) =>
      ipcRenderer.invoke('files:preview', projectId, relativePath)
  }
}

contextBridge.exposeInMainWorld('projectConsole', api)
