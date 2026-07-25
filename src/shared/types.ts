export type ProjectType = 'terminal' | 'latex'
export type ConnectionKind = 'local' | 'ssh'
export type LaunchProfile = 'shell' | 'codex' | 'claude' | 'custom'
export type TerminalBackend = 'tmux' | 'pty'
export type TerminalTransportState =
  | 'attached'
  | 'reconnecting'
  | 'offline'
  | 'detached'
export type TerminalSessionKind =
  | 'terminal'
  | 'action'
  | 'project-qna'
  | 'latex-chat'
export type LatexChatMode = 'ask' | 'edit'
export type LatexChatScope = 'project' | 'section'
export type AgentState =
  | 'idle'
  | 'running'
  | 'needs-input'
  | 'response-ready'
  | 'needs-attention'
  | 'completed'
  | 'error'

export interface Connection {
  id: string
  kind: ConnectionKind
  name: string
  sshAlias: string | null
}

export interface TerminalSession {
  id: string
  projectId: string
  kind: TerminalSessionKind
  name: string
  profile: LaunchProfile
  providerSessionId: string | null
  providerSessionName: string | null
  customCommand: string | null
  backend: TerminalBackend
  tmuxName: string | null
  state: AgentState
  dangerousMode: boolean
  archived: boolean
  pinned: boolean
  output: string
  latexChat: LatexChatAttachment | null
  createdAt: string
  updatedAt: string
}

export interface ProjectAction {
  id: string
  projectId: string
  name: string
  command: string
  lastSessionId: string | null
  createdAt: string
  updatedAt: string
}

export interface Activity {
  id: string
  projectId: string
  sessionId: string | null
  kind: string
  message: string
  createdAt: string
}

export interface Project {
  id: string
  type: ProjectType
  name: string
  connectionId: string
  folder: string
  repositoryUrl: string | null
  latex: LatexProjectDetails | null
  state: AgentState
  archived: boolean
  createdAt: string
  updatedAt: string
  sessions: TerminalSession[]
  actions: ProjectAction[]
  activities: Activity[]
}

export interface CreateProjectBaseInput {
  name: string
  connectionId: string
  folder: string
  repositoryUrl?: string
}

export type CreateProjectInput =
  | (CreateProjectBaseInput & {
      type: 'terminal'
    })
  | (CreateProjectBaseInput & {
      type: 'latex'
      latex: {
        mainFile?: string
        overleafUrl?: string
        contextFolder?: string
      }
    })

export interface StartTerminalInput {
  projectId: string
  name?: string
  profile: LaunchProfile
  customCommand?: string
  dangerousMode: boolean
  cols?: number
  rows?: number
}

export interface CreateProjectActionInput {
  projectId: string
  name: string
  command: string
}

export interface UpdateProjectActionInput {
  actionId: string
  name: string
  command: string
}

export interface LatexProjectDetails {
  projectId: string
  mainFile: string
  overleafUrl: string | null
  contextFolder: string
}

export interface LatexSection {
  id: string
  projectId: string
  title: string
  level: number
  sourceFile: string
  startLine: number
  endLine: number
  ordinal: number
}

export interface LatexChatAttachment {
  terminalSessionId: string
  projectId: string
  scope: LatexChatScope
  sectionId: string | null
  mode: LatexChatMode
  createdAt: string
}

export interface LatexWorkspace {
  details: LatexProjectDetails
  sections: LatexSection[]
  contextAvailable: boolean
}

export interface StartLatexChatInput {
  projectId: string
  name?: string
  provider: ConversationProvider
  scope: LatexChatScope
  sectionId?: string
  mode: LatexChatMode
  dangerousMode: boolean
}

export interface UpdateLatexProjectInput {
  projectId: string
  mainFile: string
  overleafUrl?: string
  contextFolder: string
}

export type LatexChangeKind = 'added' | 'modified' | 'deleted'

export interface LatexChangeHighlight {
  kind: LatexChangeKind
  startLine: number
  endLine: number
  startColumn: number
  endColumn: number
  originalText: string
  currentText: string
}

export interface LatexFileChanges {
  path: string
  additions: number
  modifications: number
  deletions: number
  highlights: LatexChangeHighlight[]
}

export interface LatexChangeSet {
  sessionId: string
  capturedAt: string | null
  files: LatexFileChanges[]
}

export interface TerminalDataEvent {
  sessionId: string
  data: string
}

export interface TerminalStateEvent {
  sessionId: string
  projectId: string
  state: AgentState
}

export interface TerminalMetadataEvent {
  sessionId: string
  projectId: string
}

export interface TerminalTransportEvent {
  sessionId: string
  state: TerminalTransportState
  attempt: number
  message: string | null
}

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  size: number | null
}

export interface FilePreview {
  path: string
  content: string
  truncated: boolean
  binary: boolean
}

