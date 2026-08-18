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
  | 'temporary-chat'
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
  flagged: boolean
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
  icon: string | null
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

export type GitChangeKind =
  | 'added'
  | 'copied'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'type-changed'
  | 'unmerged'

export interface GitFileChange {
  path: string
  previousPath: string | null
  staged: GitChangeKind | null
  workingTree: GitChangeKind | null
  untracked: boolean
  conflicted: boolean
}

export interface GitRepositoryStatus {
  isRepository: boolean
  root: string | null
  originUrl: string | null
  branch: string | null
  detached: boolean
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  stashCount: number
  clean: boolean
  changes: GitFileChange[]
  message: string | null
  refreshedAt: string
}

export type GitHubRepositoryVisibility = 'public' | 'private' | 'internal'

export interface GitHubRepositoryVisibilityStatus {
  repository: string | null
  visibility: GitHubRepositoryVisibility | null
  source: 'gh' | 'public-api' | null
  message: string | null
  checkedAt: string
}

export interface GitCommit {
  hash: string
  shortHash: string
  parents: string[]
  decorations: string[]
  author: string
  authoredAt: string
  subject: string
  graph: string
}

export interface GitCommitPage {
  commits: GitCommit[]
  offset: number
  total: number
  hasMore: boolean
}

export interface CreateProjectBaseInput {
  name: string
  connectionId: string
  folder: string
  newFolderName?: string
  repositoryUrl?: string
}

export type ProjectFolderSelectionPurpose = 'project' | 'parent'

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
  codexThreadId?: string
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

export interface LatexPdfDocument {
  path: string
  size: number
  modifiedAt: string
  dataBase64: string
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
  imageMimeType: string | null
  imageDataUrl: string | null
}

export interface FileOpenResult {
  kind: 'file' | 'directory'
  path: string
  directoryPath: string
  entries: FileEntry[]
  preview: FilePreview | null
}

export interface ProjectNoteSummary {
  path: string
  name: string
  updatedAt: string
}

