import { SubagentActivityIcon } from './SubagentActivityIcon'

/** Explicit pins own their own persistent button; this is only the contextual shortcut. */
export function AutomaticSubagentAction({ present, running, pinned, active, onToggle }: {
  present: boolean
  running: boolean
  pinned: boolean
  active: boolean
  onToggle(): void
}) {
  if (pinned || !present) return null
  return <button className="icon-button" aria-label="Sub-agents" title="Sub-agents"
    aria-pressed={active} onClick={onToggle}><SubagentActivityIcon running={running} /></button>
}
