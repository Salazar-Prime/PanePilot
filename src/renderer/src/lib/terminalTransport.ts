import type {
  Project,
  TerminalSession,
  TerminalTransportState
} from '@shared/types'

export function shouldOfferTmuxReconnect(
  project: Project,
  session: TerminalSession,
  transportState?: TerminalTransportState
): boolean {
  if (session.backend !== 'tmux' || !session.tmuxName) return false
  if (transportState === 'detached' || transportState === 'offline') return true
  if (!['completed', 'error'].includes(session.state)) return false

  const latestSessionActivity = project.activities.find(
    (activity) => activity.sessionId === session.id
  )
  return latestSessionActivity?.message.includes(
    'is no longer running in tmux.'
  ) ?? false
}
