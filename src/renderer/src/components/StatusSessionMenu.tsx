import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { X } from 'lucide-react'
import type { Connection, Project } from '@shared/types'
import { useModalEscape } from '../lib/modalEscape'
import { statusSessions, statusSessionFilters, type StatusSessionFilter } from '../lib/statusSessions'
import { stateLabels } from '../lib/status'
import { StatusDot } from './StatusDot'
import { WorkspaceTerminalPreview } from './WorkspaceTerminalPreview'
import '../workspace-switcher.css'

function previewPlacement(panel: DOMRect): CSSProperties {
  const height = Math.max(80, Math.min(520, window.innerHeight * 0.64, panel.top - 16))
  return {
    top: Math.max(8, panel.top - height - 8),
    right: Math.max(12, window.innerWidth - panel.right),
    width: Math.min(760, window.innerWidth - 24),
    height
  }
}

export function StatusSessionMenu({ projects, connections, onSelect }: {
  projects: Project[]; connections: Connection[]; onSelect(projectId: string, sessionId: string): void
}) {
  const [filter, setFilter] = useState<StatusSessionFilter | null>(null)
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null)
  const [panelRect, setPanelRect] = useState<DOMRect | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const groups = useMemo(() => statusSessionFilters.map((item) => ({ ...item, entries: statusSessions(projects, item.id) })), [projects])
  const selected = groups.find((item) => item.id === filter)
  const entries = selected?.entries ?? []
  const previewEntry = entries.find(({ session }) => session.id === previewSessionId)
  function close(restoreFocus = false) {
    setFilter(null)
    setPreviewSessionId(null)
    if (restoreFocus) {
      const target = trigger.current?.isConnected ? trigger.current : root.current?.querySelector<HTMLButtonElement>('.status-summary-trigger')
      target?.focus({ preventScroll: true })
    }
  }
  useModalEscape(() => close(true), filter !== null)
  useEffect(() => {
    if (!filter) return
    const first = panel.current?.querySelector<HTMLButtonElement>('[data-status-session]') ?? panel.current?.querySelector<HTMLButtonElement>('.status-session-close')
    first?.focus({ preventScroll: true })
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setFilter(null)
    }
    const blur = () => setFilter(null)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('blur', blur)
    }
  }, [filter])
  useEffect(() => {
    if (!filter || !previewEntry) return
    const measure = () => setPanelRect(panel.current?.getBoundingClientRect() ?? null)
    measure()
    const observer = new ResizeObserver(measure)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [filter, previewEntry?.session.id])

  return <div className="status-summary" ref={root}>
    {groups.filter((group) => !group.hideEmpty || group.entries.length > 0).map((group) => <button key={group.id}
      data-status-filter={group.id}
      className="status-summary-trigger" aria-haspopup="dialog" aria-expanded={filter === group.id}
      aria-controls={filter === group.id ? 'status-session-menu' : undefined}
      onClick={(event) => { trigger.current = event.currentTarget; setPreviewSessionId(null); setFilter((current) => current === group.id ? null : group.id) }}>
      <span className={`mini-dot ${group.dot}`} />
      {group.entries.length} {group.id === 'attention' && group.entries.length !== 1 ? 'responses ready' : group.label}
    </button>)}
    <span className="project-total">{projects.length} projects</span>
    {filter && <div className="status-session-menu" role="dialog" aria-label={selected?.title}
      id="status-session-menu" ref={panel} onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        const rows = Array.from(panel.current!.querySelectorAll<HTMLButtonElement>('[data-status-session]'))
        if (!rows.length) return
        event.preventDefault()
        const index = rows.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 :
          (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
        rows[next].focus({ preventScroll: true })
        rows[next].scrollIntoView({ block: 'nearest' })
        setPreviewSessionId(rows[next].dataset.statusSession ?? null)
      }}>
      <header><strong>{selected?.title}</strong><small>{entries.length}</small>
        <button className="status-session-close" aria-label="Close terminal list" onClick={() => close(true)}><X size={13} /></button>
      </header>
      <div className="status-session-list" onMouseLeave={() => setPreviewSessionId(null)}>
        {entries.length === 0 ? <p>No terminals in this state right now.</p> :
          entries.map(({ project, session }) => <button key={session.id} data-status-session={session.id}
            onMouseEnter={() => setPreviewSessionId(session.id)}
            onClick={() => { close(); onSelect(project.id, session.id) }}>
            <StatusDot state={session.state} compact />
            <span className="status-session-copy"><strong>{session.name}</strong><small>{project.icon ? `${project.icon} ` : ''}{project.name} · {connections.find((connection) => connection.id === project.connectionId)?.name ?? 'Unknown machine'}</small></span>
            <span className="status-session-state">{session.state === 'needs-attention' ? 'Blocked' : stateLabels[session.state]}</span>
          </button>)}
      </div>
    </div>}
    {filter && previewEntry && panelRect && <WorkspaceTerminalPreview variant="status"
      placement={previewPlacement(panelRect)} destination={{
        sessionId: previewEntry.session.id,
        sessionName: previewEntry.session.name,
        projectName: previewEntry.project.name
      }} />}
  </div>
}
