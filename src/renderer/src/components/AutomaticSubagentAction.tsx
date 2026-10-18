import { GitFork } from 'lucide-react'
import { useSubagentPresence } from '../lib/useSubagentPresence'

/** Explicit pins own their own persistent button; this is only the contextual shortcut. */
export function AutomaticSubagentAction({ sessionId, providerSessionId, pinned, active, onToggle }: {
  sessionId: string | null
  providerSessionId: string | null
  pinned: boolean
  active: boolean
  onToggle(): void
}) {
  const present = useSubagentPresence(pinned ? null : sessionId, providerSessionId)
  if (pinned || !present) return null
  return <button className="icon-button" aria-label="Sub-agents" title="Sub-agents"
    aria-pressed={active} onClick={onToggle}><GitFork size={15} /></button>
}
