import { TerminalSquare } from 'lucide-react'

export function HostTerminalToolbarAction({ count, pinned, active, onOpen }: {
  count: number; pinned: boolean; active: boolean; onOpen(): void
}) {
  if (!count || pinned) return null
  return <button className={`icon-button host-terminal-toolbar ${active ? 'active' : ''}`}
    aria-label={`Host terminals (${count} open)`} title={`Host terminals · ${count} open on this computer`}
    aria-haspopup="dialog" aria-expanded={active} onClick={onOpen}>
    <TerminalSquare size={16} /><small aria-hidden="true">{count}</small>
  </button>
}
