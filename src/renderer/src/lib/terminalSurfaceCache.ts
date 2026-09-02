import type { Project, TerminalSession } from '@shared/types'

export const MAX_WARM_TERMINALS_PER_PANE = 4

export interface TerminalSurfaceCacheEntry {
  projectId: string
  projectFolder: string
  session: TerminalSession
}

export interface TerminalSurfaceCacheController {
  views: TerminalSurfaceCacheEntry[]
  retain(view: TerminalSurfaceCacheEntry): void
}

export function retainTerminalSurface(
  current: TerminalSurfaceCacheEntry[],
  view: TerminalSurfaceCacheEntry,
  limit = MAX_WARM_TERMINALS_PER_PANE
): TerminalSurfaceCacheEntry[] {
  const retained = current.filter(
    (candidate) => candidate.session.id !== view.session.id
  )
  retained.push(view)
  return retained.slice(-Math.max(1, limit))
}

export function reconcileTerminalSurfaces(
  current: TerminalSurfaceCacheEntry[],
  projects: Project[]
): TerminalSurfaceCacheEntry[] {
  const latestProjects = new Map(projects.map((project) => [project.id, project]))
  let changed = false
  const next = current.flatMap((view): TerminalSurfaceCacheEntry[] => {
    const project = latestProjects.get(view.projectId)
    const session = project?.sessions.find(
      (candidate) =>
        candidate.id === view.session.id &&
        candidate.kind === 'terminal' &&
        !candidate.archived
    )
    if (!project || !session) {
      changed = true
      return []
    }
    if (project.folder !== view.projectFolder || session !== view.session) {
      changed = true
      return [{
        projectId: project.id,
        projectFolder: project.folder,
        session
      }]
    }
    return [view]
  })
  return changed ? next : current
}
