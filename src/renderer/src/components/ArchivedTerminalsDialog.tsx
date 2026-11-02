import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Archive, RotateCcw, Search, Trash2, X } from 'lucide-react'
import type { Project, TerminalSession } from '@shared/types'
import { archivedTerminals } from '../lib/terminalArchive'
import { useModalEscape } from '../lib/modalEscape'
import { useUpdateRestartGuard } from '../lib/updateRestartGuards'
import { TerminalProfileIcon } from './TerminalProfileIcon'
import '../terminal-archives.css'

export function ArchivedTerminalsDialog({ project, onClose, onRestore, onDelete }: {
  project: Project
  onClose(): void
  onRestore(session: TerminalSession): Promise<void>
  onDelete(session: TerminalSession): Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const mounted = useRef(true)
  const panel = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const [error, setError] = useState('')
  const sessions = archivedTerminals(project)
  const matches = sessions.filter((session) => `${session.name} ${session.profile} ${session.providerSessionId ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const close = () => { if (!pendingRef.current) onClose() }
  useModalEscape(close, true, pending !== null)
  useUpdateRestartGuard(pending ? 'Wait for the terminal archive operation to finish before updating.' : null)
  useEffect(() => {
    mounted.current = true
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => search.current?.focus())
    return () => {
      mounted.current = false
      cancelAnimationFrame(frame)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  async function run(session: TerminalSession, operation: 'restore' | 'delete') {
    if (pendingRef.current) return
    if (operation === 'delete' && !window.confirm(`Permanently delete “${session.name}” and its saved terminal output? Any exact backend still running will be closed. Provider conversation archives will remain.`)) return
    pendingRef.current = true
    setPending(session.id)
    setError('')
    try { await (operation === 'restore' ? onRestore(session) : onDelete(session)) }
    catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : String(caught)) }
    finally { pendingRef.current = false; if (mounted.current) setPending(null) }
  }

  return createPortal(<div className="modal-backdrop terminal-archives-backdrop" onMouseDown={close}>
    <section className="modal terminal-archives-modal" ref={panel} role="dialog" aria-modal="true"
      aria-labelledby="terminal-archives-title" onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const controls = Array.from(panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'))
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && (document.activeElement === first || !panel.current!.contains(document.activeElement))) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !panel.current!.contains(document.activeElement))) {
          event.preventDefault(); first?.focus()
        }
      }}>
      <header className="terminal-archives-heading">
        <Archive size={19} /><div><h2 id="terminal-archives-title">Archived terminals <small>{sessions.length}</small></h2><p>{project.name}</p></div>
        <button className="icon-button" aria-label="Close terminal archive" disabled={pending !== null} onClick={close}><X size={17} /></button>
      </header>
      <label className="terminal-archives-search"><Search size={14} /><input ref={search} value={query}
        onChange={(event) => setQuery(event.target.value)} placeholder="Find an archived terminal…" aria-label="Find archived terminals" /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="terminal-archives-list" aria-busy={pending !== null}>
        {matches.map((session) => <article className="terminal-archive-row" key={session.id}>
          <TerminalProfileIcon profile={session.profile} />
          <div className="terminal-archive-identity"><strong>{session.name}</strong><small>
            {session.profile === 'shell' ? 'Login shell' : session.profile === 'claude' ? 'Claude Code' : 'Codex'}
            <span aria-hidden="true"> · </span><time dateTime={session.updatedAt}>{new Date(session.updatedAt).toLocaleDateString()}</time>
          </small>{session.providerSessionId && <code title={session.providerSessionId}>{session.providerSessionId.slice(0, 12)}</code>}</div>
          <button className="secondary-button" disabled={pending !== null || project.archived} onClick={() => void run(session, 'restore')}
            aria-label={`Restore ${session.name}`}><RotateCcw size={13} />{pending === session.id ? 'Working…' : 'Restore'}</button>
          <button className="icon-button danger-text" aria-label={`Delete archived ${session.name}`} disabled={pending !== null}
            title="Permanently delete saved terminal" onClick={() => void run(session, 'delete')}><Trash2 size={14} /></button>
        </article>)}
        {!matches.length && <div className="terminal-archives-empty"><Archive size={25} /><strong>{sessions.length ? 'No matching terminals' : 'No archived terminals'}</strong>
          <p>{sessions.length ? 'Try another name or session ID.' : 'Archive a terminal from its tab menu or sidebar right-click menu.'}</p></div>}
      </div>
      <footer>Restoring returns the stopped tab. Resume linked agent chats from the terminal menu.</footer>
    </section>
  </div>, document.body)
}
