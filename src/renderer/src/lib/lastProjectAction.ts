import type { Project, ProjectAction, TerminalSession } from '@shared/types'
import { orderProjectActions } from './actionOrder'

export interface LastProjectAction {
  action: ProjectAction
  session: TerminalSession | null
  source: 'last-run' | 'first'
}

/** Definition edits, selection and output timestamps never count as execution. */
export function lastProjectAction(project: Project | null, savedOrder: string[] = []): LastProjectAction | null {
  if (!project || project.archived) return null
  const actions = orderProjectActions(project.actions.filter((action) => action.projectId === project.id), savedOrder)
  const sessions = new Map(project.sessions.map((session) => [session.id, session]))
  let latest: LastProjectAction | null = null
  let latestAt = -Infinity
  for (const action of actions) {
    if (!action.lastSessionId) continue
    const session = sessions.get(action.lastSessionId)
    if (!session || session.projectId !== project.id || session.kind !== 'action' || session.archived) continue
    const at = Date.parse(session.createdAt)
    if (!Number.isFinite(at)) continue
    if (at > latestAt || (at === latestAt && action.id.localeCompare(latest!.action.id) < 0)) {
      latest = { action, session, source: 'last-run' }
      latestAt = at
    }
  }
  return latest ?? (actions[0] ? { action: actions[0], session: null, source: 'first' } : null)
}

export function actionRunActive(session: TerminalSession | null): boolean {
  return !!session && !['completed', 'error'].includes(session.state)
}
