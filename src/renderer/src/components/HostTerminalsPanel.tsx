import { useEffect, useId, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Plus, TerminalSquare, X } from 'lucide-react'
import type { HostTerminal } from '@shared/types'
import { useModalEscape } from '../lib/modalEscape'
import { useActiveTabVisibility } from '../lib/useActiveTabVisibility'
import { ManagedTerminal } from './ManagedTerminal'
import '../host-terminals.css'

interface Props {
  sessions: HostTerminal[]
  selectedId: string | null
  pending: boolean
  error: string
  onSelect(id: string): void
  onCreate(): void
  onRemove(id: string): void
  onDismiss(): void
}

function visibleFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )).filter((element) => {
    const style = window.getComputedStyle(element)
    return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0
  })
}

export function HostTerminalsPanel({ sessions, selectedId, pending, error, onSelect, onCreate, onRemove, onDismiss }: Props) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const id = useId()
  const selected = useMemo(
    () => sessions.find((session) => session.id === selectedId) ?? sessions[0] ?? null,
    [sessions, selectedId]
  )
  const tabsRef = useActiveTabVisibility(selected?.id, JSON.stringify(sessions.map(({ id, name }) => [id, name])))

  useModalEscape(onDismiss, true, pending)

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => {
      const panel = dialogRef.current
      const topmost = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).at(-1)
      if (!panel || topmost !== panel) return
      const terminalInput = panel.querySelector<HTMLElement>('.xterm-helper-textarea')
      if (selected && terminalInput) terminalInput.focus({ preventScroll: true })
      else if (closeRef.current && !closeRef.current.disabled) closeRef.current.focus({ preventScroll: true })
      else panel.focus({ preventScroll: true })
    })
    return () => {
      cancelAnimationFrame(frame)
      const opener = openerRef.current
      const otherModal = document.querySelector('[role="dialog"][aria-modal="true"]')
      const target = opener?.isConnected && opener !== document.body ? opener :
        document.querySelector<HTMLElement>('[data-pinned-action="host-terminals"] button, .host-terminal-toolbar, .top-overflow-trigger')
      if (target && !otherModal) target.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const panel = dialogRef.current
    if (!panel || !selected) return
    const frame = requestAnimationFrame(() => {
      const topmost = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).at(-1)
      if (topmost === panel) panel.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [selected?.id])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="host-terminals-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !pending) onDismiss() }}>
      <section
        ref={dialogRef}
        className="host-terminals-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyDownCapture={(event) => {
          if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
            event.stopPropagation()
            event.preventDefault()
            const target = sessions[Number(event.key) - 1]
            if (target) {
              event.preventDefault()
              onSelect(target.id)
            }
            return
          }
          // Shell completion and reverse-Tab remain terminal input. xterm
          // prevents their default browser navigation itself.
          if (event.key !== 'Tab' || (event.target as HTMLElement).closest('.xterm')) return
          const elements = visibleFocusableElements(dialogRef.current!)
          const first = elements[0]
          const last = elements.at(-1)
          if (!first) {
            event.preventDefault()
            dialogRef.current?.focus()
          } else if (event.shiftKey && (document.activeElement === first || !dialogRef.current!.contains(document.activeElement))) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current!.contains(document.activeElement))) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <header className="host-terminals-heading">
          <div className="host-terminals-title">
            <TerminalSquare size={20} aria-hidden="true" />
            <div>
              <h2 id={`${id}-title`}>Host terminals</h2>
              <p>This computer · independent of projects</p>
            </div>
          </div>
          <div className="host-terminals-heading-actions">
            <button className="host-terminals-new" disabled={pending} onClick={onCreate}>
              <Plus size={15} aria-hidden="true" /> New terminal
            </button>
            <button ref={closeRef} className="icon-button" aria-label="Hide host terminals" disabled={pending} onClick={onDismiss}>
              <X size={17} aria-hidden="true" />
            </button>
          </div>
        </header>

        {sessions.length > 0 && <div className="host-terminals-tabs" aria-label="Host terminal sessions">
          <div className="host-terminals-tablist" role="tablist" aria-label="Terminal sessions" ref={tabsRef}>
            {sessions.map((session, index) => {
              const active = session.id === selected?.id
              return <div className={`host-terminals-tab-item${active ? ' active' : ''}`} key={session.id} data-active-tab={active}>
                <button
                  id={`${id}-tab-${index}`}
                  className="host-terminals-tab"
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`${id}-terminal-panel`}
                  tabIndex={active ? 0 : -1}
                  title={session.name}
                  onClick={() => onSelect(session.id)}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                    event.preventDefault()
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? sessions.length - 1 :
                      (index + (event.key === 'ArrowRight' ? 1 : -1) + sessions.length) % sessions.length
                    onSelect(sessions[next].id)
                    document.getElementById(`${id}-tab-${next}`)?.focus()
                  }}
                >
                  <span className="host-terminals-tab-name">{session.name}</span>
                  {session.state !== 'idle' && <small>Ended</small>}
                </button>
                <button
                  className="host-terminals-tab-close"
                  type="button"
                  aria-label={`Close ${session.name}`}
                  title={`Close ${session.name}`}
                  disabled={pending}
                  onClick={() => onRemove(session.id)}
                ><X size={13} aria-hidden="true" /></button>
              </div>
            })}
          </div>
        </div>}

        <main className="host-terminals-body" id={`${id}-terminal-panel`} role="tabpanel" aria-labelledby={selected ? `${id}-tab-${sessions.findIndex((session) => session.id === selected.id)}` : undefined}>
          {selected
            ? <ManagedTerminal session={selected} bridge={window.projectConsole.hostTerminals} allowFileDrops={false} retainOutputOnExit />
            : <div className="host-terminals-empty">
              <TerminalSquare size={27} aria-hidden="true" />
              <p>No host terminals open</p>
              <button className="host-terminals-new" disabled={pending} onClick={onCreate}><Plus size={15} aria-hidden="true" /> New terminal</button>
            </div>}
        </main>

        {error && <div className="host-terminals-error" role="alert">{error}</div>}
        <footer className="host-terminals-footer">Hiding keeps shells running. Closing a terminal stops its session.</footer>
      </section>
    </div>,
    document.body
  )
}
