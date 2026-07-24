import type { AgentState } from '@shared/types'
import { stateLabels } from '../lib/status'

export function StatusDot({ state, compact = false }: { state: AgentState; compact?: boolean }) {
  return (
    <span className={`status-chip status-${state} ${compact ? 'compact' : ''}`}>
      <span className="status-dot" aria-hidden="true" />
      {!compact && stateLabels[state]}
    </span>
  )
}
