import type { AgentState } from '../shared/types'

const ACTION_REQUIRED =
  /\b(action required|approval required|permission required|needs input|waiting for (?:approval|input)|confirm to continue)\b/i
const RUNNING = /\b(working|thinking)\b/i
const READY = /\bready\b/i
const FULL_THREAD_ID =
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/i
const TRUNCATED_THREAD_ID =
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{5,8})\.\.\./i

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

/**
 * Codex's `thread-id` terminal-title item contains the current UUID. Codex
 * bounds each title segment, so current releases render a long UUID as a
 * collision-resistant prefix followed by `...`. The prefix is resolved
 * against the provider's project-scoped archive before PanePilot stores the
 * complete ID.
 */
export function codexThreadReferenceFromPaneTitle(
  paneTitle: string
): string | null {
  return (
    (
      paneTitle.match(FULL_THREAD_ID)?.[1] ??
      paneTitle.match(TRUNCATED_THREAD_ID)?.[1]
    )?.toLowerCase() ?? null
  )
}
