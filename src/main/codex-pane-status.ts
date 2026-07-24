import type { AgentState } from '../shared/types'

const ACTION_REQUIRED =
  /\b(action required|approval required|permission required|needs input|waiting for (?:approval|input)|confirm to continue)\b/i
const RUNNING = /\b(working|thinking)\b/i
const READY = /\bready\b/i

/**
 * Codex exposes `activity`, `run-state`, and `task-progress` as TUI title
 * items. PanePilot mirrors those items into the tmux pane title so a second
 * laptop can recover the latest snapshot without consuming an event stream.
 */
export function codexStateFromPaneTitle(
  paneTitle: string,
  previous: AgentState
): AgentState | null {
  const title = paneTitle.trim()
  if (!title) return null
  if (ACTION_REQUIRED.test(title)) return 'needs-input'
  if (RUNNING.test(title)) return 'running'
  if (!READY.test(title)) return null
  if (previous === 'needs-input') return 'needs-input'
  if (previous === 'running') return 'response-ready'
  if (previous === 'completed' || previous === 'error') return 'idle'
  return null
}
