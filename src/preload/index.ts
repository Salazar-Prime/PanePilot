import { contextBridge, ipcRenderer } from 'electron'
import type {
  CreatePortForwardInput,
  CreateProjectInput,
  CreateProjectActionInput,
  LatexChatMode,
  ProjectConsoleApi,
  StartLatexChatInput,
  StartTerminalInput,
  TerminalDataEvent,
  TerminalMetadataEvent,
  TerminalStateEvent,
  TerminalTransportEvent,
  UpdateLatexProjectInput,
  UpdateProjectActionInput
} from '../shared/types'

const api: ProjectConsoleApi = {
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    refresh: () => ipcRenderer.invoke('connections:refresh'),
    test: (connectionId: string) => ipcRenderer.invoke('connections:test', connectionId)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (input: CreateProjectInput) => ipcRenderer.invoke('projects:create', input),
    rename: (projectId: string, name: string) =>
      ipcRenderer.invoke('projects:rename', projectId, name),
    archive: (projectId: string) => ipcRenderer.invoke('projects:archive', projectId),
    restore: (projectId: string) => ipcRenderer.invoke('projects:restore', projectId),
    delete: (projectId: string) => ipcRenderer.invoke('projects:delete', projectId),
    updateRepository: (projectId: string, url: string | null) =>
      ipcRenderer.invoke('projects:update-repository', projectId, url),
    chooseFolder: () => ipcRenderer.invoke('projects:choose-folder'),
    openRepository: (url: string) => ipcRenderer.invoke('projects:open-repository', url)
  },
  terminals: {
    start: (input: StartTerminalInput) => ipcRenderer.invoke('terminals:start', input),
    discover: (connectionId?: string) =>
      ipcRenderer.invoke('terminals:discover', connectionId),
    attach: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminals:attach', sessionId, cols, rows),
    retryAttach: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminals:retry-attach', sessionId, cols, rows),
    write: (sessionId: string, data: string) =>
      ipcRenderer.invoke('terminals:write', sessionId, data),
    captureBuffer: (sessionId: string) =>
      ipcRenderer.invoke('terminals:capture-buffer', sessionId),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.invoke('terminals:resize', sessionId, cols, rows),
    acknowledge: (sessionId: string) => ipcRenderer.invoke('terminals:acknowledge', sessionId),
    resumeAgent: (sessionId: string, dangerousModeConfirmed = false) =>
      ipcRenderer.invoke(
        'terminals:resume-agent',
        sessionId,
        dangerousModeConfirmed
      ),
    rename: (sessionId: string, name: string) =>
      ipcRenderer.invoke('terminals:rename', sessionId, name),
    setPinned: (sessionId: string, pinned: boolean) =>
      ipcRenderer.invoke('terminals:set-pinned', sessionId, pinned),
    setFlagged: (sessionId: string, flagged: boolean) =>
      ipcRenderer.invoke('terminals:set-flagged', sessionId, flagged),
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
    },
    onMetadata: (listener: (event: TerminalMetadataEvent) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: TerminalMetadataEvent
      ): void => listener(payload)
      ipcRenderer.on('terminal:metadata', handler)
      return () => ipcRenderer.removeListener('terminal:metadata', handler)
    },
    onTransport: (listener: (event: TerminalTransportEvent) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: TerminalTransportEvent
      ): void => listener(payload)
      ipcRenderer.on('terminal:transport', handler)
      return () => ipcRenderer.removeListener('terminal:transport', handler)
    }
  },
  actions: {
    sync: (projectId: string) => ipcRenderer.invoke('actions:sync', projectId),
    create: (input: CreateProjectActionInput) =>
      ipcRenderer.invoke('actions:create', input),
    update: (input: UpdateProjectActionInput) =>
      ipcRenderer.invoke('actions:update', input),
    run: (actionId: string) => ipcRenderer.invoke('actions:run', actionId),
    stop: (actionId: string) => ipcRenderer.invoke('actions:stop', actionId),
    delete: (actionId: string) => ipcRenderer.invoke('actions:delete', actionId)
  },
  projectQna: {
    start: (projectId: string) => ipcRenderer.invoke('project-qna:start', projectId),
    reset: (projectId: string) => ipcRenderer.invoke('project-qna:reset', projectId),
    sendPrompt: (sessionId: string, prompt: string) =>
      ipcRenderer.invoke('project-qna:send-prompt', sessionId, prompt)
  },
  notes: {
    list: (projectId: string) => ipcRenderer.invoke('notes:list', projectId),
    create: (projectId: string, name: string) =>
      ipcRenderer.invoke('notes:create', projectId, name),
    read: (projectId: string, path: string) =>
      ipcRenderer.invoke('notes:read', projectId, path),
    write: (projectId: string, path: string, content: string) =>
      ipcRenderer.invoke('notes:write', projectId, path, content),
    rename: (projectId: string, path: string, name: string) =>
      ipcRenderer.invoke('notes:rename', projectId, path, name),
    delete: (projectId: string, path: string) =>
      ipcRenderer.invoke('notes:delete', projectId, path)
  },
  files: {
    list: (projectId: string, relativePath = '.') =>
      ipcRenderer.invoke('files:list', projectId, relativePath),
    search: (projectId: string, query: string) =>
      ipcRenderer.invoke('files:search', projectId, query),
    preview: (projectId: string, relativePath: string) =>
      ipcRenderer.invoke('files:preview', projectId, relativePath),
    open: (projectId: string, relativePath: string) =>
      ipcRenderer.invoke('files:open', projectId, relativePath),
    save: (projectId: string, relativePath: string, content: string) =>
      ipcRenderer.invoke('files:save', projectId, relativePath, content),
    download: (projectId: string, relativePath: string) =>
      ipcRenderer.invoke('files:download', projectId, relativePath)
  },
  remoteFolders: {
    list: (connectionId: string, path?: string) =>
      ipcRenderer.invoke('remote-folders:list', connectionId, path)
  },
  conversations: {
    list: (projectId: string, query = '') =>
      ipcRenderer.invoke('conversations:list', projectId, query),
    get: (projectId: string, conversationId: string, query = '') =>
      ipcRenderer.invoke('conversations:get', projectId, conversationId, query)
  },
  latex: {
    getWorkspace: (projectId: string) =>
      ipcRenderer.invoke('latex:get-workspace', projectId),
    update: (input: UpdateLatexProjectInput) => ipcRenderer.invoke('latex:update', input),
    startChat: (input: StartLatexChatInput) =>
      ipcRenderer.invoke('latex:start-chat', input),
    setChatMode: (sessionId: string, mode: LatexChatMode) =>
      ipcRenderer.invoke('latex:set-chat-mode', sessionId, mode),
    sendPrompt: (sessionId: string, prompt: string) =>
      ipcRenderer.invoke('latex:send-prompt', sessionId, prompt),
    changes: (sessionId: string) => ipcRenderer.invoke('latex:changes', sessionId),
    clearChanges: (sessionId: string) =>
      ipcRenderer.invoke('latex:clear-changes', sessionId)
  },
  portForwards: {
    list: (connectionId: string) => ipcRenderer.invoke('port-forwards:list', connectionId),
    create: (input: CreatePortForwardInput) =>
      ipcRenderer.invoke('port-forwards:create', input),
    start: (portForwardId: string) =>
      ipcRenderer.invoke('port-forwards:start', portForwardId),
    stop: (portForwardId: string) =>
      ipcRenderer.invoke('port-forwards:stop', portForwardId),
    delete: (portForwardId: string) =>
      ipcRenderer.invoke('port-forwards:delete', portForwardId),
    onChanged: (listener: () => void) => {
      const handler = (): void => listener()
      ipcRenderer.on('port-forward:changed', handler)
      return () => ipcRenderer.removeListener('port-forward:changed', handler)
    }
  },
  system: {
    copyText: (text: string) => ipcRenderer.invoke('system:copy-text', text),
    readText: () => ipcRenderer.invoke('system:read-text'),
    openProjectFolder: (projectId: string) =>
      ipcRenderer.invoke('system:open-project-folder', projectId),
    openExternal: (url: string) => ipcRenderer.invoke('system:open-external', url)
  }
}

contextBridge.exposeInMainWorld('projectConsole', api)
