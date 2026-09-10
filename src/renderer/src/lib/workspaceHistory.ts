import type { AgentState, Project, ProjectType } from '@shared/types'
import type { WorkspacePane, WorkspaceRequest } from './workspaceRequest'

export const WORKSPACE_HISTORY_STORAGE_KEY =
  'panepilot.workspace-history.v1'
export const WORKSPACE_HISTORY_LIMIT = 20
export const WORKSPACE_SWITCHER_LIMIT = 7

export type WorkspaceTabId =
  | 'terminal'
  | 'manuscript'
  | 'pdf'
  | 'actions'
  | 'qna'
  | 'notes'
  | 'files'
  | 'chats'
  | 'activity'

export interface WorkspaceDestination {
  key: string
  projectId: string
  projectName: string
  projectIcon?: string | null
  projectType: ProjectType
  tab: WorkspaceTabId
  tabLabel: string
  sessionId: string | null
  sessionName: string | null
  terminalState?: AgentState | null
  terminalFlagged?: boolean
  visitedAt: number
}

export type WorkspaceTerminalIndicator = 'working' | 'attention' | null
export type WorkspaceSwitcherArrowAction =
  | 'previous'
  | 'next'
  | 'previous-view'
  | 'next-view'

export type WorkspaceSwitcherMode = 'recent' | 'capabilities' | 'terminals'

export function nextWorkspaceSwitcherMode(
  mode: WorkspaceSwitcherMode,
  direction: -1 | 1
): WorkspaceSwitcherMode {
  const modes: WorkspaceSwitcherMode[] = ['recent', 'capabilities', 'terminals']
  return modes[(modes.indexOf(mode) + direction + modes.length) % modes.length]
}

export interface WorkspaceTabRequest extends WorkspaceRequest {
  tab: WorkspaceTabId
}

const tabLabels: Record<WorkspaceTabId, string> = {
  terminal: 'Terminals',
  manuscript: 'Manuscript',
  pdf: 'PDF preview',
  actions: 'Actions',
  qna: 'Project Q&A',
  notes: 'Notes',
  files: 'Files',
  chats: 'LLM Chats',
  activity: 'Activity'
}

const terminalTabs = new Set<WorkspaceTabId>([
  'terminal',
  'actions',
  'qna',
  'notes',
  'files',
  'chats',
  'activity'
])

const latexTabs = new Set<WorkspaceTabId>([
  'manuscript',
  'pdf',
  'actions',
  'qna',
  'notes',
  'files',
  'chats',
  'activity'
])

const agentStates = new Set<AgentState>([
  'idle',
  'running',
  'needs-input',
  'response-ready',
  'needs-attention',
  'completed',
  'error'
])

export function workspaceTabLabel(tab: WorkspaceTabId): string {
  return tabLabels[tab]
}

export function workspaceDestinationKey(
  projectId: string,
  tab: WorkspaceTabId,
  sessionId: string | null = null
): string {
  return `${projectId}\u0000${tab}\u0000${sessionId ?? ''}`
}

export function createWorkspaceDestination(input: {
  project: Project
  tab: WorkspaceTabId
  sessionId?: string | null
  sessionName?: string | null
  visitedAt?: number
}): WorkspaceDestination {
  const sessionId = input.sessionId ?? null
  const session = sessionId
    ? input.project.sessions.find((candidate) => candidate.id === sessionId)
    : null
  return {
    key: workspaceDestinationKey(input.project.id, input.tab, sessionId),
    projectId: input.project.id,
    projectName: input.project.name,
    projectIcon: input.project.icon,
    projectType: input.project.type,
    tab: input.tab,
    tabLabel: workspaceTabLabel(input.tab),
    sessionId,
    sessionName: input.sessionName ?? session?.name ?? null,
    terminalState:
      input.tab === 'terminal' && session?.kind === 'terminal'
        ? session.state
        : null,
    terminalFlagged:
      input.tab === 'terminal' && session?.kind === 'terminal'
        ? session.flagged
        : false,
    visitedAt: input.visitedAt ?? Date.now()
  }
}

export function recordWorkspaceDestination(
  history: WorkspaceDestination[],
  destination: WorkspaceDestination
): WorkspaceDestination[] {
  return [
    destination,
    ...history.filter((item) => item.key !== destination.key)
  ].slice(0, WORKSPACE_HISTORY_LIMIT)
}

