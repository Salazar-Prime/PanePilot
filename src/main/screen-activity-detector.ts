import type { AgentState } from '../shared/types'

const WORKING_INDICATOR = /\besc\s+to\s+interrupt\b/i

/**
 * Tracks one agent turn using only its rendered terminal screen.
 *
 * The detector arms when Codex or Claude renders "esc to interrupt". Once an
 * armed screen no longer contains that text, the turn has stopped and needs
 * the user's attention. It does not infer any state before seeing the marker.
 */
export class ScreenActivityDetector {
  private workingIndicatorSeen = false

  inspect(screenText: string): AgentState | null {
    if (WORKING_INDICATOR.test(screenText)) {
      this.workingIndicatorSeen = true
      return 'running'
    }
    if (this.workingIndicatorSeen) {
      this.workingIndicatorSeen = false
      return 'needs-attention'
    }
    return null
  }
}

export function acknowledgedAgentState(state: AgentState): AgentState {
  return state === 'needs-attention' || state === 'response-ready' ? 'idle' : state
}
