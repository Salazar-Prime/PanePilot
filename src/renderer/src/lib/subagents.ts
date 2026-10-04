import type { Project, TerminalSession } from '@shared/types'
import type { WorkspaceDestination } from './workspaceHistory'

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
