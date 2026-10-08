import type { Project, TerminalSession } from '@shared/types'
import { isAttentionState } from './status'

export type StatusSessionFilter = 'working' | 'attention'
export interface StatusSessionEntry { project: Project; session: TerminalSession }

/** Counts and jump targets share the existing status-bar lifecycle semantics. */
export function statusSessions(projects: Project[], filter: StatusSessionFilter): StatusSessionEntry[] {
  return projects.filter((project) => !project.archived).flatMap((project) =>
    project.sessions.filter((session) => !session.archived &&
      (filter === 'working' ? session.state === 'running' : isAttentionState(session.state)))
      .map((session) => ({ project, session })))
}

export function statusSessionTab(session: TerminalSession): 'actions' | 'qna' | 'manuscript' | null {
  if (session.kind === 'action') return 'actions'
  if (session.kind === 'project-qna') return 'qna'
  if (session.kind === 'latex-chat' && session.latexChat?.purpose === 'inline-edit') return 'manuscript'
  return null
}
