import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Cloud,
  Columns2,
  ExternalLink,
  FileText,
  Flag,
  FolderOpen,
  GitBranch,
  Github,
  Laptop,
  Menu,
  MessageSquarePlus,
  MessageSquareText,
  Network,
  PanelLeft,
  PanelLeftClose,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Server,
  Settings,
  ShieldAlert,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  Wifi,
  X
} from 'lucide-react'
import type {
  Connection,
  CreateProjectInput,
  GitRepositoryStatus,
  Project,
  ProjectType,
  TerminalSession,
  TerminalTransportState
} from '@shared/types'
import { isAttentionState } from '../lib/status'
import {
  nextAppearanceScale,
  useAppearanceScale
} from '../lib/appearanceScale'
import { useOpenSessions } from '../lib/openSessions'
import { isPaneSwapShortcut } from '../lib/projectShortcuts'
import {
  projectSortFor,
  projectSortOptions,
  sortProjects,
  useProjectSorts
} from '../lib/projectSort'
import { useProjectAttentionOrder } from '../lib/projectAttentionOrder'
import { useCollapsedProjects } from '../lib/sidebarCollapse'
import { useSelectionRecency } from '../lib/selectionRecency'
import { sortSessions, useSessionSort } from '../lib/sessionSort'
import { shouldOfferTmuxReconnect } from '../lib/terminalTransport'
import { tmuxAttachCommand, tmuxOptionsCommand } from '../lib/tmuxCommands'
import {
  consumeWorkspaceRequest,
  workspaceRequestIdFor,
  type WorkspacePane,
  type WorkspaceRequest
} from '../lib/workspaceRequest'
import { projectTypeRegistry } from '../projectTypeRegistry'
import { ArchivedProjectsPage } from './ArchivedProjectsPage'
import { AppearanceControl } from './AppearanceControl'
import {
  CommandPalette,
  type CommandPaletteCommand
} from './CommandPalette'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { GoogleDriveControl } from './GoogleDriveControl'
import { GitPane } from './GitPane'
import { NewProjectDialog } from './NewProjectDialog'
import { PortForwardDialog } from './PortForwardDialog'
import { ProjectIconMenu } from './ProjectIconMenu'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { RenameDialog } from './RenameDialog'
import { SortMenu } from './SortMenu'
import { SpeechControl } from './SpeechControl'
import { StatusDot } from './StatusDot'
import { TerminalProfileIcon } from './TerminalProfileIcon'
import { TemporaryChatsPanel } from './TemporaryChatsPanel'

type SidebarContext =
  | { kind: 'connection'; connection: Connection; x: number; y: number }
  | { kind: 'project'; project: Project; x: number; y: number }
  | {
      kind: 'session'
      project: Project
      session: TerminalSession
      x: number
      y: number
    }

type RenameTarget =
  | { kind: 'project'; project: Project }
  | { kind: 'session'; session: TerminalSession }

function isSidebarSession(session: TerminalSession): boolean {
  return session.kind === 'terminal' || session.kind === 'latex-chat'
}

