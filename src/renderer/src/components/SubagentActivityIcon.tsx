import { GitFork } from 'lucide-react'

/** Working only: there is deliberately no completion badge or attention animation. */
export function SubagentActivityIcon({ running }: { running: boolean }) {
  return <span className="subagent-toolbar-icon" title={running ? 'One or more sub-agents are running' : undefined}>
    <GitFork size={15} />
    {running && <i className="subagent-running-dot" role="img" aria-label="Sub-agents running" />}
  </span>
}
