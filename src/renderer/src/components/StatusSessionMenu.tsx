import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { Connection, Project } from '@shared/types'
import { useModalEscape } from '../lib/modalEscape'
import { statusSessions, type StatusSessionFilter } from '../lib/statusSessions'
import { stateLabels } from '../lib/status'
import { StatusDot } from './StatusDot'

export function StatusSessionMenu({ projects, connections, onSelect }: {
  projects: Project[]; connections: Connection[]; onSelect(projectId: string, sessionId: string): void
}) {
  const [filter, setFilter] = useState<StatusSessionFilter | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)
  const working = useMemo(() => statusSessions(projects, 'working'), [projects])
  const attention = useMemo(() => statusSessions(projects, 'attention'), [projects])
  const entries = filter === 'working' ? working : attention
  function close(restoreFocus = false) {
    setFilter(null)
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
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

  return <div className="status-summary" ref={root}>
    {(['working', 'attention'] as const).map((kind) => <button key={kind}
      className="status-summary-trigger" aria-haspopup="dialog" aria-expanded={filter === kind}
      aria-controls={filter === kind ? 'status-session-menu' : undefined}
      onClick={(event) => { trigger.current = event.currentTarget; setFilter((current) => current === kind ? null : kind) }}>
      <span className={`mini-dot ${kind === 'working' ? 'running' : 'attention'}`} />
      {kind === 'working' ? `${working.length} working` : `${attention.length} need${attention.length === 1 ? 's' : ''} attention`}
    </button>)}
    <span className="project-total">{projects.length} projects</span>
    {filter && <div className="status-session-menu" role="dialog" aria-label={filter === 'working' ? 'Working terminals' : 'Terminals needing attention'}
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
      }}>
      <header><strong>{filter === 'working' ? 'Working terminals' : 'Needs attention'}</strong><small>{entries.length}</small>
        <button className="status-session-close" aria-label="Close terminal list" onClick={() => close(true)}><X size={13} /></button>
      </header>
      <div className="status-session-list">
        {entries.length === 0 ? <p>No terminals {filter === 'working' ? 'are working right now.' : 'need attention right now.'}</p> :
          entries.map(({ project, session }) => <button key={session.id} data-status-session={session.id}
            onClick={() => { close(); onSelect(project.id, session.id) }}>
            <StatusDot state={session.state} compact />
            <span className="status-session-copy"><strong>{session.name}</strong><small>{project.icon ? `${project.icon} ` : ''}{project.name} · {connections.find((connection) => connection.id === project.connectionId)?.name ?? 'Unknown machine'}</small></span>
            <span className="status-session-state">{stateLabels[session.state]}</span>
          </button>)}
      </div>
    </div>}
  </div>
}