export function removeWorkspaceDestination(
  history: WorkspaceDestination[],
  key: string
): WorkspaceDestination[] {
  return history.filter((destination) => destination.key !== key)
}

export function workspaceHistoryRemovalTarget(input: {
  mode: 'recent' | 'terminals' | 'capabilities'
  currentKey: string | null
  hoveredKey: string | null
  selectedIndex: number
  destinations: WorkspaceDestination[]
}): string | null {
  if (input.mode !== 'recent') return null
  const key = input.hoveredKey ?? input.destinations[input.selectedIndex]?.key
  return key && key !== input.currentKey &&
    input.destinations.some((destination) => destination.key === key)
    ? key
    : null
}

function isSupportedTab(projectType: ProjectType, tab: WorkspaceTabId): boolean {
  return (projectType === 'latex' ? latexTabs : terminalTabs).has(tab)
}

function hydrateDestination(
  destination: WorkspaceDestination,
  project: Project
): WorkspaceDestination | null {
  if (!isSupportedTab(project.type, destination.tab)) return null
  if (!destination.sessionId) {
    return {
      ...destination,
      projectName: project.name,
      projectIcon: project.icon,
      projectType: project.type,
      tabLabel: workspaceTabLabel(destination.tab),
      terminalState: null,
      terminalFlagged: false
    }
  }

  const session = project.sessions.find(
    (candidate) =>
      candidate.id === destination.sessionId && !candidate.archived
  )
  if (!session) return null
  return {
    ...destination,
    projectName: project.name,
    projectIcon: project.icon,
    projectType: project.type,
    tabLabel: workspaceTabLabel(destination.tab),
    sessionName: session.name,
    terminalState:
      destination.tab === 'terminal' && session.kind === 'terminal'
        ? session.state
        : null,
    terminalFlagged:
      destination.tab === 'terminal' && session.kind === 'terminal'
        ? session.flagged
        : false
  }
}

export function projectTerminalDestinations(
  project: Project,
  history: WorkspaceDestination[] = [],
  selectionRecency: Record<string, number> = {}
): WorkspaceDestination[] {
  if (project.archived) return []
  const ranks = new Map<string, number>()
  for (const destination of history) {
    if (destination.projectId !== project.id || destination.tab !== 'terminal' ||
      !destination.sessionId || ranks.has(destination.sessionId)) continue
    ranks.set(destination.sessionId, ranks.size)
  }
  return project.sessions
    .filter((session) => session.kind === 'terminal' && !session.archived)
    .sort((left, right) => {
      const rankOrder = (ranks.get(left.id) ?? Infinity) - (ranks.get(right.id) ?? Infinity)
      if (!Number.isNaN(rankOrder) && rankOrder !== 0) return rankOrder
      return (selectionRecency[right.id] ?? 0) - (selectionRecency[left.id] ?? 0) ||
        Date.parse(right.createdAt) - Date.parse(left.createdAt)
    })
    .map((session) =>
      createWorkspaceDestination({
        project,
        tab: 'terminal',
        sessionId: session.id,
        sessionName: session.name
      })
    )
}

export function projectCapabilityDestinations(
  project: Project
): WorkspaceDestination[] {
  if (project.archived) return []
  const tabs: WorkspaceTabId[] =
    project.type === 'latex'
      ? [
          'manuscript',
          'pdf',
          'actions',
          'qna',
          'notes',
          'files',
          'chats',
          'activity'
        ]
      : ['terminal', 'actions', 'qna', 'notes', 'files', 'chats', 'activity']
  return tabs.map((tab) => createWorkspaceDestination({ project, tab }))
}

export function workspaceTerminalIndicator(
  destination: WorkspaceDestination
): WorkspaceTerminalIndicator {
  if (destination.tab !== 'terminal' || !destination.sessionId) return null
  if (destination.terminalState === 'running') return 'working'
  if (
    destination.terminalState === 'needs-input' ||
    destination.terminalState === 'needs-attention'
  ) {
    return 'attention'
  }
  return null
}

export function recentWorkspaceDestinations(
  history: WorkspaceDestination[],
  currentKey: string | null,
  projects: Project[],
  limit = WORKSPACE_SWITCHER_LIMIT
): WorkspaceDestination[] {
  const projectsById = new Map(
    projects
      .filter((project) => !project.archived)
      .map((project) => [project.id, project])
  )
  const result: WorkspaceDestination[] = []
  for (const destination of history) {
    if (destination.key === currentKey) continue
    const project = projectsById.get(destination.projectId)
    if (!project) continue
    const hydrated = hydrateDestination(destination, project)
    if (!hydrated) continue
    result.push(hydrated)
    if (result.length >= limit) break
  }
  return result
}

