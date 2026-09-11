import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition
} from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  Bot,
  Boxes,
  Building2,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Cloud,
  Columns2,
  ExternalLink,
  FileText,
  Flag,
  FolderInput,
  FolderOpen,
  GitBranch,
  Github,
  Globe2,
  Laptop,
  LockKeyhole,
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
  AgentState,
  GitHubRepositoryVisibilityStatus,
  GitRepositoryStatus,
  Project,
  ProjectType,
  TerminalSession,
  TerminalStateEvent,
  TerminalTransportState
} from '@shared/types'
import { isAttentionState } from '../lib/status'
import { useAppearanceScale } from '../lib/appearanceScale'
import { useOpenSessions } from '../lib/openSessions'
import { isPaneSwapShortcut } from '../lib/projectShortcuts'
import { isOriginlessGitRepository } from '../lib/gitPane'
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
import {
  clampSidebarWidth,
  COMPACT_SIDEBAR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  loadSidebarWidth,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  saveSidebarWidth,
  sidebarRevealDelta
} from '../lib/sidebarLayout'
import { shouldOfferTmuxReconnect } from '../lib/terminalTransport'
import { tmuxAttachCommand, tmuxOptionsCommand } from '../lib/tmuxCommands'
import {
  consumeWorkspaceRequest,
  workspaceRequestIdFor,
  type WorkspacePane,
  type WorkspaceRequest
} from '../lib/workspaceRequest'
import {
  consumeWorkspaceTabRequest,
  loadWorkspaceHistory,
  nextWorkspaceSwitcherIndex,
  nextWorkspaceSwitcherMode,
  projectCapabilityDestinations,
  projectTerminalDestinations,
  recordWorkspaceDestination,
  removeWorkspaceDestination,
  workspaceHistoryRemovalTarget,
  saveWorkspaceHistory,
  workspaceSwitcherArrowAction,
  workspaceSwitcherDestinations,
  workspaceTabRequestFor,
  type WorkspaceDestination,
  type WorkspaceTabRequest
} from '../lib/workspaceHistory'
import { projectTypeRegistry } from '../projectTypeRegistry'
import { WorkspaceSwitcherReleaseGuard } from '../lib/workspaceSwitcherRelease'
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
import { PaneWorkspaceStack } from './PaneWorkspaceStack'
import { PortForwardDialog } from './PortForwardDialog'
import { ProjectIconMenu } from './ProjectIconMenu'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { RenameDialog } from './RenameDialog'
import { SortMenu } from './SortMenu'
import { SpeechControl } from './SpeechControl'
import { StatusDot } from './StatusDot'
import { TerminalProfileIcon } from './TerminalProfileIcon'
import { TemporaryChatsPanel } from './TemporaryChatsPanel'
import { TransferSessionDialog } from './TransferSessionDialog'
import { WorkspaceSwitcherOverlay } from './WorkspaceSwitcherOverlay'

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

interface WorkspaceSwitcherState {
  destinations: WorkspaceDestination[]
  selectedIndex: number
  modifier: 'Meta' | 'Control'
  restoreSidebarCollapsed: boolean
  mode: 'recent' | 'terminals' | 'capabilities'
  projectId: string | null
  currentKey: string | null
  hoveredKey: string | null
  removingKey?: string | null
}

const RENDERER_STATE_PRIORITY: AgentState[] = [
  'needs-input',
  'needs-attention',
  'running',
  'response-ready',
  'idle',
  'error',
  'completed'
]
const gitStatusCache = new Map<string, GitRepositoryStatus>()
const repositoryVisibilityCache =
  new Map<string, GitHubRepositoryVisibilityStatus>()
const PROJECT_READ_CACHE_LIMIT = 64

function cacheProjectRead<T>(cache: Map<string, T>, projectId: string, value: T) {
  cache.delete(projectId)
  cache.set(projectId, value)
  if (cache.size <= PROJECT_READ_CACHE_LIMIT) return
  const oldestProjectId = cache.keys().next().value
  if (oldestProjectId) cache.delete(oldestProjectId)
}

function projectStateForSessions(sessions: TerminalSession[]): AgentState {
  const visible = sessions.filter(
    (session) => !session.archived && session.kind !== 'action'
  )
  return (
    RENDERER_STATE_PRIORITY.find((state) =>
      visible.some((session) => session.state === state)
    ) ?? 'idle'
  )
}

function withTerminalState(
  project: Project,
  event: TerminalStateEvent
): Project {
  if (project.id !== event.projectId) return project
  let changed = false
  const sessions = project.sessions.map((session) => {
    if (session.id !== event.sessionId || session.state === event.state) {
      return session
    }
    changed = true
    return { ...session, state: event.state }
  })
  if (!changed) return project
  return { ...project, sessions, state: projectStateForSessions(sessions) }
}

function isSidebarSession(session: TerminalSession): boolean {
  return (
    session.kind === 'terminal' ||
    (session.kind === 'latex-chat' &&
      session.latexChat?.purpose === 'writing')
  )
}

async function getRendererProject(projectId: string): Promise<Project | null> {
  const getProject = window.projectConsole.projects.get
  if (typeof getProject === 'function') return getProject(projectId)

  // Electron can hot-reload this renderer while the running preload still
  // exposes the previous API. Keep that window usable until the next relaunch.
  const projects = await window.projectConsole.projects.list()
  return projects.find((project) => project.id === projectId) ?? null
}

