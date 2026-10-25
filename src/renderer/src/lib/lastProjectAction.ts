import type { Project, ProjectAction, TerminalSession } from '@shared/types'

export interface LastProjectAction { action: ProjectAction; session: TerminalSession }

/** Run creation time, not selection, definition edits, output updates, or manual card order. */
export function lastProjectAction(project: Project | null): LastProjectAction | null {
  if (!project || project.archived) return null
  const sessions = new Map(project.sessions.map((session) => [session.id, session]))
  let latest: LastProjectAction | null = null
  let latestAt = -Infinity
  for (const action of project.actions) {
    if (action.projectId !== project.id || !action.lastSessionId) continue
    const session = sessions.get(action.lastSessionId)
    if (!session || session.projectId !== project.id || session.kind !== 'action' || session.archived) continue
    const at = Date.parse(session.createdAt)
    if (!Number.isFinite(at)) continue
    if (at > latestAt || (at === latestAt && action.id.localeCompare(latest!.action.id) < 0)) {
      latest = { action, session }
      latestAt = at
    }
  }
  return latest
}

export function actionRunActive(session: TerminalSession): boolean {
  return !['completed', 'error'].includes(session.state)
}

/** Both entry points capture an exact project/action; deferred palette execution cannot retarget. */
export function lastProjectActionCommand(project: Project | null, pending: boolean,
  run: (projectId: string, actionId: string) => Promise<unknown>) {
  const last = lastProjectAction(project)
  if (!project || !last || pending || actionRunActive(last.session)) return null
  const projectId = project.id, actionId = last.action.id
  return {
    id: `project:${projectId}:run-last-action`, section: 'Current project', label: 'Run last action',
    detail: `${project.name} · ${last.action.name} · ${last.action.command}`,
    keywords: ['project', 'rerun', 'repeat', 'execute', last.action.name, last.action.command],
    action: async () => { await run(projectId, actionId) }
  }
}