export interface ProjectNote extends ProjectNoteSummary {
  content: string
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

export type SpeechReadingMode = 'concise' | 'verbatim'

export interface SpeechSettings {
  provider: 'google-neural2'
  voiceName: string
  languageCode: string
  speakingRate: number
  pitch: number
  monthlyCharacterLimit: number
}

export interface UpdateSpeechSettingsInput {
  voiceName: string
  speakingRate: number
  pitch: number
  monthlyCharacterLimit: number
}

export interface SpeechUsage {
  month: string
  usedCharacters: number
  remainingCharacters: number
  monthlyCharacterLimit: number
}

export interface SpeechStatus {
  settings: SpeechSettings
  usage: SpeechUsage
}

export interface SpeechConnectionTestResult {
  ok: boolean
  message: string
  projectId: string | null
  voices: string[]
}

export interface SynthesizeSpeechInput {
  text: string
  mode: SpeechReadingMode
}

export interface SynthesizeSpeechResult {
  audioDataUrls: string[]
  spokenText: string
  characters: number
  usage: SpeechUsage
}

export interface GoogleDriveStatus {
  available: boolean
  connected: boolean
  remoteName: string | null
  folderPath: string | null
  destination: string | null
  folderId: string | null
  folderUrl: string | null
  connectedAt: string | null
}

export interface ConnectGoogleDriveInput {
  projectId: string
  remoteName: string
  folderPath: string
}

export interface GoogleDriveUploadResult {
  fileId: string
  name: string
  webViewLink: string
  destination: string
  updated: boolean
}

export interface GoogleDrivePublicLinkResult {
  url: string
  destination: string
}

export interface ProjectConsoleApi {
  connections: {
    list(): Promise<Connection[]>
    refresh(): Promise<Connection[]>
    test(connectionId: string): Promise<ConnectionTestResult>
  }
  projects: {
    list(): Promise<Project[]>
    create(input: CreateProjectInput): Promise<Project>
    rename(projectId: string, name: string): Promise<void>
    setIcon(projectId: string, icon: string | null): Promise<void>
    archive(projectId: string): Promise<void>
    restore(projectId: string): Promise<void>
    delete(projectId: string): Promise<void>
    updateRepository(projectId: string, url: string | null): Promise<void>
    chooseFolder(purpose?: ProjectFolderSelectionPurpose): Promise<string | null>
    openRepository(url: string): Promise<void>
  }
  git: {
    status(projectId: string): Promise<GitRepositoryStatus>
    repositoryVisibility(projectId: string): Promise<GitHubRepositoryVisibilityStatus>
    commits(projectId: string, offset?: number, limit?: number): Promise<GitCommitPage>
  }
  terminals: {
    start(input: StartTerminalInput): Promise<TerminalSession>
    discover(connectionId?: string): Promise<number>
    attach(sessionId: string, cols: number, rows: number): Promise<{ output: string }>
    retryAttach(sessionId: string, cols: number, rows: number): Promise<void>
    write(sessionId: string, data: string): Promise<void>
    captureBuffer(sessionId: string): Promise<string>
    resize(sessionId: string, cols: number, rows: number): Promise<void>
    acknowledge(sessionId: string): Promise<void>
    resumeAgent(sessionId: string): Promise<void>
    forceReloadAgent(sessionId: string): Promise<void>
    rename(sessionId: string, name: string): Promise<void>
    transfer(sessionId: string, targetProjectId: string): Promise<TerminalSession>
    setPinned(sessionId: string, pinned: boolean): Promise<void>
    setFlagged(sessionId: string, flagged: boolean): Promise<void>
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
    sync(projectId: string): Promise<ProjectAction[]>
    create(input: CreateProjectActionInput): Promise<ProjectAction>
    update(input: UpdateProjectActionInput): Promise<ProjectAction>
    run(actionId: string): Promise<TerminalSession>
    stop(actionId: string): Promise<void>
    delete(actionId: string): Promise<void>
  }
  projectQna: {
    start(projectId: string): Promise<TerminalSession>
    reset(projectId: string): Promise<void>
    sendPrompt(sessionId: string, prompt: string): Promise<void>
  }
  temporaryChats: {
    start(projectId: string): Promise<TerminalSession>
    clear(sessionId: string): Promise<void>
    sendPrompt(sessionId: string, prompt: string): Promise<void>
  }
  notes: {
    list(projectId: string): Promise<ProjectNoteSummary[]>
    create(projectId: string, name: string): Promise<ProjectNote>
    read(projectId: string, path: string): Promise<ProjectNote>
    write(projectId: string, path: string, content: string): Promise<ProjectNote>
    rename(projectId: string, path: string, name: string): Promise<ProjectNote>
    delete(projectId: string, path: string): Promise<void>
  }
  files: {
    list(projectId: string, relativePath?: string): Promise<FileEntry[]>
    search(projectId: string, query: string): Promise<FileEntry[]>
    createFile(projectId: string, parentPath: string, name: string): Promise<string>
    createDirectory(
      projectId: string,
      parentPath: string,
      name: string
    ): Promise<string>
    rename(projectId: string, relativePath: string, name: string): Promise<string>
    preview(projectId: string, relativePath: string): Promise<FilePreview>
    open(projectId: string, relativePath: string): Promise<FileOpenResult>
    save(projectId: string, relativePath: string, content: string): Promise<void>
    download(projectId: string, relativePath: string): Promise<boolean>
    showInFolder(projectId: string, relativePath: string): Promise<void>
  }
  googleDrive: {
    status(projectId: string): Promise<GoogleDriveStatus>
    listRemotes(): Promise<string[]>
    connect(input: ConnectGoogleDriveInput): Promise<GoogleDriveStatus>
    disconnect(projectId: string): Promise<void>
    openFolder(projectId: string): Promise<void>
    uploadFile(
      projectId: string,
      relativePath: string
    ): Promise<GoogleDriveUploadResult>
    createPublicLink(
      projectId: string,
      relativePath: string
    ): Promise<GoogleDrivePublicLinkResult>
    removePublicLink(projectId: string, relativePath: string): Promise<void>
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
    getPdf(projectId: string): Promise<LatexPdfDocument>
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
  speech: {
    status(): Promise<SpeechStatus>
    updateSettings(input: UpdateSpeechSettingsInput): Promise<SpeechStatus>
    testConnection(): Promise<SpeechConnectionTestResult>
    synthesize(input: SynthesizeSpeechInput): Promise<SynthesizeSpeechResult>
  }
  system: {
    copyText(text: string): Promise<void>
    readText(): Promise<string>
    openProjectFolder(projectId: string): Promise<void>
    printCurrentWindow(pageCount: number): Promise<void>
    openExternal(url: string): Promise<void>
    setZoomFactor(factor: number): void
  }
}