export function App() {
  const [, startBackgroundTransition] = useTransition()
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
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    loadSidebarWidth(
      window.localStorage,
      window.innerWidth <= 1080 ? COMPACT_SIDEBAR_WIDTH : DEFAULT_SIDEBAR_WIDTH
    )
  )
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const sidebarScrollRef = useRef<HTMLDivElement>(null)
  const sidebarResizeRef = useRef<{
    startX: number
    startWidth: number
    latestWidth: number
  } | null>(null)
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
  const [githubVisibility, setGithubVisibility] =
    useState<GitHubRepositoryVisibilityStatus | null>(null)
  const [githubVisibilityLoading, setGithubVisibilityLoading] = useState(false)
  const githubVisibilityRequest = useRef(0)
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
  const [workspaceTabRequest, setWorkspaceTabRequest] =
    useState<WorkspaceTabRequest | null>(null)
  const workspaceRequestSequence = useRef(0)
  const workspaceHistoryRef = useRef(
    loadWorkspaceHistory(window.localStorage)
  )
  const paneDestinationsRef = useRef<
    Record<WorkspacePane, WorkspaceDestination | null>
  >({ a: null, b: null })
  const focusedPaneRef = useRef<WorkspacePane>('a')
  const [workspaceSwitcher, setWorkspaceSwitcher] =
    useState<WorkspaceSwitcherState | null>(null)
  const workspaceSwitcherRef = useRef<WorkspaceSwitcherState | null>(null)
  const workspaceSwitcherReleaseRef = useRef<WorkspaceSwitcherReleaseGuard | null>(null)
  if (!workspaceSwitcherReleaseRef.current) {
    workspaceSwitcherReleaseRef.current = new WorkspaceSwitcherReleaseGuard(
      () => document.hasFocus() && !document.hidden
    )
  }
  useEffect(() => () => workspaceSwitcherReleaseRef.current?.reset(), [])
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
  const [transferTarget, setTransferTarget] = useState<{
    project: Project
    session: TerminalSession
  } | null>(null)
  const [sessionSort] = useSessionSort()
  const [projectSorts, setProjectSort] = useProjectSorts()
  const {
    recency: selectionRecency,
    recordProjectSelection,
    recordSessionSelection
  } = useSelectionRecency()
  const [
    collapsedProjectIds,
    toggleProjectCollapsed,
    expandSidebarProject
  ] = useCollapsedProjects()
  const [loading, setLoading] = useState(true)
  const [refreshingConnections, setRefreshingConnections] = useState(false)
  const [error, setError] = useState('')
  const refreshInFlightRef = useRef<Promise<void> | null>(null)
  const refreshQueuedRef = useRef(false)
  const projectRefreshesRef = useRef(new Map<string, Promise<void>>())
  const projectRefreshQueuedRef = useRef(new Set<string>())
  const metadataRefreshTimersRef = useRef(new Map<string, number>())

  useEffect(() => {
    if (!resizingSidebar) return

    function handlePointerMove(event: PointerEvent) {
      const resize = sidebarResizeRef.current
      if (!resize) return
      const width = clampSidebarWidth(
        resize.startWidth + event.clientX - resize.startX
      )
      resize.latestWidth = width
      setSidebarWidth(width)
    }

    function finishResize() {
      const resize = sidebarResizeRef.current
      if (resize) saveSidebarWidth(resize.latestWidth)
      sidebarResizeRef.current = null
      setResizingSidebar(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishResize)
    window.addEventListener('pointercancel', finishResize)
    window.addEventListener('blur', finishResize)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishResize)
      window.removeEventListener('pointercancel', finishResize)
      window.removeEventListener('blur', finishResize)
    }
  }, [resizingSidebar])

  function beginSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    sidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
      latestWidth: sidebarWidth
    }
    setResizingSidebar(true)
  }

  function resizeSidebarFromKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    let nextWidth = sidebarWidth
    if (event.key === 'ArrowLeft') nextWidth -= 24
    else if (event.key === 'ArrowRight') nextWidth += 24
    else if (event.key === 'Home') nextWidth = MIN_SIDEBAR_WIDTH
    else if (event.key === 'End') nextWidth = MAX_SIDEBAR_WIDTH
    else return

    event.preventDefault()
    const width = clampSidebarWidth(nextWidth)
    setSidebarWidth(width)
    saveSidebarWidth(width)
  }

  function resetSidebarWidth() {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
    saveSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
  }

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true
      await refreshInFlightRef.current
      return
    }
    do {
      refreshQueuedRef.current = false
      const startedAt = performance.now()
      const request = window.projectConsole.projects.list().then((nextProjects) => {
        startBackgroundTransition(() => setProjects(nextProjects))
        if (import.meta.env.DEV) {
          console.debug('[PanePilot performance] projects.list', {
            durationMs: Math.round(performance.now() - startedAt),
            payloadBytes: new Blob([JSON.stringify(nextProjects)]).size,
            projectCount: nextProjects.length
          })
        }
      })
      refreshInFlightRef.current = request
      try {
        await request
      } finally {
        refreshInFlightRef.current = null
      }
    } while (refreshQueuedRef.current)
  }, [startBackgroundTransition])

  const refreshProject = useCallback(
    async (projectId: string) => {
      const active = projectRefreshesRef.current.get(projectId)
      if (active) {
        projectRefreshQueuedRef.current.add(projectId)
        return active
      }
      const request = (async () => {
        do {
          projectRefreshQueuedRef.current.delete(projectId)
          const nextProject = await getRendererProject(projectId)
          startBackgroundTransition(() => {
            setProjects((current) => {
              if (!nextProject) {
                return current.filter((project) => project.id !== projectId)
              }
              const index = current.findIndex((project) => project.id === projectId)
              if (index < 0) return [...current, nextProject]
              const next = [...current]
              next[index] = nextProject
              return next
            })
          })
        } while (projectRefreshQueuedRef.current.delete(projectId))
      })().finally(() => {
        projectRefreshesRef.current.delete(projectId)
      })
      projectRefreshesRef.current.set(projectId, request)
      return request
    },
    [startBackgroundTransition]
  )

  const scheduleProjectRefresh = useCallback(
    (projectId: string) => {
      const existing = metadataRefreshTimersRef.current.get(projectId)
      if (existing != null) window.clearTimeout(existing)
      const timer = window.setTimeout(() => {
        metadataRefreshTimersRef.current.delete(projectId)
        void refreshProject(projectId)
      }, 80)
      metadataRefreshTimersRef.current.set(projectId, timer)
    },
    [refreshProject]
  )

  const acknowledgeSession = useCallback(async (sessionId: string) => {
    setProjects((current) =>
      current.map((project) => {
        const session = project.sessions.find((item) => item.id === sessionId)
        if (
          !session ||
          (session.state !== 'needs-attention' &&
            session.state !== 'response-ready')
        ) {
          return project
        }
        return withTerminalState(project, {
          sessionId,
          projectId: project.id,
          state: 'idle'
        })
      })
    )
    await window.projectConsole.terminals.acknowledge(sessionId)
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

  const handleWorkspaceTabRequest = useCallback((requestId: number) => {
    setWorkspaceTabRequest((current) =>
      consumeWorkspaceTabRequest(current, requestId)
    )
  }, [])

  const storeWorkspaceVisit = useCallback(
    (destination: WorkspaceDestination) => {
      const next = recordWorkspaceDestination(
        workspaceHistoryRef.current,
        destination
      )
      workspaceHistoryRef.current = next
      saveWorkspaceHistory(window.localStorage, next)
    },
    []
  )

  const handleWorkspaceDestination = useCallback(
    (pane: WorkspacePane, destination: WorkspaceDestination) => {
      paneDestinationsRef.current[pane] = destination
      if (focusedPaneRef.current === pane) storeWorkspaceVisit(destination)
    },
    [storeWorkspaceVisit]
  )

  const handlePaneAWorkspaceDestination = useCallback(
    (destination: WorkspaceDestination) =>
      handleWorkspaceDestination('a', destination),
    [handleWorkspaceDestination]
  )

  const handlePaneBWorkspaceDestination = useCallback(
    (destination: WorkspaceDestination) =>
      handleWorkspaceDestination('b', destination),
    [handleWorkspaceDestination]
  )

  useEffect(() => {
    focusedPaneRef.current = focusedPane
    const destination = paneDestinationsRef.current[focusedPane]
    if (destination) storeWorkspaceVisit(destination)
  }, [focusedPane, storeWorkspaceVisit])

  function nextWorkspaceRequest(
    projectId: string,
    pane: WorkspacePane
  ): WorkspaceRequest {
    workspaceRequestSequence.current += 1
    return { id: workspaceRequestSequence.current, projectId, pane }
  }

  function nextWorkspaceTabRequest(
    projectId: string,
    pane: WorkspacePane,
    tab: WorkspaceTabRequest['tab']
  ): WorkspaceTabRequest {
    workspaceRequestSequence.current += 1
    return { id: workspaceRequestSequence.current, projectId, pane, tab }
  }

  function updateWorkspaceSwitcher(next: WorkspaceSwitcherState | null) {
    // Yield menu accelerators during this held-modifier gesture so the
    // switcher can handle its own keys.
    const wasOpen = workspaceSwitcherRef.current != null
    const willOpen = next != null
    if (wasOpen !== willOpen) {
      workspaceSwitcherReleaseRef.current?.reset()
      window.projectConsole.workspaceHistory?.setSwitcherOpen(willOpen)
    }
    workspaceSwitcherRef.current = next
    setWorkspaceSwitcher(next)
  }

  function closeWorkspaceSwitcher() {
    if (workspaceSwitcherRef.current?.restoreSidebarCollapsed) {
      setSidebarOpen(false)
    }
    updateWorkspaceSwitcher(null)
  }

  const removingHistoryKey = workspaceSwitcher?.removingKey
  useEffect(() => {
    if (!removingHistoryKey) return
    const timer = window.setTimeout(() => {
      const current = workspaceSwitcherRef.current
      if (!current || current.removingKey !== removingHistoryKey) return
      const selectedKey = current.destinations[current.selectedIndex]?.key
      const currentDestination = current.destinations.find(
        (destination) => destination.key === current.currentKey
      ) ?? null
      const destinations = workspaceSwitcherDestinations(
        workspaceHistoryRef.current,
        currentDestination,
        projects
      )
      const retainedIndex = destinations.findIndex(
        (destination) => destination.key === selectedKey
      )
      updateWorkspaceSwitcher({
        ...current,
        destinations,
        selectedIndex: retainedIndex >= 0
          ? retainedIndex
          : Math.max(0, Math.min(current.selectedIndex, destinations.length - 1)),
        removingKey: null,
        hoveredKey: null
      })
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220)
    return () => window.clearTimeout(timer)
  }, [removingHistoryKey, projects])

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
    const removeStateListener = window.projectConsole.terminals.onState((event) => {
      startBackgroundTransition(() => {
        setProjects((current) =>
          current.map((project) => withTerminalState(project, event))
        )
      })
    })
    const removeMetadataListener = window.projectConsole.terminals.onMetadata((event) => {
      scheduleProjectRefresh(event.projectId)
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
      for (const timer of metadataRefreshTimersRef.current.values()) {
        window.clearTimeout(timer)
      }
      metadataRefreshTimersRef.current.clear()
    }
  }, [scheduleProjectRefresh, startBackgroundTransition])

  useEffect(() => {
    function cycleSwitcherView(
      direction: -1 | 1,
      event: KeyboardEvent
    ) {
      const current = workspaceSwitcherRef.current
      if (!current) return
      const mode = nextWorkspaceSwitcherMode(current.mode, direction)
      const highlighted = current?.destinations[current.selectedIndex] ?? null
      const paneDestination =
        paneDestinationsRef.current[focusedPaneRef.current]
      const sourceDestination = highlighted ?? paneDestination
      if (mode === 'recent') {
        const destinations = workspaceSwitcherDestinations(
          workspaceHistoryRef.current,
          paneDestination,
          projects
        )
        const preferredIndex = destinations.findIndex(
          (destination) => destination.key === highlighted?.key
        )
        updateWorkspaceSwitcher({
          ...current,
          mode,
          destinations,
          selectedIndex: preferredIndex >= 0 ? preferredIndex : Math.min(1, Math.max(0, destinations.length - 1)),
          currentKey: destinations[0]?.key === paneDestination?.key
            ? paneDestination?.key ?? null : null,
          projectId: null,
          hoveredKey: null
        })
        return
      }
      const projectId =
        highlighted?.projectId ??
        current?.projectId ??
        paneDestination?.projectId ??
        (focusedPaneRef.current === 'b' ? paneBProjectId : selectedProjectId)
      const project = projects.find(
        (candidate) => candidate.id === projectId && !candidate.archived
      )
      if (!project) return
      const destinations =
        mode === 'terminals'
          ? projectTerminalDestinations(project, workspaceHistoryRef.current, selectionRecency.sessions)
          : projectCapabilityDestinations(project)
      const preferredIndex = sourceDestination
        ? destinations.findIndex((destination) =>
            mode === 'terminals'
              ? destination.sessionId === sourceDestination.sessionId
              : destination.tab === sourceDestination.tab
          )
        : -1
      setSidebarOpen(true)
      updateWorkspaceSwitcher({
        destinations,
        selectedIndex: mode === 'capabilities' ? 0 : preferredIndex >= 0 ? preferredIndex : 0,
        modifier:
          current?.modifier ?? (event.metaKey ? 'Meta' : 'Control'),
        restoreSidebarCollapsed:
          current?.restoreSidebarCollapsed ?? !sidebarOpen,
        mode,
        projectId: project.id,
        currentKey: null,
        hoveredKey: null
      })
    }

    const handleShortcut = (event: KeyboardEvent) => {
      workspaceSwitcherReleaseRef.current?.observe(
        event, workspaceSwitcherRef.current?.modifier ?? null
      )
      if (event.isComposing) return
      const openSwitcher = workspaceSwitcherRef.current
      if (
        openSwitcher &&
        !event.altKey &&
        !event.shiftKey &&
        (event.code === 'KeyD' || event.key.toLocaleLowerCase() === 'd')
      ) {
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat || openSwitcher.removingKey) return
        const removableKey = workspaceHistoryRemovalTarget(openSwitcher)
        if (!removableKey) return
        const nextHistory = removeWorkspaceDestination(
          workspaceHistoryRef.current,
          removableKey
        )
        workspaceHistoryRef.current = nextHistory
        saveWorkspaceHistory(window.localStorage, nextHistory)
        updateWorkspaceSwitcher({
          ...openSwitcher,
          removingKey: removableKey,
          hoveredKey: null
        })
        return
      }
      const switcherArrow = workspaceSwitcherArrowAction(
        event,
        openSwitcher != null
      )
      if (switcherArrow) {
        event.preventDefault()
        event.stopPropagation()
        if (openSwitcher?.removingKey) return
        if (
          document.querySelector('[role="dialog"][aria-modal="true"]') != null
        ) {
          return
        }
        const current = workspaceSwitcherRef.current
        if (
          switcherArrow === 'previous-view' ||
          switcherArrow === 'next-view'
        ) {
          cycleSwitcherView(
            switcherArrow === 'previous-view' ? -1 : 1,
            event
          )
          return
        }
        if (current) {
          updateWorkspaceSwitcher({
            ...current,
            selectedIndex: nextWorkspaceSwitcherIndex(
              current.selectedIndex,
              current.destinations.length,
              switcherArrow === 'previous' ? -1 : 1
            )
          })
          return
        }
        const currentDestination =
          paneDestinationsRef.current[focusedPaneRef.current]
        const currentKey = currentDestination?.key ?? null
        const destinations = workspaceSwitcherDestinations(
          workspaceHistoryRef.current,
          currentDestination,
          projects
        )
        if (!destinations.length) return
        const renderedCurrentKey =
          destinations[0]?.key === currentKey ? currentKey : null
        setSidebarOpen(true)
        updateWorkspaceSwitcher({
          destinations,
          selectedIndex:
            renderedCurrentKey && destinations.length > 1 ? 1 : 0,
          modifier: event.metaKey ? 'Meta' : 'Control',
          restoreSidebarCollapsed: !sidebarOpen,
          mode: 'recent',
          projectId: null,
          currentKey: renderedCurrentKey,
          hoveredKey: null
        })
        return
      }
      if (event.repeat) return
      if (event.key === 'Escape' && workspaceSwitcherRef.current) {
        event.preventDefault()
        event.stopPropagation()
        closeWorkspaceSwitcher()
        return
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        ['+', '=', '-', '0'].includes(event.key)
      ) {
        event.preventDefault()
        event.stopPropagation()
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
    const handleShortcutRelease = (event: KeyboardEvent) => {
      const releasedSwitcher = workspaceSwitcherRef.current
      // Releasing during a deletion never opens the replacement row, even
      // if its swipe animation finishes before release confirmation.
      const wasRemoving = Boolean(releasedSwitcher?.removingKey)
      workspaceSwitcherReleaseRef.current?.observe(
        event, releasedSwitcher?.modifier ?? null, () => {
          const current = workspaceSwitcherRef.current
          if (!current) return
          if (wasRemoving || current.removingKey) {
            closeWorkspaceSwitcher()
            return
          }
          const destination = current.destinations[current.selectedIndex]
          closeWorkspaceSwitcher()
          if (destination) activateWorkspaceDestination(destination)
        }
      )
    }
    const cancelSwitcher = () => closeWorkspaceSwitcher()
    const handleVisibilityChange = () => {
      if (document.hidden) cancelSwitcher()
    }
    window.addEventListener('keydown', handleShortcut, true)
    window.addEventListener('keyup', handleShortcutRelease, true)
    window.addEventListener('blur', cancelSwitcher)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener('keydown', handleShortcut, true)
      window.removeEventListener('keyup', handleShortcutRelease, true)
      window.removeEventListener('blur', cancelSwitcher)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [
    splitOpen,
    selectedProjectId,
    selectedSessionId,
    paneBProjectId,
    paneBSessionId,
    showArchivedProjects,
    projects,
    selectionRecency.sessions,
    sidebarOpen
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
  const sidebarConnectionGroups = useMemo(
    () =>
      connections.flatMap((connection) => {
        const sort = projectSortFor(projectSorts, connection.id)
        const connectionProjects = sortProjects(
          activeProjects.filter(
            (candidate) => candidate.connectionId === connection.id
          ),
          sort,
          selectionRecency.projects,
          projectAttentionOrder
        )
        if (connection.kind === 'ssh' && connectionProjects.length === 0) {
          return []
        }
        return [
          {
            connection,
            sort,
            projects: connectionProjects.map((project) => ({
              project,
              sessions: sortSessions(
                project.sessions.filter(
                  (session) =>
                    !session.archived && isSidebarSession(session)
                ),
                sessionSort,
                selectionRecency.sessions
              )
            }))
          }
        ]
      }),
    [
      activeProjects,
      connections,
      projectAttentionOrder,
      projectSorts,
      selectionRecency.projects,
      selectionRecency.sessions,
      sessionSort
    ]
  )
  const sidebarActiveProjectId =
    splitOpen && focusedPane === 'b' ? paneBProjectId : selectedProjectId
  const sidebarActiveSessionId =
    splitOpen && focusedPane === 'b' ? paneBSessionId : selectedSessionId

  useEffect(() => {
    if (
      !sidebarOpen ||
      showArchivedProjects ||
      !sidebarActiveProjectId ||
      !sidebarActiveSessionId
    ) {
      return
    }
    expandSidebarProject(sidebarActiveProjectId)
  }, [
    expandSidebarProject,
    showArchivedProjects,
    sidebarActiveProjectId,
    sidebarActiveSessionId,
    sidebarOpen
  ])

  useEffect(() => {
    if (!sidebarOpen || showArchivedProjects || !sidebarActiveSessionId) return
    const frame = window.requestAnimationFrame(() => {
      const scrollArea = sidebarScrollRef.current
      if (!scrollArea) return
      const activeRow = Array.from(
        scrollArea.querySelectorAll<HTMLElement>('[data-sidebar-session-id]')
      ).find(
        (row) => row.dataset.sidebarSessionId === sidebarActiveSessionId
      )
      if (!activeRow) return
      const scrollBounds = scrollArea.getBoundingClientRect()
      const rowBounds = activeRow.getBoundingClientRect()
      const delta = sidebarRevealDelta(
        scrollBounds.top,
        scrollBounds.bottom,
        rowBounds.top,
        rowBounds.bottom
      )
      if (delta !== 0) scrollArea.scrollTop += delta
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    collapsedProjectIds,
    sidebarActiveSessionId,
    sidebarOpen,
    showArchivedProjects
  ])
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
      cacheProjectRead(gitStatusCache, projectId, nextStatus)
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
    setGitStatus(project ? gitStatusCache.get(project.id) ?? null : null)
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

  useEffect(() => {
    const projectId = project?.id
    const repositoryUrl = project?.repositoryUrl
    githubVisibilityRequest.current += 1
    const cached = projectId
      ? repositoryVisibilityCache.get(projectId) ?? null
      : null
    setGithubVisibility(cached)
    setGithubVisibilityLoading(
      Boolean(projectId && repositoryUrl && !showArchivedProjects && !cached)
    )
    if (!projectId || !repositoryUrl || showArchivedProjects) return
    const request = githubVisibilityRequest.current
    const refreshVisibility = () => {
      setGithubVisibilityLoading(true)
      void window.projectConsole.git
        .repositoryVisibility(projectId)
        .then((status) => {
          if (request === githubVisibilityRequest.current) {
            cacheProjectRead(repositoryVisibilityCache, projectId, status)
            setGithubVisibility(status)
          }
        })
        .catch(() => {
          if (request === githubVisibilityRequest.current) {
            setGithubVisibility(
              repositoryVisibilityCache.get(projectId) ?? null
            )
          }
        })
        .finally(() => {
          if (request === githubVisibilityRequest.current) {
            setGithubVisibilityLoading(false)
          }
        })
    }
    refreshVisibility()
    window.addEventListener('focus', refreshVisibility)
    return () => window.removeEventListener('focus', refreshVisibility)
  }, [project?.id, project?.repositoryUrl, showArchivedProjects])

  useEffect(
    () => () => {
      if (copiedPathTimer.current != null) {
        window.clearTimeout(copiedPathTimer.current)
      }
    },
    []
  )

  const visibleConnectionIds = useMemo(
    () =>
      [...new Set(
        [paneAConnection?.id, paneBConnection?.id].filter(
          (id): id is string => Boolean(id)
        )
      )].sort(),
    [paneAConnection?.id, paneBConnection?.id]
  )
  const visibleConnectionKey = visibleConnectionIds.join('\u0000')

  useEffect(() => {
    if (!visibleConnectionIds.length) return
    let active = true
    const timers: number[] = []
    const discover = async (connectionId: string) => {
      const startedAt = performance.now()
      try {
        const changes = await window.projectConsole.terminals.discover(connectionId)
        if (!active) return
        if (import.meta.env.DEV) {
          console.debug('[PanePilot performance] tmux discovery', {
            connectionId,
            durationMs: Math.round(performance.now() - startedAt),
            changes
          })
        }
        // Changed sessions emit targeted metadata/state events. A zero-change
        // scan intentionally does no renderer reconciliation at all.
      } catch {
        // Discovery is supplemental. An unavailable tmux server or SSH host
        // must not block the locally cached project and terminal workspace.
      }
    }
    for (const connectionId of visibleConnectionIds) {
      void discover(connectionId)
      timers.push(
        window.setInterval(() => void discover(connectionId), 15_000)
      )
    }
    return () => {
      active = false
      for (const timer of timers) window.clearInterval(timer)
    }
    // The stable key prevents a second scan when both panes share one machine.
  }, [visibleConnectionKey])

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
    if (import.meta.env.DEV && projectId) {
      performance.clearMarks(`panepilot:project-select:${pane}:${projectId}`)
      performance.mark(`panepilot:project-select:${pane}:${projectId}`)
      if (sessionId) {
        performance.clearMarks(`panepilot:terminal-select:${sessionId}`)
        performance.mark(`panepilot:terminal-select:${sessionId}`)
      }
    }
    if (pane === 'b') {
      setPaneBProjectId(projectId)
      setPaneBSessionId(sessionId)
    } else {
      setSelectedProjectId(projectId)
      setSelectedSessionId(sessionId)
    }
  }

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const selections: Array<['a' | 'b', string | null]> = [
      ['a', selectedProjectId],
      ['b', splitOpen ? paneBProjectId : null]
    ]
    const frame = window.requestAnimationFrame(() => {
      for (const [pane, projectId] of selections) {
        if (!projectId) continue
        const name = `panepilot:project-select:${pane}:${projectId}`
        const mark = performance.getEntriesByName(name, 'mark').at(-1)
        if (!mark) continue
        console.debug('[PanePilot performance] project painted', {
          pane,
          projectId,
          durationMs: Math.round(performance.now() - mark.startTime)
        })
        performance.clearMarks(name)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [paneBProjectId, selectedProjectId, splitOpen])

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
    if (defaultSessionId) {
      openSession(defaultSessionId)
      void acknowledgeSession(defaultSessionId)
    }
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
    await acknowledgeSession(sessionId)
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
    await refreshProject(projectId)
  }

  async function renameCurrentProject(name: string) {
    if (!project) return
    await window.projectConsole.projects.rename(project.id, name)
    await refreshProject(project.id)
  }

  async function promptRenameProject(target: Project) {
    setSidebarContext(null)
    setRenameTarget({ kind: 'project', project: target })
  }

  function promptTransferSession(owner: Project, session: TerminalSession) {
    setSidebarContext(null)
    setTransferTarget({ project: owner, session })
  }

  async function transferSessionToProject(targetProjectId: string) {
    if (!transferTarget) return
    const sessionId = transferTarget.session.id
    const sourceProjectId = transferTarget.project.id
    await window.projectConsole.terminals.transfer(sessionId, targetProjectId)
    setTransferTarget(null)
    await Promise.all([
      refreshProject(sourceProjectId),
      refreshProject(targetProjectId)
    ])
    await selectSession(targetProjectId, sessionId)
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
    await refreshProject(
      renameTarget.kind === 'project'
        ? renameTarget.project.id
        : renameTarget.session.projectId
    )
  }

  async function archiveProject(target: Project) {
    const activeSessions = target.sessions.filter(
      (session) => !['completed', 'error'].includes(session.state)
    )
    const stopNotice = activeSessions.length
      ? ` This will stop ${activeSessions.length} active ${activeSessions.length === 1 ? 'terminal or chat' : 'terminals and chats'}, including detached or hidden sessions.`
      : ''
    if (
      !window.confirm(
        `Archive “${target.name}”?${stopNotice} Saved output and provider conversation archives will be kept.`
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
    if (defaultSessionId) {
      openSession(defaultSessionId)
      void acknowledgeSession(defaultSessionId)
    }
  }

  async function selectSession(projectId: string, sessionId: string) {
    const pane = splitOpen && focusedPane === 'b' ? 'b' : 'a'
    recordProjectSelection(projectId)
    recordSessionSelection(sessionId)
    setShowArchivedProjects(false)
    focusPaneSelection(projectId, sessionId)
    openSession(sessionId)
    setOpenSessionRequest(nextWorkspaceRequest(projectId, pane))
    await acknowledgeSession(sessionId)
  }

  function activateWorkspaceDestination(
    destination: WorkspaceDestination
  ) {
    const pane: WorkspacePane =
      splitOpen && focusedPane === 'b' ? 'b' : 'a'
    const currentProjectId = pane === 'b' ? paneBProjectId : selectedProjectId
    const currentSessionId = pane === 'b' ? paneBSessionId : selectedSessionId
    const sessionId =
      destination.sessionId ??
      (currentProjectId === destination.projectId
        ? currentSessionId
        : defaultSessionIdFor(
            activeProjects.find(
              (candidate) => candidate.id === destination.projectId
            )
          ))

    recordProjectSelection(destination.projectId)
    if (destination.sessionId) {
      recordSessionSelection(destination.sessionId)
    }
    setShowArchivedProjects(false)
    applyPaneSelection(pane, destination.projectId, sessionId)
    paneDestinationsRef.current[pane] = destination
    storeWorkspaceVisit(destination)
    if (sessionId) {
      openSession(sessionId)
      void acknowledgeSession(sessionId)
    }
    setWorkspaceTabRequest(
      nextWorkspaceTabRequest(
        destination.projectId,
        pane,
        destination.tab
      )
    )
  }

  async function reconnectSession(projectId: string, session: TerminalSession) {
    await window.projectConsole.terminals.retryAttach(session.id, 100, 30)
    await selectSession(projectId, session.id)
  }

  async function togglePin(session: TerminalSession) {
    await window.projectConsole.terminals.setPinned(session.id, !session.pinned)
    await refreshProject(session.projectId)
  }

  async function toggleFlag(session: TerminalSession) {
    await window.projectConsole.terminals.setFlagged(
      session.id,
      !session.flagged
    )
    await refreshProject(session.projectId)
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
    await refreshProject(session.projectId)
  }

  async function archiveSession(session: TerminalSession) {
    await window.projectConsole.terminals.archive(session.id)
    await refreshProject(session.projectId)
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
    await refreshProject(session.projectId)
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
        id: 'transfer',
        label: 'Transfer session to project',
        icon: <FolderInput size={14} />,
        disabled: !activeProjects.some(
          (candidate) =>
            candidate.id !== owner.id &&
            candidate.connectionId === owner.connectionId
        ),
        action: () => promptTransferSession(owner, session)
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
  const localRepository = isOriginlessGitRepository(gitStatus)

  return (
    <div
      className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'} ${
        gitPaneVisible ? 'git-pane-open' : ''
      } ${resizingSidebar ? 'sidebar-resizing' : ''}`}
      style={
        {
          '--sidebar-preferred-width': `${sidebarWidth}px`
        } as CSSProperties
      }
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
          {project && (project.repositoryUrl || localRepository) && (
            <button
              className="secondary-button header-button repository-header-button"
              onClick={() => {
                if (localRepository) {
                  setGitPaneOpen((current) => !current)
                  return
                }
                void window.projectConsole.projects.openRepository(
                  project.repositoryUrl!
                )
              }}
              title={
                localRepository
                  ? `${gitPaneOpen ? 'Close' : 'Open'} Git pane · local repository with no origin remote`
                  : githubRepositoryVisibilityTitle(
                      githubVisibility,
                      githubVisibilityLoading
                    )
              }
            >
              {localRepository ? <GitBranch size={15} /> : <Github size={15} />}{' '}
              Repository
              {localRepository ? (
                <span className="repository-visibility-badge local">
                  <Laptop size={10} /> Local
                </span>
              ) : githubVisibility?.repository ? (
                <span
                  className={`repository-visibility-badge ${
                    githubVisibility.visibility ?? 'unknown'
                  }`}
                >
                  {githubVisibility.visibility === 'public' ? (
                    <Globe2 size={10} />
                  ) : githubVisibility.visibility === 'private' ? (
                    <LockKeyhole size={10} />
                  ) : githubVisibility.visibility === 'internal' ? (
                    <Building2 size={10} />
                  ) : null}
                  {githubVisibility.visibility
                    ? capitalize(githubVisibility.visibility)
                    : 'Unknown'}
                </span>
              ) : null}
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
        <div className="sidebar-scroll" ref={sidebarScrollRef}>
          {sidebarConnectionGroups.map(
            ({
              connection: item,
              sort: connectionSort,
              projects: connectionProjects
            }) => {
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
                {connectionProjects.map(
                  ({ project: candidate, sessions: visibleSessions }) => {
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
                              data-sidebar-session-id={session.id}
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
                  }
                )}
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
            }
          )}
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
        {workspaceSwitcher && (
          <WorkspaceSwitcherOverlay
            destinations={workspaceSwitcher.destinations}
            selectedIndex={workspaceSwitcher.selectedIndex}
            mode={workspaceSwitcher.mode}
            currentKey={workspaceSwitcher.currentKey}
            hoveredKey={workspaceSwitcher.hoveredKey}
            removingKey={workspaceSwitcher.removingKey ?? null}
            project={
              projects.find(
                (project) => project.id === workspaceSwitcher.projectId
              )
            }
            modifierLabel={
              workspaceSwitcher.modifier === 'Meta' ? '⌘' : 'Ctrl'
            }
            onHoverKey={(hoveredKey) => {
              const current = workspaceSwitcherRef.current
              if (!current || current.removingKey || current.hoveredKey === hoveredKey) return
              updateWorkspaceSwitcher({ ...current, hoveredKey })
            }}
          />
        )}
      </aside>

      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Resize project sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        aria-valuetext={`${sidebarWidth} pixels wide`}
        tabIndex={sidebarOpen ? 0 : -1}
        title="Drag to resize · Double-click to reset"
        onPointerDown={beginSidebarResize}
        onKeyDown={resizeSidebarFromKeyboard}
        onDoubleClick={resetSidebarWidth}
      />

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
                !splitOpen || focusedPane === 'a' ? 'focused' : ''
              }`}
              onMouseDownCapture={() => setFocusedPane('a')}
            >
              {paneAProject ? (
                <PaneWorkspaceStack
                  activeProject={paneAProject}
                  projects={activeProjects}
                  connections={connections}
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
                  workspaceTabRequest={workspaceTabRequestFor(
                    workspaceTabRequest,
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
                  onWorkspaceTabRequestHandled={handleWorkspaceTabRequest}
                  onWorkspaceDestinationVisited={
                    handlePaneAWorkspaceDestination
                  }
                  onSwapPanes={
                    splitOpen && paneAProject && paneBProject
                      ? swapPanes
                      : undefined
                  }
                  onTransferSession={(owner, session) =>
                    promptTransferSession(owner, session)
                  }
                  onSelectSession={(id) => {
                    setSelectedSessionId(id)
                    openSession(id)
                    void acknowledgeSession(id)
                  }}
                  onChanged={refreshProject}
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
                  <PaneWorkspaceStack
                    activeProject={paneBProject}
                    projects={activeProjects}
                    connections={connections}
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
                    workspaceTabRequest={workspaceTabRequestFor(
                      workspaceTabRequest,
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
                    onWorkspaceTabRequestHandled={handleWorkspaceTabRequest}
                    onWorkspaceDestinationVisited={
                      handlePaneBWorkspaceDestination
                    }
                    onSwapPanes={paneAProject ? swapPanes : undefined}
                    onTransferSession={(owner, session) =>
                      promptTransferSession(owner, session)
                    }
                    onSelectSession={(id) => {
                      setPaneBSessionId(id)
                      openSession(id)
                      void acknowledgeSession(id)
                    }}
                    onChanged={refreshProject}
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
          onChanged={() => refreshProject(project.id)}
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
          onChanged={() => refreshProject(temporaryChatProject.id)}
          onClose={() => setTemporaryChatPanel(null)}
        />
      )}
      {transferTarget && (
        <TransferSessionDialog
          session={transferTarget.session}
          sourceProject={transferTarget.project}
          projects={activeProjects}
          onTransfer={transferSessionToProject}
          onClose={() => setTransferTarget(null)}
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

function githubRepositoryVisibilityTitle(
  status: GitHubRepositoryVisibilityStatus | null,
  loading: boolean
): string {
  if (!status) {
    return loading ? 'Checking GitHub repository visibility…' : 'Open repository'
  }
  if (!status.repository) return status.message ?? 'Open repository'
  if (!status.visibility) {
    return status.message ?? `Visibility unavailable for ${status.repository}`
  }
  return `${status.repository} · ${capitalize(status.visibility)} GitHub repository`
}

function capitalize(value: string): string {
  return value ? `${value[0].toLocaleUpperCase()}${value.slice(1)}` : value
}

function projectGlyphTitle(name: string, left: boolean, right: boolean): string {
  if (left && right) return `Change ${name} icon · Open in both panes`
  if (left) return `Change ${name} icon · Open in the left pane`
  if (right) return `Change ${name} icon · Open in the right pane`
  return `Change ${name} icon`
}