export function workspaceSwitcherDestinations(
  history: WorkspaceDestination[],
  current: WorkspaceDestination | null,
  projects: Project[],
  historyLimit = WORKSPACE_SWITCHER_LIMIT
): WorkspaceDestination[] {
  const currentProject = current
    ? projects.find(
        (project) => project.id === current.projectId && !project.archived
      )
    : null
  const hydratedCurrent =
    current && currentProject
      ? hydrateDestination(current, currentProject)
      : null
  const recent = recentWorkspaceDestinations(
    history,
    hydratedCurrent?.key ?? current?.key ?? null,
    projects,
    historyLimit
  )
  return hydratedCurrent ? [hydratedCurrent, ...recent] : recent
}

export function nextWorkspaceSwitcherIndex(
  selectedIndex: number,
  destinationCount: number,
  direction: -1 | 1 = 1
): number {
  return destinationCount > 0
    ? (selectedIndex + direction + destinationCount) % destinationCount
    : 0
}

export function workspaceSwitcherArrowAction(
  event: Pick<
    KeyboardEvent,
    'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'code'
  >,
  switcherOpen: boolean
): WorkspaceSwitcherArrowAction | null {
  if (
    (!event.metaKey && !event.ctrlKey) ||
    event.altKey ||
    event.shiftKey
  ) {
    return null
  }
  if (event.code === 'ArrowUp') return 'previous'
  if (event.code === 'ArrowDown') return 'next'
  if (!switcherOpen) return null
  if (event.code === 'ArrowLeft') return 'previous-view'
  if (event.code === 'ArrowRight') return 'next-view'
  return null
}

export function loadWorkspaceHistory(
  storage: Pick<Storage, 'getItem'>
): WorkspaceDestination[] {
  try {
    const raw = storage.getItem(WORKSPACE_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return uniqueWorkspaceDestinations(parsed.filter(isWorkspaceDestination))
  } catch {
    return []
  }
}

export function saveWorkspaceHistory(
  storage: Pick<Storage, 'setItem'>,
  history: WorkspaceDestination[]
): void {
  try {
    storage.setItem(
      WORKSPACE_HISTORY_STORAGE_KEY,
      JSON.stringify(uniqueWorkspaceDestinations(history))
    )
  } catch {
    // Navigation history is a convenience and must never block the workspace.
  }
}

function uniqueWorkspaceDestinations(
  history: WorkspaceDestination[]
): WorkspaceDestination[] {
  const seen = new Set<string>()
  const unique: WorkspaceDestination[] = []
  for (const destination of history) {
    if (seen.has(destination.key)) continue
    seen.add(destination.key)
    unique.push(destination)
    if (unique.length >= WORKSPACE_HISTORY_LIMIT) break
  }
  return unique
}

function isWorkspaceDestination(value: unknown): value is WorkspaceDestination {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<WorkspaceDestination>
  return (
    typeof item.key === 'string' &&
    typeof item.projectId === 'string' &&
    typeof item.projectName === 'string' &&
    (item.projectIcon == null || typeof item.projectIcon === 'string') &&
    (item.projectType === 'terminal' || item.projectType === 'latex') &&
    typeof item.tab === 'string' &&
    Object.prototype.hasOwnProperty.call(tabLabels, item.tab) &&
    typeof item.tabLabel === 'string' &&
    (item.sessionId == null || typeof item.sessionId === 'string') &&
    (item.sessionName == null || typeof item.sessionName === 'string') &&
    (item.terminalState == null ||
      agentStates.has(item.terminalState as AgentState)) &&
    (item.terminalFlagged == null || typeof item.terminalFlagged === 'boolean') &&
    typeof item.visitedAt === 'number' &&
    Number.isFinite(item.visitedAt)
  )
}

export function workspaceTabRequestFor(
  request: WorkspaceTabRequest | null,
  projectId: string,
  pane: WorkspacePane
): WorkspaceTabRequest | null {
  return request?.projectId === projectId && request.pane === pane
    ? request
    : null
}

export function consumeWorkspaceTabRequest(
  request: WorkspaceTabRequest | null,
  requestId: number
): WorkspaceTabRequest | null {
  return request?.id === requestId ? null : request
}
