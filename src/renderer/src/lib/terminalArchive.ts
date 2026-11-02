import type { Project, TerminalSession } from '@shared/types'

export function archivedTerminals(project: Project): TerminalSession[] {
  return project.sessions.filter((session) => session.projectId === project.id && session.kind === 'terminal' && session.archived)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
}

export async function requestTerminalArchive(session: TerminalSession): Promise<boolean> {
  if (session.kind !== 'terminal' || session.archived) return false
  if (!window.confirm(`Archive “${session.name}”? Its terminal/tmux session will be stopped if it is still running. Saved output and provider conversation archives will be kept. You can restore the tab later.`)) return false
  await window.projectConsole.terminals.archive(session.id)
  return true
}