export function App() {
  const [appearanceScale, setAppearanceScale] = useAppearanceScale()
  const [connections, setConnections] = useState<Connection[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [terminalTransportStates, setTerminalTransportStates] = useState<
    Record<string, TerminalTransportState>
  >({})
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [splitOpen, setSplitOpen] = useState(false)
  const [focusedPane, setFocusedPane] = useState<'a' | 'b'>('a')
  const [paneBProjectId, setPaneBProjectId] = useState<string | null>(null)
  const [paneBSessionId, setPaneBSessionId] = useState<string | null>(null)
  const [openSessionIds, openSession, closeSession] = useOpenSessions()
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjectConnectionId, setNewProjectConnectionId] = useState<string>()
  const [newProjectType, setNewProjectType] = useState<ProjectType>('terminal')
  const [showTypeMenu, setShowTypeMenu] = useState(false)
  const [showProjectSettings, setShowProjectSettings] = useState(false)
  const [gitPaneOpen, setGitPaneOpen] = useState(false)
  const [gitStatus, setGitStatus] = useState<GitRepositoryStatus | null>(null)
  const [gitStatusLoading, setGitStatusLoading] = useState(false)
  const [gitStatusError, setGitStatusError] = useState('')
  const gitStatusRequest = useRef(0)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [temporaryChatPanel, setTemporaryChatPanel] = useState<{
    projectId: string
    createRequest: number | null
  } | null>(null)
  const temporaryChatRequestSequence = useRef(0)
  const [driveDialogRequest, setDriveDialogRequest] = useState<{
    projectId: string
    nonce: number
  } | null>(null)
  const [showArchivedProjects, setShowArchivedProjects] = useState(false)
  const [portForwardConnection, setPortForwardConnection] = useState<Connection | null>(null)
  const [launchTerminalRequest, setLaunchTerminalRequest] =
    useState<WorkspaceRequest | null>(null)
  const [openSessionRequest, setOpenSessionRequest] =
    useState<WorkspaceRequest | null>(null)
  const workspaceRequestSequence = useRef(0)
  const [sidebarContext, setSidebarContext] = useState<SidebarContext | null>(null)
  const [projectSortMenu, setProjectSortMenu] = useState<{
    connectionId: string
    x: number
    y: number
  } | null>(null)
  const [projectIconMenu, setProjectIconMenu] = useState<{
    project: Project
    x: number
    y: number
  } | null>(null)
  const [copiedPathProjectId, setCopiedPathProjectId] = useState<string | null>(
    null
  )
  const copiedPathTimer = useRef<number | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [sessionSort] = useSessionSort()
  const [projectSorts, setProjectSort] = useProjectSorts()
  const {
    recency: selectionRecency,
    recordProjectSelection,
    recordSessionSelection
  } = useSelectionRecency()
  const [collapsedProjectIds, toggleProjectCollapsed] = useCollapsedProjects()
  const [loading, setLoading] = useState(true)
  const [refreshingConnections, setRefreshingConnections] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const nextProjects = await window.projectConsole.projects.list()
    setProjects(nextProjects)
  }, [])

  const handleLaunchTerminalRequest = useCallback((requestId: number) => {
    setLaunchTerminalRequest((current) =>
      consumeWorkspaceRequest(current, requestId)
    )
  }, [])

  const handleOpenSessionRequest = useCallback((requestId: number) => {
    setOpenSessionRequest((current) =>
      consumeWorkspaceRequest(current, requestId)
    )
  }, [])

  function nextWorkspaceRequest(
    projectId: string,
    pane: WorkspacePane
  ): WorkspaceRequest {
    workspaceRequestSequence.current += 1
    return { id: workspaceRequestSequence.current, projectId, pane }
  }

  async function refreshSshConnections() {
    setRefreshingConnections(true)
    try {
      setConnections(await window.projectConsole.connections.refresh())
    } catch (caught) {
      showError(caught)
    } finally {
      setRefreshingConnections(false)
    }
  }

  useEffect(() => {
    let active = true
    void Promise.all([
      window.projectConsole.connections.list(),
      window.projectConsole.projects.list()
    ])
      .then(([nextConnections, nextProjects]) => {
        if (!active) return
        setConnections(nextConnections)
        setProjects(nextProjects)
        const firstActive = nextProjects.find((project) => !project.archived)
        setSelectedProjectId((current) => current ?? firstActive?.id ?? null)
      })
      .catch((caught) => setError(messageFor(caught)))
      .finally(() => setLoading(false))
    const removeStateListener = window.projectConsole.terminals.onState(() => {
      void refresh()
    })
    const removeMetadataListener = window.projectConsole.terminals.onMetadata(() => {
      void refresh()
    })
    const removeTransportListener = window.projectConsole.terminals.onTransport(
      (event) => {
        setTerminalTransportStates((current) => ({
          ...current,
          [event.sessionId]: event.state
        }))
      }
    )
    return () => {
      active = false
      removeStateListener()
      removeMetadataListener()
      removeTransportListener()
    }
  }, [refresh])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        ['+', '=', '-', '0'].includes(event.key)
      ) {
        event.preventDefault()
        if (event.key === '0') setAppearanceScale(1)
        else {
          setAppearanceScale(
            nextAppearanceScale(
              appearanceScale,
              event.key === '-' ? -1 : 1
            )
          )
        }
        return
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLocaleLowerCase() === 'k'
      ) {
        event.preventDefault()
        setShowCommandPalette((current) => !current)
        return
      }
      if (
        splitOpen &&
        !showArchivedProjects &&
        selectedProjectId != null &&
        paneBProjectId != null &&
        isPaneSwapShortcut(event) &&
        document.querySelector('[role="dialog"][aria-modal="true"]') == null
      ) {
        event.preventDefault()
        event.stopPropagation()
        swapPanes()
      }
    }
    window.addEventListener('keydown', handleShortcut, true)
    return () => window.removeEventListener('keydown', handleShortcut, true)
  }, [
    splitOpen,
    selectedProjectId,
    selectedSessionId,
    paneBProjectId,
    paneBSessionId,
    showArchivedProjects,
    appearanceScale
  ])

  const activeProjects = useMemo(
    () => projects.filter((project) => !project.archived),
    [projects]
  )
  const projectAttentionOrder = useProjectAttentionOrder(activeProjects)
  const archivedProjects = useMemo(
    () => projects.filter((project) => project.archived),
    [projects]
  )
  const temporaryChatProject = temporaryChatPanel
    ? activeProjects.find(
        (candidate) => candidate.id === temporaryChatPanel.projectId
      ) ?? null
    : null
  const paneAProject =
    !showArchivedProjects
      ? activeProjects.find((item) => item.id === selectedProjectId) ?? null
      : null
  const paneAConnection = connections.find(
    (item) => item.id === paneAProject?.connectionId
  )
  const paneBProject =
    !showArchivedProjects && splitOpen
      ? activeProjects.find((item) => item.id === paneBProjectId) ?? null
      : null
  const paneBConnection = connections.find(
    (item) => item.id === paneBProject?.connectionId
  )
  const project = focusedPane === 'b' && splitOpen ? paneBProject : paneAProject
  const projectSupportsGit = project
    ? projectTypeRegistry[project.type].capabilities.includes('git')
    : false
  const connection = focusedPane === 'b' && splitOpen ? paneBConnection : paneAConnection
  const projectPath = project
    ? connection?.kind === 'ssh'
      ? `${connection.name}:${project.folder}`
      : project.folder
    : ''
  // The session the focused pane is actually showing. Terminals only count once
  // their tab is open, otherwise a closed-but-still-selected terminal would keep
  // claiming the status bar.
  const focusedSessionId =
    focusedPane === 'b' && splitOpen ? paneBSessionId : selectedSessionId
  const focusedSession =
    project?.sessions.find(
      (session) =>
        session.id === focusedSessionId &&
        !session.archived &&
        (session.kind !== 'terminal' || openSessionIds.has(session.id))
    ) ?? null

  const refreshGitStatus = useCallback(async () => {
    const projectId = project?.id
    if (!projectId || showArchivedProjects || !projectSupportsGit) {
      gitStatusRequest.current += 1
      setGitStatus(null)
      setGitStatusError('')
      setGitStatusLoading(false)
      return
    }
    const request = ++gitStatusRequest.current
    setGitStatusLoading(true)
    try {
      const nextStatus = await window.projectConsole.git.status(projectId)
      if (request !== gitStatusRequest.current) return
      setGitStatus(nextStatus)
      setGitStatusError('')
    } catch (caught) {
      if (request !== gitStatusRequest.current) return
      setGitStatusError(messageFor(caught))
    } finally {
      if (request === gitStatusRequest.current) setGitStatusLoading(false)
    }
  }, [project?.id, projectSupportsGit, showArchivedProjects])

  useEffect(() => {
    gitStatusRequest.current += 1
    setGitStatus(null)
    setGitStatusError('')
    if (!project || showArchivedProjects || !projectSupportsGit) return
    void refreshGitStatus()
    const refreshOnFocus = () => void refreshGitStatus()
    const timer = window.setInterval(() => void refreshGitStatus(), 12_000)
    window.addEventListener('focus', refreshOnFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshOnFocus)
    }
  }, [project?.id, projectSupportsGit, refreshGitStatus, showArchivedProjects])

  useEffect(
    () => () => {
      if (copiedPathTimer.current != null) {
        window.clearTimeout(copiedPathTimer.current)
      }
    },
    []
  )

  useEffect(() => {
    if (!paneAConnection || paneAConnection.kind !== 'ssh') return
    let active = true
    const discover = async () => {
      try {
        await window.projectConsole.terminals.discover(paneAConnection.id)
        if (active) await refresh()
      } catch {
        // Remote discovery is supplemental. Offline hosts must not block the
        // locally cached project and terminal workspace.
      }
    }
    void discover()
    const timer = window.setInterval(() => void discover(), 15_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [paneAConnection?.id, paneAConnection?.kind, refresh])

  useEffect(() => {
    if (!paneBConnection || paneBConnection.kind !== 'ssh') return
    let active = true
    const discover = async () => {
      try {
        await window.projectConsole.terminals.discover(paneBConnection.id)
        if (active) await refresh()
      } catch {
        // Remote discovery is supplemental. Offline hosts must not block the
        // locally cached project and terminal workspace.
      }
    }
    void discover()
    const timer = window.setInterval(() => void discover(), 15_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [paneBConnection?.id, paneBConnection?.kind, refresh])

  useEffect(() => {
    if (showArchivedProjects) return
    if (!activeProjects.length) {
      setSelectedProjectId(null)
      setSelectedSessionId(null)
      return
    }
    const selected = activeProjects.find((item) => item.id === selectedProjectId)
    if (!selected) {
      const first = activeProjects[0]
      setSelectedProjectId(first.id)
      setSelectedSessionId(
        sortSessions(
          first.sessions.filter(
            (session) => !session.archived && isSidebarSession(session)
          ),
          sessionSort,
          selectionRecency.sessions
        )[0]?.id ?? null
      )
      return
    }
    const visible = sortSessions(
      selected.sessions.filter(
        (session) => !session.archived && isSidebarSession(session)
      ),
      sessionSort,
      selectionRecency.sessions
    )
    if (!visible.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(visible[0]?.id ?? null)
    }
  }, [
    activeProjects,
    selectedProjectId,
    selectedSessionId,
    sessionSort,
    selectionRecency.sessions,
    showArchivedProjects
  ])

  useEffect(() => {
    if (!paneBProjectId) return
    if (activeProjects.some((item) => item.id === paneBProjectId)) return
    setPaneBProjectId(null)
    setPaneBSessionId(null)
  }, [activeProjects, paneBProjectId])

  function applyPaneSelection(
    pane: 'a' | 'b',
    projectId: string | null,
    sessionId: string | null
  ) {
    if (pane === 'b') {
      setPaneBProjectId(projectId)
      setPaneBSessionId(sessionId)
    } else {
      setSelectedProjectId(projectId)
      setSelectedSessionId(sessionId)
    }
  }

  function focusPaneSelection(projectId: string | null, sessionId: string | null) {
    applyPaneSelection(
      splitOpen && focusedPane === 'b' ? 'b' : 'a',
      projectId,
      sessionId
    )
  }

  function defaultSessionIdFor(target: Project | undefined): string | null {
    if (!target) return null
    return (
      sortSessions(
        target.sessions.filter(
          (session) => !session.archived && isSidebarSession(session)
        ),
        sessionSort,
        selectionRecency.sessions
      )[0]?.id ?? null
    )
  }

  function openProjectInPane(id: string, pane: 'a' | 'b') {
    recordProjectSelection(id)
    setShowArchivedProjects(false)
    if (pane === 'b') setSplitOpen(true)
    setFocusedPane(pane)
    const defaultSessionId = defaultSessionIdFor(
      activeProjects.find((item) => item.id === id)
    )
    applyPaneSelection(pane, id, defaultSessionId)
    if (defaultSessionId) openSession(defaultSessionId)
  }

  function swapPanes() {
    if (!splitOpen || !selectedProjectId || !paneBProjectId) return
    const leftProjectId = selectedProjectId
    const leftSessionId = selectedSessionId
    setSelectedProjectId(paneBProjectId)
    setSelectedSessionId(paneBSessionId)
    setPaneBProjectId(leftProjectId)
    setPaneBSessionId(leftSessionId)
    setFocusedPane((current) => (current === 'a' ? 'b' : 'a'))
  }

  async function openSessionInPane(
    projectId: string,
    sessionId: string,
    pane: 'a' | 'b'
  ) {
    recordProjectSelection(projectId)
    recordSessionSelection(sessionId)
    setShowArchivedProjects(false)
    if (pane === 'b') setSplitOpen(true)
    setFocusedPane(pane)
    applyPaneSelection(pane, projectId, sessionId)
    openSession(sessionId)
    setOpenSessionRequest(nextWorkspaceRequest(projectId, pane))
    await window.projectConsole.terminals.acknowledge(sessionId)
    await refresh()
  }

  async function createProject(input: CreateProjectInput) {
    const created = await window.projectConsole.projects.create(input)
    await refresh()
    setShowArchivedProjects(false)
    focusPaneSelection(created.id, null)
  }

  async function copyProjectPath() {
    if (!project || !projectPath) return
    await window.projectConsole.system.copyText(projectPath)
    setCopiedPathProjectId(project.id)
    if (copiedPathTimer.current != null) {
      window.clearTimeout(copiedPathTimer.current)
    }
    copiedPathTimer.current = window.setTimeout(() => {
      setCopiedPathProjectId(null)
      copiedPathTimer.current = null
    }, 1_400)
  }

  async function updateProjectIcon(projectId: string, icon: string | null) {
    await window.projectConsole.projects.setIcon(projectId, icon)
    await refresh()
  }

  async function renameCurrentProject(name: string) {
    if (!project) return
    await window.projectConsole.projects.rename(project.id, name)
    await refresh()
  }

  async function promptRenameProject(target: Project) {
    setSidebarContext(null)
    setRenameTarget({ kind: 'project', project: target })
  }

  async function promptRenameSession(session: TerminalSession) {
    setSidebarContext(null)
    setRenameTarget({ kind: 'session', session })
  }

  async function applyRename(name: string) {
    if (!renameTarget) return
    if (renameTarget.kind === 'project') {
      await window.projectConsole.projects.rename(renameTarget.project.id, name)
    } else {
      await window.projectConsole.terminals.rename(renameTarget.session.id, name)
    }
    await refresh()
  }

  async function archiveProject(target: Project) {
    if (
      !window.confirm(
        `Archive “${target.name}”? All of its ${target.type === 'latex' ? 'writing chats' : 'terminals'} must already be stopped.`
      )
    )
      return
    await window.projectConsole.projects.archive(target.id)
    const nextProject = activeProjects.find((candidate) => candidate.id !== target.id)
    if (target.id === selectedProjectId) {
      setSelectedProjectId(nextProject?.id ?? null)
      setSelectedSessionId(null)
    }
    if (target.id === paneBProjectId) {
      setPaneBProjectId(nextProject?.id ?? null)
      setPaneBSessionId(null)
    }
    await refresh()
  }

  async function restoreProject(target: Project) {
    await window.projectConsole.projects.restore(target.id)
    await refresh()
    setShowArchivedProjects(false)
    focusPaneSelection(target.id, null)
  }

  async function deleteArchivedProject(target: Project) {
    if (
      !window.confirm(
        `Permanently remove “${target.name}” from PanePilot? Saved terminal output and activity will be deleted. The project folder, .panepilot files, and provider chat archives will remain.`
      )
    )
      return
    await window.projectConsole.projects.delete(target.id)
    await refresh()
  }

  function selectProject(id: string) {
    recordProjectSelection(id)
    setShowArchivedProjects(false)
    const defaultSessionId = defaultSessionIdFor(
      activeProjects.find((item) => item.id === id)
    )
    focusPaneSelection(id, defaultSessionId)
    if (defaultSessionId) openSession(defaultSessionId)
  }

  async function selectSession(projectId: string, sessionId: string) {
    const pane = splitOpen && focusedPane === 'b' ? 'b' : 'a'
    recordProjectSelection(projectId)
    recordSessionSelection(sessionId)
    setShowArchivedProjects(false)
    focusPaneSelection(projectId, sessionId)
    openSession(sessionId)
    setOpenSessionRequest(nextWorkspaceRequest(projectId, pane))
    await window.projectConsole.terminals.acknowledge(sessionId)
    await refresh()
  }

  async function reconnectSession(projectId: string, session: TerminalSession) {
    await window.projectConsole.terminals.retryAttach(session.id, 100, 30)
    await selectSession(projectId, session.id)
  }

  async function togglePin(session: TerminalSession) {
    await window.projectConsole.terminals.setPinned(session.id, !session.pinned)
    await refresh()
  }

  async function toggleFlag(session: TerminalSession) {
    await window.projectConsole.terminals.setFlagged(
      session.id,
      !session.flagged
    )
    await refresh()
  }

  async function stopSession(session: TerminalSession) {
    const detachesOnly = session.kind === 'terminal'
    if (
      !window.confirm(
        detachesOnly
          ? `Detach “${session.name}”? Its tmux session will keep running.`
          : `Stop “${session.name}”? Its saved output will be kept.`
      )
    )
      return
    await window.projectConsole.terminals.stop(session.id)
    await refresh()
  }

  async function archiveSession(session: TerminalSession) {
    await window.projectConsole.terminals.archive(session.id)
    await refresh()
  }

  async function resumeAgentSession(owner: Project, session: TerminalSession) {
    await window.projectConsole.terminals.resumeAgent(session.id)
    await selectSession(owner.id, session.id)
  }

  async function forceReloadAgentSession(
    owner: Project,
    session: TerminalSession
  ) {
    await window.projectConsole.terminals.forceReloadAgent(session.id)
    await selectSession(owner.id, session.id)
  }

  async function deleteSession(session: TerminalSession) {
    if (
      !window.confirm(
        `Close and permanently delete “${session.name}” and its saved output? Provider chat archives will remain.`
      )
    )
      return
    await window.projectConsole.terminals.delete(session.id)
    await refresh()
  }

  function openNewProject(connectionId?: string, type: ProjectType = 'terminal') {
    setNewProjectConnectionId(connectionId)
    setNewProjectType(type)
    setShowNewProject(true)
  }

  function openProjectLauncher(target: Project) {
    const pane = splitOpen && focusedPane === 'b' ? 'b' : 'a'
    selectProject(target.id)
    setLaunchTerminalRequest(nextWorkspaceRequest(target.id, pane))
  }

  function openTemporaryChats(target: Project, create = false) {
    if (create) temporaryChatRequestSequence.current += 1
    setTemporaryChatPanel({
      projectId: target.id,
      createRequest: create ? temporaryChatRequestSequence.current : null
    })
  }

  const workingCount = useMemo(
    () =>
      activeProjects
        .flatMap((item) => item.sessions)
        .filter(
          (session) => !session.archived && session.state === 'running'
        ).length,
    [activeProjects]
  )
  const attentionCount = useMemo(
    () =>
      activeProjects
        .flatMap((item) => item.sessions)
        .filter(
          (session) =>
            !session.archived && isAttentionState(session.state)
        ).length,
    [activeProjects]
  )
  const typeDefinition = project
    ? projectTypeRegistry[project.type]
    : projectTypeRegistry.terminal
  const Workspace = typeDefinition.Workspace
  const PaneAWorkspace = (
    paneAProject ? projectTypeRegistry[paneAProject.type] : projectTypeRegistry.terminal
  ).Workspace
  const PaneBWorkspace = (
    paneBProject ? projectTypeRegistry[paneBProject.type] : projectTypeRegistry.terminal
  ).Workspace

  const commandPaletteCommands: CommandPaletteCommand[] = [
    {
      id: 'action:new-project',
      section: 'Actions',
      label: 'New project',
      detail: 'Add a local or SSH-backed PanePilot project',
      keywords: ['create', 'add'],
      icon: <Plus size={15} />,
      action: () => openNewProject()
    },
    ...(project
      ? [
          {
            id: 'action:project-settings',
            section: 'Actions',
            label: 'Project settings',
            detail: project.name,
            keywords: ['rename', 'repository', 'overleaf'],
            icon: <Settings size={15} />,
            action: () => setShowProjectSettings(true)
          },
          ...(projectSupportsGit
            ? [
                {
                  id: 'action:git-pane',
                  section: 'Actions',
                  label: gitPaneOpen ? 'Close Git pane' : 'Open Git pane',
                  detail: `View working changes and commit graph for ${project.name}`,
                  keywords: ['source control', 'status', 'history', 'branch'],
                  icon: <GitBranch size={15} />,
                  action: () => setGitPaneOpen((current) => !current)
                }
              ]
            : []),
          {
            id: 'action:temporary-chats',
            section: 'Actions',
            label: 'Open quick Codex chats',
            detail: `Temporary chats for ${project.name}`,
            keywords: ['scratch', 'ephemeral', 'temporary', 'codex', 'chat'],
            icon: <MessageSquarePlus size={15} />,
            action: () => openTemporaryChats(project)
          },
          {
            id: 'action:new-temporary-chat',
            section: 'Actions',
            label: 'New quick Codex chat',
            detail: `Create a temporary chat for ${project.name}`,
            keywords: ['scratch', 'ephemeral', 'temporary', 'codex', 'chat'],
            icon: <Plus size={15} />,
            action: () => openTemporaryChats(project, true)
          },
          {
            id: 'action:google-drive',
            section: 'Actions',
            label: 'Google Drive connection',
            detail: `Connect or open Drive for ${project.name}`,
            keywords: ['upload', 'cloud', 'gdrive'],
            icon: <Cloud size={15} />,
            action: () =>
              setDriveDialogRequest((current) => ({
                projectId: project.id,
                nonce: (current?.nonce ?? 0) + 1
              }))
          },
          {
            id: 'action:new-terminal',
            section: 'Actions',
            label: project.type === 'latex' ? 'New writing chat' : 'New terminal',
            detail: project.name,
            keywords: ['shell', 'codex', 'claude', 'launch'],
            icon: <TerminalSquare size={15} />,
            action: () => openProjectLauncher(project)
          },
          ...(project.repositoryUrl
            ? [
                {
                  id: 'action:repository',
                  section: 'Actions',
                  label: 'Open repository',
                  detail: project.repositoryUrl,
                  keywords: ['github', 'git'],
                  icon: <Github size={15} />,
                  action: () =>
                    void window.projectConsole.projects.openRepository(
                      project.repositoryUrl!
                    )
                }
              ]
            : [])
        ]
      : []),
    {
      id: 'action:toggle-sidebar',
      section: 'Actions',
      label: sidebarOpen ? 'Hide sidebar' : 'Show sidebar',
      detail: 'Toggle the project navigator',
      keywords: ['navigation', 'panel'],
      icon: <PanelLeftClose size={15} />,
      action: () => setSidebarOpen((current) => !current)
    },
    {
      id: 'action:archive',
      section: 'Actions',
      label: 'Show project archive',
      detail: `${archivedProjects.length} archived project${archivedProjects.length === 1 ? '' : 's'}`,
      keywords: ['library', 'restore'],
      icon: <Archive size={15} />,
      action: () => {
        setShowArchivedProjects(true)
        setShowTypeMenu(false)
      }
    },
    ...activeProjects.map((target): CommandPaletteCommand => {
      const targetConnection = connections.find(
        (candidate) => candidate.id === target.connectionId
      )
      return {
        id: `project:${target.id}`,
        section: 'Projects',
        label: target.name,
        detail:
          targetConnection?.kind === 'ssh'
            ? `${targetConnection.name}:${target.folder}`
            : target.folder,
        keywords: [target.type, 'project', targetConnection?.name ?? ''],
        icon:
          target.type === 'latex' ? (
            <FileText size={15} />
          ) : (
            <TerminalSquare size={15} />
          ),
        action: () => selectProject(target.id)
      }
    }),
    ...activeProjects.flatMap((owner) =>
      owner.sessions
        .filter((session) => !session.archived && isSidebarSession(session))
        .map(
          (session): CommandPaletteCommand => ({
            id: `session:${session.id}`,
            section: 'Terminals',
            label: session.name,
            detail: `${owner.name} · ${session.profile} · ${session.state}`,
            keywords: [owner.name, session.profile, session.state, 'terminal'],
            icon: <TerminalProfileIcon profile={session.profile} size={15} />,
            action: () => void selectSession(owner.id, session.id)
          })
        )
    )
  ]

  function contextItems(context: SidebarContext): ContextMenuItem[] {
    if (context.kind === 'connection') {
      const { connection: target } = context
      return [
        {
          id: 'new-project',
          label: 'New project on this device',
          icon: <Plus size={14} />,
          action: () => openNewProject(target.id)
        },
        ...(target.kind === 'ssh'
          ? [
              {
                id: 'test',
                label: 'Test SSH connection',
                icon: <Wifi size={14} />,
                action: async () => {
                  const result =
                    await window.projectConsole.connections.test(target.id)
                  window.alert(
                    `${result.message}\n${result.ok ? `${result.latencyMs} ms` : 'Connection failed'}`
                  )
                }
              },
              {
                id: 'forwards',
                label: 'Manage port forwards',
                icon: <Network size={14} />,
                action: () => setPortForwardConnection(target)
              },
              {
                id: 'copy-ssh',
                label: 'Copy SSH command',
                icon: <Clipboard size={14} />,
                separatorBefore: true,
                action: () =>
                  window.projectConsole.system.copyText(
                    `ssh ${target.sshAlias}`
                  )
              }
            ]
          : [])
      ]
    }

    if (context.kind === 'project') {
      const target = context.project
      const targetConnection = connections.find(
        (item) => item.id === target.connectionId
      )
      return [
        {
          id: 'open',
          label: 'Open project',
          icon:
            target.type === 'latex' ? (
              <FileText size={14} />
            ) : (
              <TerminalSquare size={14} />
            ),
          action: () => selectProject(target.id)
        },
        ...(splitOpen
          ? [
              {
                id: 'open-left',
                label: 'Open in left pane',
                icon: <PanelLeft size={14} />,
                action: () => openProjectInPane(target.id, 'a')
              }
            ]
          : []),
        {
          id: 'open-right',
          label: splitOpen ? 'Open in right pane' : 'Open in split pane',
          icon: <PanelRight size={14} />,
          action: () => openProjectInPane(target.id, 'b')
        },
        {
          id: 'rename',
          label: 'Rename',
          icon: <Pencil size={14} />,
          separatorBefore: true,
          action: () => promptRenameProject(target)
        },
        {
          id: 'new-terminal',
          label: target.type === 'latex' ? 'New writing chat' : 'New terminal',
          icon:
            target.type === 'latex' ? (
              <MessageSquareText size={14} />
            ) : (
              <Plus size={14} />
            ),
          action: () => openProjectLauncher(target)
        },
        ...(targetConnection?.kind === 'local'
          ? [
              {
                id: 'folder',
                label: 'Open in Finder',
                icon: <FolderOpen size={14} />,
                separatorBefore: true,
                action: () =>
                  window.projectConsole.system.openProjectFolder(target.id)
              }
            ]
          : []),
        ...(target.repositoryUrl
          ? [
              {
                id: 'repository',
                label: 'Open repository',
                icon: <Github size={14} />,
                action: () =>
                  window.projectConsole.projects.openRepository(
                    target.repositoryUrl!
                  )
              }
            ]
          : []),
        ...(target.latex?.overleafUrl
          ? [
              {
                id: 'overleaf',
                label: 'Open in Overleaf',
                icon: <ExternalLink size={14} />,
                action: () =>
                  window.projectConsole.system.openExternal(
                    target.latex!.overleafUrl!
                  )
              }
            ]
          : []),
        {
          id: 'copy-path',
          label: 'Copy project path',
          icon: <Clipboard size={14} />,
          action: () =>
            window.projectConsole.system.copyText(
              targetConnection?.kind === 'ssh'
                ? `${targetConnection.sshAlias}:${target.folder}`
                : target.folder
            )
        },
        {
          id: 'archive',
          label: 'Archive project',
          icon: <Archive size={14} />,
          separatorBefore: true,
          action: () => archiveProject(target)
        }
      ]
    }

    const { project: owner, session } = context
    const ownerConnection = connections.find(
      (item) => item.id === owner.connectionId
    )
    const stopped = ['completed', 'error'].includes(session.state)
    const providerSessionReference = session.providerSessionId
    return [
      {
        id: 'open',
        label: 'Open terminal',
        icon: <TerminalSquare size={14} />,
        action: () => selectSession(owner.id, session.id)
      },
      ...(splitOpen
        ? [
            {
              id: 'open-left',
              label: 'Open in left pane',
              icon: <PanelLeft size={14} />,
              action: () => openSessionInPane(owner.id, session.id, 'a')
            }
          ]
        : []),
      {
        id: 'open-right',
        label: splitOpen ? 'Open in right pane' : 'Open in split pane',
        icon: <PanelRight size={14} />,
        action: () => openSessionInPane(owner.id, session.id, 'b')
      },
      ...(openSessionIds.has(session.id)
        ? [
            {
              id: 'close-tab',
              label: 'Close tab (keeps tmux running)',
              icon: <X size={14} />,
              action: () => closeSession(session.id)
            }
          ]
        : []),
      {
        id: 'rename',
        label: 'Rename terminal and tmux',
        icon: <Pencil size={14} />,
        separatorBefore: true,
        action: () => promptRenameSession(session)
      },
      {
        id: 'pin',
        label: session.pinned ? 'Unpin terminal' : 'Pin terminal',
        icon: session.pinned ? <PinOff size={14} /> : <Pin size={14} />,
        action: () => togglePin(session)
      },
      {
        id: 'flag',
        label: session.flagged ? 'Remove flag' : 'Flag for later',
        icon: (
          <Flag
            size={14}
            fill={session.flagged ? 'currentColor' : 'none'}
          />
        ),
        action: () => toggleFlag(session)
      },
      ...(session.tmuxName
        ? [
            {
              id: 'copy-attach',
              label: 'Copy tmux attach command',
              icon: <Clipboard size={14} />,
              separatorBefore: true,
              action: () =>
                window.projectConsole.system.copyText(
                  tmuxAttachCommand(ownerConnection, session.tmuxName!)
                )
            },
            {
              id: 'copy-options',
              label: 'Copy tmux options command',
              icon: <Clipboard size={14} />,
              action: () =>
                window.projectConsole.system.copyText(
                  tmuxOptionsCommand(ownerConnection, session.tmuxName!)
                )
            }
          ]
        : []),
      ...(providerSessionReference
        ? [
            {
              id: 'copy-provider-session',
              label: `Copy ${session.profile === 'claude' ? 'Claude session' : 'Codex thread'} ID`,
              icon: <Clipboard size={14} />,
              action: () =>
                window.projectConsole.system.copyText(providerSessionReference)
            }
          ]
        : []),
      ...(['codex', 'claude'].includes(session.profile)
        ? [
            {
              id: 'force-reload-agent',
              label: `Force reload ${session.profile === 'claude' ? 'Claude' : 'Codex'} chat`,
              icon: <RefreshCw size={14} />,
              action: () => forceReloadAgentSession(owner, session)
            }
          ]
        : []),
      ...(stopped
        ? [
            ...(['codex', 'claude'].includes(session.profile) && providerSessionReference
              ? [
                  {
                    id: 'resume-agent',
                    label: `Resume ${session.profile === 'claude' ? 'Claude' : 'Codex'} chat`,
                    icon: <ArchiveRestore size={14} />,
                    separatorBefore: true,
                    action: () => resumeAgentSession(owner, session)
                  }
                ]
              : []),
            {
              id: 'archive',
              label: 'Archive terminal',
              icon: <Archive size={14} />,
              separatorBefore: !(
                ['codex', 'claude'].includes(session.profile) &&
                providerSessionReference
              ),
              action: () => archiveSession(session)
            },
            {
              id: 'delete',
              label: 'Delete terminal',
              icon: <Trash2 size={14} />,
              danger: true,
              action: () => deleteSession(session)
            }
          ]
        : [
            {
              id: 'stop',
              label:
                session.kind === 'terminal'
                  ? 'Detach terminal'
                  : 'Stop terminal',
              icon: <Square size={14} />,
              separatorBefore: true,
              action: () => stopSession(session)
            },
            ...(session.kind === 'terminal'
              ? [
                  {
                    id: 'delete',
                    label: 'Delete terminal',
                    icon: <Trash2 size={14} />,
                    danger: true,
                    action: () => deleteSession(session)
                  }
                ]
              : [])
          ])
    ]
  }

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="brand-mark">
          <TerminalSquare size={23} />
        </div>
        <span>Opening PanePilot…</span>
      </div>
    )
  }

  const gitPaneVisible =
    gitPaneOpen && project != null && projectSupportsGit && !showArchivedProjects
  const gitTone = gitToolbarTone(gitStatus, gitStatusError)
  const gitBadge = gitToolbarBadge(gitStatus)

  return (
    <div
      className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} ${
        gitPaneVisible ? 'git-pane-open' : ''
      }`}
    >
      <header className="top-bar">
        <div className="traffic-spacer" />
        <button
          className="icon-button sidebar-toggle"
          onClick={() => setSidebarOpen((value) => !value)}
          aria-label="Toggle sidebar"
        >
          {sidebarOpen ? <PanelLeftClose size={17} /> : <Menu size={17} />}
        </button>
        <div className="type-switcher-wrap">
          <button
            className="type-switcher"
            onClick={() => setShowTypeMenu((current) => !current)}
            aria-expanded={showTypeMenu}
          >
            {showArchivedProjects ? (
              <Archive size={15} />
            ) : project?.type === 'latex' ? (
              <FileText size={15} />
            ) : (
              <TerminalSquare size={15} />
            )}
            <span>{showArchivedProjects ? 'Archive' : typeDefinition.label}</span>
            <ChevronDown size={13} />
          </button>
          {showTypeMenu && (
            <div className="type-menu">
              {Object.values(projectTypeRegistry).map((definition) => {
                const first = activeProjects.find(
                  (candidate) => candidate.type === definition.id
                )
                return (
                  <button
                    key={definition.id}
                    className={project?.type === definition.id ? 'active' : ''}
                    onClick={() => {
                      setShowTypeMenu(false)
                      if (first) {
                        selectProject(first.id)
                      } else {
                        openNewProject(undefined, definition.id)
                      }
                    }}
                  >
                    {definition.id === 'latex' ? (
                      <FileText size={15} />
                    ) : (
                      <TerminalSquare size={15} />
                    )}
                    <span>
                      <strong>{definition.label}</strong>
                      <small>
                        {first
                          ? `${activeProjects.filter((candidate) => candidate.type === definition.id).length} projects`
                          : 'Create the first project'}
                      </small>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <div className="top-divider" />
        <div className="project-identity">
          {showArchivedProjects ? (
            <strong>Archived projects</strong>
          ) : project ? (
            <>
              <strong>{project.name}</strong>
              <button
                className={`project-path-copy ${
                  copiedPathProjectId === project.id ? 'copied' : ''
                }`}
                onClick={() => void copyProjectPath().catch(showError)}
                aria-label={`Copy project path: ${projectPath}`}
                title={
                  copiedPathProjectId === project.id
                    ? 'Copied project path'
                    : 'Copy project path'
                }
              >
                {projectPath}
              </button>
            </>
          ) : (
            <strong>PanePilot</strong>
          )}
        </div>
        <div className="top-actions">
          <AppearanceControl
            scale={appearanceScale}
            onChange={setAppearanceScale}
          />
          <SpeechControl />
          {project && (
            <button
              className={`icon-button temporary-chat-toolbar-button ${
                temporaryChatPanel?.projectId === project.id ? 'active' : ''
              }`}
              aria-label="Open quick Codex chats"
              title="Quick Codex chats"
              onClick={() => openTemporaryChats(project)}
            >
              <MessageSquarePlus size={16} />
              {project.sessions.filter(
                (session) =>
                  session.kind === 'temporary-chat' && !session.archived
              ).length > 0 && (
                <span aria-hidden="true">
                  {
                    project.sessions.filter(
                      (session) =>
                        session.kind === 'temporary-chat' && !session.archived
                    ).length
                  }
                </span>
              )}
            </button>
          )}
          {project?.latex?.overleafUrl && (
            <button
              className="secondary-button header-button overleaf-button"
              onClick={() =>
                void window.projectConsole.system.openExternal(
                  project.latex!.overleafUrl!
                )
              }
            >
              <ExternalLink size={15} /> Overleaf
            </button>
          )}
          {project?.repositoryUrl && (
            <button
              className="secondary-button header-button"
              onClick={() =>
                void window.projectConsole.projects.openRepository(
                  project.repositoryUrl!
                )
              }
            >
              <Github size={15} /> Repository
            </button>
          )}
          {project && (
            <GoogleDriveControl
              key={project.id}
              project={project}
              openRequest={driveDialogRequest}
            />
          )}
          <button
            className={`icon-button ${splitOpen ? 'active' : ''}`}
            aria-label={splitOpen ? 'Close split view' : 'Split viewing pane'}
            title={splitOpen ? 'Close split view' : 'Split viewing pane'}
            onClick={() => {
              setSplitOpen(!splitOpen)
              setFocusedPane(splitOpen ? 'a' : 'b')
            }}
          >
            <Columns2 size={16} />
          </button>
          <button
            className={`icon-button git-toolbar-button ${gitTone} ${
              gitPaneVisible ? 'active' : ''
            }`}
            aria-label={gitPaneVisible ? 'Close Git pane' : 'Open Git pane'}
            aria-pressed={gitPaneVisible}
            title={gitToolbarTitle(gitStatus, gitStatusError, gitStatusLoading)}
            disabled={!project || !projectSupportsGit || showArchivedProjects}
            onClick={() => setGitPaneOpen((current) => !current)}
          >
            <GitBranch size={16} />
            {gitBadge ? (
              <span className="git-toolbar-badge" aria-hidden="true">
                {gitBadge}
              </span>
            ) : (gitTone === 'clean' || gitTone === 'error') ? (
              <span className="git-toolbar-dot" aria-hidden="true" />
            ) : null}
          </button>
          <button
            className="icon-button"
            aria-label="Project settings"
            title="Project settings"
            disabled={!project}
            onClick={() => setShowProjectSettings(true)}
          >
            <Settings size={16} />
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">
            <TerminalSquare size={19} />
          </div>
          <div>
            <strong>PanePilot</strong>
            <span>Agent workspace</span>
          </div>
        </div>
        <div className="sidebar-scroll">
          {connections.map((item) => {
            const connectionSort = projectSortFor(projectSorts, item.id)
            const connectionProjects = sortProjects(
              activeProjects.filter(
                (candidate) => candidate.connectionId === item.id
              ),
              connectionSort,
              selectionRecency.projects,
              projectAttentionOrder
            )
            if (item.kind === 'ssh' && connectionProjects.length === 0) return null
            return (
              <section className="connection-group" key={item.id}>
                <div
                  className="connection-heading"
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setSidebarContext({
                      kind: 'connection',
                      connection: item,
                      x: event.clientX,
                      y: event.clientY
                    })
                  }}
                >
                  {item.kind === 'local' ? (
                    <Laptop size={14} />
                  ) : (
                    <Server size={14} />
                  )}
                  <span>{item.name}</span>
                  <small>{connectionProjects.length}</small>
                  <button
                    className="connection-sort-button"
                    aria-label={`Sort projects on ${item.name}`}
                    aria-haspopup="menu"
                    aria-expanded={
                      projectSortMenu?.connectionId === item.id
                    }
                    title={`Sort projects: ${
                      projectSortOptions.find(
                        (option) => option.value === connectionSort
                      )?.label
                    }`}
                    onClick={(event) => {
                      event.stopPropagation()
                      const bounds = event.currentTarget.getBoundingClientRect()
                      setProjectSortMenu({
                        connectionId: item.id,
                        x: bounds.right - 184,
                        y: bounds.bottom + 4
                      })
                    }}
                  >
                    <ArrowUpDown size={12} />
                  </button>
                </div>
                {connectionProjects.map((candidate) => {
                  const visibleSessions = sortSessions(
                    candidate.sessions.filter(
                      (session) =>
                        !session.archived && isSidebarSession(session)
                    ),
                    sessionSort,
                    selectionRecency.sessions
                  )
                  const hasSessions = visibleSessions.length > 0
                  const isCollapsed = collapsedProjectIds.has(candidate.id)
                  const showSessions = hasSessions && !isCollapsed
                  return (
                    <div className="project-tree" key={candidate.id}>
                      <div
                        className={`project-row ${
                          candidate.id === project?.id && !showArchivedProjects
                            ? 'selected'
                            : ''
                        }`}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setSidebarContext({
                            kind: 'project',
                            project: candidate,
                            x: event.clientX,
                            y: event.clientY
                          })
                        }}
                      >
                        <button
                          className="sidebar-collapse-toggle"
                          disabled={!hasSessions}
                          aria-label={
                            isCollapsed
                              ? `Expand ${candidate.name}`
                              : `Collapse ${candidate.name}`
                          }
                          aria-expanded={hasSessions ? !isCollapsed : undefined}
                          onClick={(event) => {
                            event.stopPropagation()
                            toggleProjectCollapsed(candidate.id)
                          }}
                        >
                          <ChevronRight
                            size={13}
                            className={showSessions ? 'chevron-expanded' : ''}
                          />
                        </button>
                        <button
                          className={`project-glyph ${candidate.type} ${
                            candidate.id === selectedProjectId &&
                            !showArchivedProjects
                              ? 'pane-left'
                              : ''
                          } ${
                            splitOpen && candidate.id === paneBProjectId
                              ? 'pane-right'
                              : ''
                          }`}
                          aria-label={`Change icon for ${candidate.name}`}
                          title={projectGlyphTitle(
                            candidate.name,
                            candidate.id === selectedProjectId &&
                              !showArchivedProjects,
                            splitOpen && candidate.id === paneBProjectId
                          )}
                          onClick={(event) => {
                            event.stopPropagation()
                            const bounds = event.currentTarget.getBoundingClientRect()
                            setProjectIconMenu({
                              project: candidate,
                              x: bounds.right + 6,
                              y: bounds.top - 6
                            })
                          }}
                        >
                          <span className="project-glyph-content" aria-hidden="true">
                            {candidate.icon ??
                              (candidate.type === 'latex' ? (
                                <FileText size={12} />
                              ) : (
                                candidate.name.slice(0, 1).toUpperCase()
                              ))}
                          </span>
                        </button>
                        <button
                          className="sidebar-row-main"
                          onClick={() => selectProject(candidate.id)}
                        >
                          <span className="row-label">{candidate.name}</span>
                          {candidate.type === 'latex' && visibleSessions.length > 0 && (
                            <small className="project-chat-count">
                              {visibleSessions.length}
                            </small>
                          )}
                          <StatusDot state={candidate.state} compact />
                        </button>
                        <button
                          className="sidebar-hover-action"
                          title="Rename project"
                          onClick={() =>
                            void promptRenameProject(candidate).catch(showError)
                          }
                        >
                          <Pencil size={12} />
                        </button>
                      </div>
                      {showSessions && (
                        <div className="session-tree">
                          {visibleSessions.map((session) => (
                            <div
                              key={session.id}
                              className={`session-row ${
                                !showArchivedProjects &&
                                ((candidate.id === selectedProjectId &&
                                  session.id === selectedSessionId) ||
                                  (splitOpen &&
                                    candidate.id === paneBProjectId &&
                                    session.id === paneBSessionId))
                                  ? 'selected'
                                  : ''
                              } ${
                                session.kind === 'terminal' &&
                                !openSessionIds.has(session.id)
                                  ? 'tab-closed'
                                  : 'tab-open'
                              }`}
                              title={
                                session.kind !== 'terminal'
                                  ? undefined
                                  : openSessionIds.has(session.id)
                                    ? `${session.name} — open in a pane`
                                    : `${session.name} — tab closed (tmux still running); click to reopen`
                              }
                              onContextMenu={(event) => {
                                event.preventDefault()
                                setSidebarContext({
                                  kind: 'session',
                                  project: candidate,
                                  session,
                                  x: event.clientX,
                                  y: event.clientY
                                })
                              }}
                            >
                              <button
                                className="sidebar-row-main"
                                onClick={() =>
                                  void selectSession(candidate.id, session.id)
                                }
                              >
                                <StatusDot state={session.state} compact />
                                <TerminalProfileIcon
                                  profile={session.profile}
                                  className="terminal-profile-icon"
                                />
                                {session.pinned && (
                                  <Pin className="pinned-indicator" size={10} />
                                )}
                                <span>{session.name}</span>
                                {isAttentionState(session.state) && (
                                  <small className="attention-badge">!</small>
                                )}
                              </button>
                              {shouldOfferTmuxReconnect(
                                candidate,
                                session,
                                terminalTransportStates[session.id]
                              ) && (
                                  <button
                                    className="sidebar-hover-action sidebar-reconnect-action"
                                    aria-label={`Reconnect ${session.name} to tmux`}
                                    title="Reconnect to tmux"
                                    onClick={() =>
                                      void reconnectSession(
                                        candidate.id,
                                        session
                                      ).catch(showError)
                                    }
                                  >
                                    <RefreshCw size={11} />
                                  </button>
                                )}
                              <button
                                className={`sidebar-hover-action sidebar-flag-action ${
                                  session.flagged ? 'flagged' : ''
                                }`}
                                title={
                                  session.flagged
                                    ? 'Remove flag'
                                    : 'Flag terminal for later'
                                }
                                aria-label={
                                  session.flagged
                                    ? `Remove flag from ${session.name}`
                                    : `Flag ${session.name} for later`
                                }
                                aria-pressed={session.flagged}
                                onClick={() =>
                                  void toggleFlag(session).catch(showError)
                                }
                              >
                                <Flag
                                  size={11}
                                  fill={session.flagged ? 'currentColor' : 'none'}
                                />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {item.kind === 'local' && connectionProjects.length === 0 && (
                  <button
                    className="sidebar-add"
                    onClick={() => openNewProject(item.id)}
                  >
                    <Plus size={14} /> Add your first project
                  </button>
                )}
              </section>
            )
          })}
        </div>
        <div className="sidebar-footer-actions">
          <button
            className={`archived-projects-sidebar ${
              showArchivedProjects ? 'selected' : ''
            }`}
            onClick={() => {
              setShowArchivedProjects(true)
              setShowProjectSettings(false)
            }}
          >
            <Archive size={15} />
            <span>Archived projects</span>
            <small>{archivedProjects.length}</small>
          </button>
          <div className="new-project-actions">
            <button className="new-project-sidebar" onClick={() => openNewProject()}>
              <Plus size={15} />
              <span>New project</span>
            </button>
            <button
              className="refresh-connections-button"
              onClick={() => void refreshSshConnections()}
              disabled={refreshingConnections}
              title="Refresh SSH hosts from ~/.ssh/config"
              aria-label="Refresh SSH hosts"
            >
              <RefreshCw
                size={15}
                className={refreshingConnections ? 'spin' : ''}
              />
            </button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        {error ? (
          <div className="capability-empty error-empty">
            <Boxes size={35} />
            <h2>PanePilot couldn’t open</h2>
            <p>{error}</p>
          </div>
        ) : showArchivedProjects ? (
          <ArchivedProjectsPage
            projects={archivedProjects}
            connections={connections}
            onRestore={restoreProject}
            onRename={promptRenameProject}
            onDelete={deleteArchivedProject}
          />
        ) : (
          <div className={`workspace-split ${splitOpen ? 'split' : ''}`}>
            <div
              className={`workspace-pane ${
                splitOpen && focusedPane === 'a' ? 'focused' : ''
              }`}
              onMouseDownCapture={() => setFocusedPane('a')}
            >
              {paneAProject ? (
                <PaneAWorkspace
                  project={paneAProject}
                  connection={paneAConnection}
                  selectedSessionId={selectedSessionId}
                  launchTerminalRequest={workspaceRequestIdFor(
                    launchTerminalRequest,
                    paneAProject.id,
                    'a'
                  )}
                  openSessionRequest={workspaceRequestIdFor(
                    openSessionRequest,
                    paneAProject.id,
                    'a'
                  )}
                  terminalTransportStates={terminalTransportStates}
                  openSessionIds={openSessionIds}
                  onOpenSession={openSession}
                  onCloseSession={closeSession}
                  onSessionSelected={recordSessionSelection}
                  onLaunchTerminalRequestHandled={handleLaunchTerminalRequest}
                  onOpenSessionRequestHandled={handleOpenSessionRequest}
                  onSwapPanes={
                    splitOpen && paneAProject && paneBProject
                      ? swapPanes
                      : undefined
                  }
                  onSelectSession={(id) => {
                    setSelectedSessionId(id)
                    openSession(id)
                  }}
                  onChanged={refresh}
                />
              ) : (
                <div className="welcome">
                  <div className="welcome-art">
                    <div className="orbit orbit-one" />
                    <div className="orbit orbit-two" />
                    <div className="welcome-mark">
                      <Bot size={35} />
                    </div>
                    <Sparkles className="spark spark-one" size={18} />
                    <Sparkles className="spark spark-two" size={13} />
                  </div>
                  <span className="eyebrow">YOUR PROJECT CONTROL CENTER</span>
                  <h1>Keep every agent in view.</h1>
                  <p>
                    Bring local and SSH projects into one place, run agents in persistent
                    terminals, and see exactly when they need you.
                  </p>
                  <button
                    className="primary-button welcome-button"
                    onClick={() => openNewProject()}
                  >
                    <Plus size={16} /> Add a project
                  </button>
                </div>
              )}
            </div>
            {splitOpen && (
              <div
                className={`workspace-pane ${focusedPane === 'b' ? 'focused' : ''}`}
                onMouseDownCapture={() => setFocusedPane('b')}
              >
                {paneBProject ? (
                  <PaneBWorkspace
                    project={paneBProject}
                    connection={paneBConnection}
                    selectedSessionId={paneBSessionId}
                    launchTerminalRequest={workspaceRequestIdFor(
                      launchTerminalRequest,
                      paneBProject.id,
                      'b'
                    )}
                    openSessionRequest={workspaceRequestIdFor(
                      openSessionRequest,
                      paneBProject.id,
                      'b'
                    )}
                    terminalTransportStates={terminalTransportStates}
                    openSessionIds={openSessionIds}
                    onOpenSession={openSession}
                    onCloseSession={closeSession}
                    onSessionSelected={recordSessionSelection}
                    onLaunchTerminalRequestHandled={handleLaunchTerminalRequest}
                    onOpenSessionRequestHandled={handleOpenSessionRequest}
                    onSwapPanes={paneAProject ? swapPanes : undefined}
                    onSelectSession={(id) => {
                      setPaneBSessionId(id)
                      openSession(id)
                    }}
                    onChanged={refresh}
                  />
                ) : (
                  <div className="welcome pane-empty-picker">
                    <div className="welcome-art">
                      <div className="orbit orbit-one" />
                      <div className="orbit orbit-two" />
                      <div className="welcome-mark">
                        <Columns2 size={31} />
                      </div>
                    </div>
                    <span className="eyebrow">SECOND PANE</span>
                    <h1>Pick a project</h1>
                    <p>Choose a project or terminal from the sidebar to open it here.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {gitPaneVisible && project && (
        <GitPane
          key={project.id}
          projectId={project.id}
          projectName={project.name}
          status={gitStatus}
          statusLoading={gitStatusLoading}
          statusError={gitStatusError}
          onRefreshStatus={refreshGitStatus}
          onClose={() => setGitPaneOpen(false)}
        />
      )}

      <footer className="status-bar">
        <div className="status-brand">
          <span className="live-pip" />
          Ready
          {focusedSession?.dangerousMode && (
            <span
              className="status-unsafe"
              title={`${focusedSession.name} is running with its agent permission checks disabled.`}
            >
              <ShieldAlert size={11} />
              Unsafe · {focusedSession.name}
            </span>
          )}
        </div>
        <div className="status-summary">
          <span>
            <span className="mini-dot running" />
            {workingCount} working
          </span>
          <span>
            <span className="mini-dot attention" />
            {attentionCount} need{attentionCount === 1 ? 's' : ''} attention
          </span>
          <span className="project-total">{activeProjects.length} projects</span>
        </div>
      </footer>

      {showNewProject && (
        <NewProjectDialog
          connections={connections}
          initialConnectionId={newProjectConnectionId}
          initialProjectType={newProjectType}
          onClose={() => {
            setShowNewProject(false)
            setNewProjectConnectionId(undefined)
            setNewProjectType('terminal')
          }}
          onCreate={createProject}
        />
      )}
      {showProjectSettings && project && (
        <ProjectSettingsDialog
          project={project}
          connection={connection}
          onClose={() => setShowProjectSettings(false)}
          onRename={renameCurrentProject}
          onChanged={refresh}
        />
      )}
      {renameTarget && (
        <RenameDialog
          title={
            renameTarget.kind === 'project'
              ? `Rename ${renameTarget.project.name}`
              : `Rename ${renameTarget.session.name}`
          }
          eyebrow={
            renameTarget.kind === 'project' ? 'PROJECT NAME' : 'TERMINAL NAME'
          }
          label={
            renameTarget.kind === 'project'
              ? 'Project name'
              : 'Terminal and tmux session name'
          }
          initialValue={
            renameTarget.kind === 'project'
              ? renameTarget.project.name
              : renameTarget.session.name
          }
          description={
            renameTarget.kind === 'session'
              ? 'PanePilot will rename the terminal and its tmux session together.'
              : undefined
          }
          maxLength={renameTarget.kind === 'session' ? 80 : undefined}
          onClose={() => setRenameTarget(null)}
          onRename={applyRename}
        />
      )}
      {portForwardConnection && (
        <PortForwardDialog
          connection={portForwardConnection}
          onClose={() => setPortForwardConnection(null)}
        />
      )}
      {temporaryChatProject && temporaryChatPanel && (
        <TemporaryChatsPanel
          key={temporaryChatProject.id}
          project={temporaryChatProject}
          createRequest={temporaryChatPanel.createRequest}
          onChanged={refresh}
          onClose={() => setTemporaryChatPanel(null)}
        />
      )}
      <CommandPalette
        open={showCommandPalette}
        commands={commandPaletteCommands}
        onClose={() => setShowCommandPalette(false)}
      />
      {projectSortMenu &&
        (() => {
          const targetConnection = connections.find(
            (item) => item.id === projectSortMenu.connectionId
          )
          if (!targetConnection) return null
          return (
            <SortMenu
              x={projectSortMenu.x}
              y={projectSortMenu.y}
              label={`Sort ${targetConnection.name} projects`}
              value={projectSortFor(projectSorts, targetConnection.id)}
              options={projectSortOptions}
              onChange={(value) => setProjectSort(targetConnection.id, value)}
              onClose={() => setProjectSortMenu(null)}
            />
          )
        })()}
      {projectIconMenu && (
        <ProjectIconMenu
          key={projectIconMenu.project.id}
          project={projectIconMenu.project}
          x={projectIconMenu.x}
          y={projectIconMenu.y}
          onSave={(icon) =>
            updateProjectIcon(projectIconMenu.project.id, icon)
          }
          onClose={() => setProjectIconMenu(null)}
        />
      )}
      {sidebarContext && (
        <ContextMenu
          x={sidebarContext.x}
          y={sidebarContext.y}
          items={contextItems(sidebarContext)}
          onClose={() => setSidebarContext(null)}
        />
      )}
    </div>
  )
}

function messageFor(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function showError(value: unknown): void {
  window.alert(messageFor(value))
}

function gitToolbarTone(
  status: GitRepositoryStatus | null,
  error: string
): 'idle' | 'error' | 'conflict' | 'staged' | 'untracked' | 'changed' | 'ahead' | 'clean' {
  if (error) return 'error'
  if (!status?.isRepository) return 'idle'
  if (status.changes.some((change) => change.conflicted)) return 'conflict'
  if (status.changes.some((change) => change.staged)) return 'staged'
  if (status.changes.some((change) => change.untracked)) return 'untracked'
  if (status.changes.length > 0) return 'changed'
  if (status.ahead > 0 || status.behind > 0) return 'ahead'
  return 'clean'
}

function gitToolbarBadge(status: GitRepositoryStatus | null): string | null {
  if (!status?.isRepository) return null
  if (status.changes.length > 0) {
    return status.changes.length > 99 ? '99+' : String(status.changes.length)
  }
  if (status.ahead > 0) return `↑${status.ahead > 9 ? '9+' : status.ahead}`
  if (status.behind > 0) return `↓${status.behind > 9 ? '9+' : status.behind}`
  return null
}

function gitToolbarTitle(
  status: GitRepositoryStatus | null,
  error: string,
  loading: boolean
): string {
  if (error) return `Git status unavailable: ${error}`
  if (!status) return loading ? 'Reading Git status…' : 'Open Git pane'
  if (!status.isRepository) return status.message ?? 'No Git repository'
  const parts = [status.branch ?? `detached ${status.head?.slice(0, 8) ?? 'HEAD'}`]
  const conflicts = status.changes.filter((change) => change.conflicted).length
  const staged = status.changes.filter(
    (change) => !change.conflicted && change.staged
  ).length
  const untracked = status.changes.filter((change) => change.untracked).length
  const working = status.changes.filter(
    (change) => !change.conflicted && !change.untracked && change.workingTree
  ).length
  if (status.clean) parts.push('clean')
  if (conflicts > 0) parts.push(`${conflicts} conflicted`)
  if (staged > 0) parts.push(`${staged} staged`)
  if (working > 0) parts.push(`${working} modified`)
  if (untracked > 0) parts.push(`${untracked} untracked`)
  if (status.ahead > 0) parts.push(`${status.ahead} ahead`)
  if (status.behind > 0) parts.push(`${status.behind} behind`)
  return `Git: ${parts.join(' · ')}`
}

function projectGlyphTitle(name: string, left: boolean, right: boolean): string {
  if (left && right) return `Change ${name} icon · Open in both panes`
  if (left) return `Change ${name} icon · Open in the left pane`
  if (right) return `Change ${name} icon · Open in the right pane`
  return `Change ${name} icon`
}
