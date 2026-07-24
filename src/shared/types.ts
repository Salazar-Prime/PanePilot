export type ProjectType = 'terminal'
export type ConnectionKind = 'local' | 'ssh'
export type LaunchProfile = 'shell' | 'codex' | 'claude' | 'custom'
export type TerminalBackend = 'tmux' | 'pty'
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
  name: string
  profile: LaunchProfile
  customCommand: string | null
  backend: TerminalBackend
  tmuxName: string | null
  state: AgentState
  dangerousMode: boolean
  archived: boolean
  output: string
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
  state: AgentState
  createdAt: string
  updatedAt: string
  sessions: TerminalSession[]
  activities: Activity[]
}

export interface CreateProjectInput {
  name: string
  connectionId: string
  folder: string
}

export interface StartTerminalInput {
  projectId: string
  name?: string
  profile: LaunchProfile
  customCommand?: string
  dangerousMode: boolean
  cols?: number
  rows?: number
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

export interface ProjectConsoleApi {
  connections: {
    list(): Promise<Connection[]>
  }
  projects: {
    list(): Promise<Project[]>
    create(input: CreateProjectInput): Promise<Project>
    rename(projectId: string, name: string): Promise<void>
    chooseFolder(): Promise<string | null>
    openRepository(url: string): Promise<void>
  }
  terminals: {
    start(input: StartTerminalInput): Promise<TerminalSession>
    attach(sessionId: string, cols: number, rows: number): Promise<{ output: string }>
    write(sessionId: string, data: string): Promise<void>
    resize(sessionId: string, cols: number, rows: number): Promise<void>
    acknowledge(sessionId: string): Promise<void>
    rename(sessionId: string, name: string): Promise<void>
    stop(sessionId: string): Promise<void>
    archive(sessionId: string): Promise<void>
    restore(sessionId: string): Promise<void>
    delete(sessionId: string): Promise<void>
    onData(listener: (event: TerminalDataEvent) => void): () => void
    onState(listener: (event: TerminalStateEvent) => void): () => void
  }
  files: {
    list(projectId: string, relativePath?: string): Promise<FileEntry[]>
    preview(projectId: string, relativePath: string): Promise<FilePreview>
    save(projectId: string, relativePath: string, content: string): Promise<void>
  }
  remoteFolders: {
    list(connectionId: string, path?: string): Promise<RemoteFolderListing>
  }
  conversations: {
    list(projectId: string, query?: string): Promise<ConversationSummary[]>
    get(projectId: string, conversationId: string, query?: string): Promise<ConversationDetail>
  }
}
