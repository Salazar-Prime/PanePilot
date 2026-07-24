import type { AgentState } from '@shared/types'

export const stateLabels: Record<AgentState, string> = {
  idle: 'Ready',
  running: 'Working',
  'needs-input': 'Needs input',
  'response-ready': 'Response ready',
  'needs-attention': 'Needs attention',
  completed: 'Stopped',
  error: 'Error'
}

export function isAttentionState(state: AgentState): boolean {
  return state === 'needs-input' || state === 'needs-attention' || state === 'response-ready'
}
