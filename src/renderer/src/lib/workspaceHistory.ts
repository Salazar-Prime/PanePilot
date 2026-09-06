import type { Project, ProjectType } from '@shared/types'
import type { WorkspacePane, WorkspaceRequest } from './workspaceRequest'

export const WORKSPACE_HISTORY_STORAGE_KEY =
  'panepilot.workspace-history.v1'
export const WORKSPACE_HISTORY_LIMIT = 40
export const WORKSPACE_SWITCHER_LIMIT = 5

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
  projectType: ProjectType
  tab: WorkspaceTabId
  tabLabel: string
  sessionId: string | null
  sessionName: string | null
  visitedAt: number
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
  return {
    key: workspaceDestinationKey(input.project.id, input.tab, sessionId),
    projectId: input.project.id,
    projectName: input.project.name,
    projectType: input.project.type,
    tab: input.tab,
    tabLabel: workspaceTabLabel(input.tab),
    sessionId,
    sessionName: input.sessionName ?? null,
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
      projectType: project.type,
      tabLabel: workspaceTabLabel(destination.tab)
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
    projectType: project.type,
    tabLabel: workspaceTabLabel(destination.tab),
    sessionName: session.name
  }
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

export function nextWorkspaceSwitcherIndex(
  selectedIndex: number,
  destinationCount: number
): number {
  return destinationCount > 0
    ? (selectedIndex + 1) % destinationCount
    : 0
}

export function loadWorkspaceHistory(
  storage: Pick<Storage, 'getItem'>
): WorkspaceDestination[] {
  try {
    const raw = storage.getItem(WORKSPACE_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isWorkspaceDestination)
      .slice(0, WORKSPACE_HISTORY_LIMIT)
  } catch {
    return []
  }
}

export function saveWorkspaceHistory(
  storage: Pick<Storage, 'setItem'>,
  history: WorkspaceDestination[]
): void {
  try {
    storage.setItem(WORKSPACE_HISTORY_STORAGE_KEY, JSON.stringify(history))
  } catch {
    // Navigation history is a convenience and must never block the workspace.
  }
}

function isWorkspaceDestination(value: unknown): value is WorkspaceDestination {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<WorkspaceDestination>
  return (
    typeof item.key === 'string' &&
    typeof item.projectId === 'string' &&
    typeof item.projectName === 'string' &&
    (item.projectType === 'terminal' || item.projectType === 'latex') &&
    typeof item.tab === 'string' &&
    Object.prototype.hasOwnProperty.call(tabLabels, item.tab) &&
    typeof item.tabLabel === 'string' &&
    (item.sessionId == null || typeof item.sessionId === 'string') &&
    (item.sessionName == null || typeof item.sessionName === 'string') &&
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