export type ConversationProvider = 'codex' | 'claude'

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string | null
}

export interface ConversationSummary {
  id: string
  provider: ConversationProvider
  providerSessionId: string | null
  title: string
  workingDirectory: string
  updatedAt: string
  messageCount: number
  snippet: string
  matchCount: number
}

export interface ConversationDetail extends ConversationSummary {
  messages: ConversationMessage[]
}

export interface RemoteFolderListing {
  currentPath: string
  parentPath: string | null
  entries: FileEntry[]
}

export interface ConnectionTestResult {
  ok: boolean
  message: string
  latencyMs: number
}

export type PortForwardState = 'starting' | 'running' | 'stopped' | 'error'

export interface PortForward {
  id: string
  connectionId: string
  name: string
  bindAddress: '127.0.0.1'
  localPort: number
  remoteHost: string
  remotePort: number
  state: PortForwardState
  error: string | null
  createdAt: string
}

export interface CreatePortForwardInput {
  connectionId: string
  name: string
  localPort: number
  remoteHost: string
  remotePort: number
}

export interface ProjectConsoleApi {
  connections: {
    list(): Promise<Connection[]>
    test(connectionId: string): Promise<ConnectionTestResult>
  }
  projects: {
    list(): Promise<Project[]>
    create(input: CreateProjectInput): Promise<Project>
    rename(projectId: string, name: string): Promise<void>
    archive(projectId: string): Promise<void>
    restore(projectId: string): Promise<void>
    updateRepository(projectId: string, url: string | null): Promise<void>
    chooseFolder(): Promise<string | null>
    openRepository(url: string): Promise<void>
  }
  terminals: {
    start(input: StartTerminalInput): Promise<TerminalSession>
    discover(connectionId?: string): Promise<number>
    attach(sessionId: string, cols: number, rows: number): Promise<{ output: string }>
    retryAttach(sessionId: string, cols: number, rows: number): Promise<void>
    write(sessionId: string, data: string): Promise<void>
    resize(sessionId: string, cols: number, rows: number): Promise<void>
    acknowledge(sessionId: string): Promise<void>
    resumeAgent(sessionId: string, dangerousModeConfirmed?: boolean): Promise<void>
    rename(sessionId: string, name: string): Promise<void>
    setPinned(sessionId: string, pinned: boolean): Promise<void>
    stop(sessionId: string): Promise<void>
    archive(sessionId: string): Promise<void>
    restore(sessionId: string): Promise<void>
    delete(sessionId: string): Promise<void>
    onData(listener: (event: TerminalDataEvent) => void): () => void
    onState(listener: (event: TerminalStateEvent) => void): () => void
    onMetadata(listener: (event: TerminalMetadataEvent) => void): () => void
    onTransport(listener: (event: TerminalTransportEvent) => void): () => void
  }
  actions: {
    create(input: CreateProjectActionInput): Promise<ProjectAction>
    update(input: UpdateProjectActionInput): Promise<ProjectAction>
    run(actionId: string): Promise<TerminalSession>
    stop(actionId: string): Promise<void>
    delete(actionId: string): Promise<void>
  }
  projectQna: {
    start(projectId: string): Promise<TerminalSession>
    sendPrompt(sessionId: string, prompt: string): Promise<void>
  }
  files: {
    list(projectId: string, relativePath?: string): Promise<FileEntry[]>
    preview(projectId: string, relativePath: string): Promise<FilePreview>
    save(projectId: string, relativePath: string, content: string): Promise<void>
    download(projectId: string, relativePath: string): Promise<boolean>
  }
  remoteFolders: {
    list(connectionId: string, path?: string): Promise<RemoteFolderListing>
  }
  conversations: {
    list(projectId: string, query?: string): Promise<ConversationSummary[]>
    get(projectId: string, conversationId: string, query?: string): Promise<ConversationDetail>
  }
  latex: {
    getWorkspace(projectId: string): Promise<LatexWorkspace>
    update(input: UpdateLatexProjectInput): Promise<LatexWorkspace>
    startChat(input: StartLatexChatInput): Promise<TerminalSession>
    setChatMode(sessionId: string, mode: LatexChatMode): Promise<void>
    sendPrompt(sessionId: string, prompt: string): Promise<void>
    changes(sessionId: string): Promise<LatexChangeSet>
    clearChanges(sessionId: string): Promise<void>
  }
  portForwards: {
    list(connectionId: string): Promise<PortForward[]>
    create(input: CreatePortForwardInput): Promise<PortForward>
    start(portForwardId: string): Promise<void>
    stop(portForwardId: string): Promise<void>
    delete(portForwardId: string): Promise<void>
    onChanged(listener: () => void): () => void
  }
  system: {
    copyText(text: string): Promise<void>
    openProjectFolder(projectId: string): Promise<void>
    openExternal(url: string): Promise<void>
  }
}
