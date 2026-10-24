import type { CodexSubagent, Project, TerminalSession } from '@shared/types'
import type { WorkspaceDestination } from './workspaceHistory'

/** Status changes may move a card; new output and archive timestamps never do. */
export function orderSubagents(agents: CodexSubagent[]): CodexSubagent[] {
  const priority = { working: 0, unknown: 1, finished: 2, stopped: 2 }
  return [...agents].sort((a, b) => priority[a.state] - priority[b.state] ||
    (a.path || a.name).localeCompare(b.path || b.name, undefined, { numeric: true }) ||
    a.id.localeCompare(b.id))
}

/** No remembered-session fallback: the visible destination must identify this exact chat. */
export function visibleCodexSession(
  project: Project | null,
  destination: WorkspaceDestination | null,
  selectedSessionId: string | null
): TerminalSession | null {
  if (!project || project.archived || destination?.projectId !== project.id ||
    !destination.sessionId || destination.sessionId !== selectedSessionId) return null
  return project.sessions.find((s) => s.id === destination.sessionId && !s.archived &&
    s.profile === 'codex' && (s.kind === 'terminal' ||
      (s.kind === 'latex-chat' && s.latexChat?.purpose === 'writing'))) ?? null
}
