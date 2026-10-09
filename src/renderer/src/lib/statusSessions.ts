import type { Project, TerminalSession } from '@shared/types'
export type StatusSessionFilter = 'working' | 'attention' | 'needs-input' | 'blocked'
export interface StatusSessionEntry { project: Project; session: TerminalSession }

export const statusSessionFilters: Array<{ id: StatusSessionFilter; title: string; label: string; state: TerminalSession['state']; dot: string; hideEmpty: boolean }> = [
  { id: 'working', title: 'Working terminals', label: 'working', state: 'running', dot: 'running', hideEmpty: false },
  { id: 'attention', title: 'Responses ready', label: 'response ready', state: 'response-ready', dot: 'response-ready', hideEmpty: true },
  { id: 'needs-input', title: 'Needs input', label: 'needs input', state: 'needs-input', dot: 'attention', hideEmpty: true },
  { id: 'blocked', title: 'Blocked', label: 'blocked', state: 'needs-attention', dot: 'blocked', hideEmpty: true }
]

/** Separate turn states without changing their backend lifecycle semantics. */
export function statusSessions(projects: Project[], filter: StatusSessionFilter): StatusSessionEntry[] {
  const state = statusSessionFilters.find((item) => item.id === filter)!.state
  return projects.filter((project) => !project.archived).flatMap((project) =>
    project.sessions.filter((session) => !session.archived && session.state === state)
      .map((session) => ({ project, session })))
}

export function statusSessionTab(session: TerminalSession): 'actions' | 'qna' | 'manuscript' | null {
  if (session.kind === 'action') return 'actions'
  if (session.kind === 'project-qna') return 'qna'
  if (session.kind === 'latex-chat' && session.latexChat?.purpose === 'inline-edit') return 'manuscript'
  return null
}
