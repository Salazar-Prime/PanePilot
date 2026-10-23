import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownToLine, RotateCw, ShieldCheck, X } from 'lucide-react'
import type { AppUpdateState } from '@shared/appUpdates'
import { useModalEscape } from '../lib/modalEscape'
import '../app-updates.css'

export function AppUpdatesDialog({ open, state, onClose, onCheck, onRestart }: {
  open: boolean; state: AppUpdateState; onClose(): void
  onCheck(): Promise<void>; onRestart(): Promise<void>
}) {
  const panel = useRef<HTMLElement>(null)
  const submittingRef = useRef(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const busy = state.phase === 'checking' || state.phase === 'downloading'
  const restarting = submitting || state.phase === 'restarting'
  useModalEscape(onClose, open, restarting)
  useEffect(() => {
    if (!open) return
    setError('')
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLButtonElement>('button')?.focus())
    return () => { cancelAnimationFrame(frame); if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [open])
  if (!open) return null
  async function restart() {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true); setError('')
    try { await onRestart() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { submittingRef.current = false; setSubmitting(false) }
  }
  return createPortal(<div className="modal-backdrop" onMouseDown={() => { if (!restarting) onClose() }}>
    <section ref={panel} className="modal app-updates-dialog" role="dialog" aria-modal="true" aria-labelledby="app-updates-title"
      onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const buttons = Array.from(panel.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const first = buttons[0], last = buttons.at(-1)
        if (event.shiftKey && (document.activeElement === first || !panel.current!.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || !panel.current!.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
      }}>
      <header><div><span className="app-updates-eyebrow">PANEPILOT · {state.currentVersion || 'DEVELOPMENT'}</span>
        <h2 id="app-updates-title">{state.phase === 'ready' ? `Version ${state.version ?? ''} is ready` : 'App updates'}</h2></div>
        <button className="icon-button" aria-label="Close app updates" disabled={restarting} onClick={onClose}><X size={17} /></button>
      </header>
      <p role="status">{state.message}</p>
      {state.phase === 'downloading' && <div className="app-updates-progress"><progress aria-label="Update progress" max={100} value={state.percent ?? undefined} />
        <span>{state.stage === 'verify' ? 'Preparing' : 'Downloading'}{state.percent == null ? '' : ` · ${Math.floor(state.percent)}%`}</span></div>}
      <div className="app-updates-trust"><ShieldCheck size={14} /><span>Updates verified with PanePilot’s signing key</span></div>
      <p className="app-updates-detail">PanePilot checks shortly after launch and every six hours, downloading available updates in the background. Installation still requires Restart to update. Save your work first; plain PTY terminals must be stopped. SSH port forwards must be reopened after restarting.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <footer><button className="secondary-button" disabled={restarting} onClick={onClose}>Later</button>
        {state.phase === 'ready' || state.phase === 'restarting'
          ? <button className="primary-button" disabled={restarting} onClick={() => { void restart() }}><RotateCw size={14} />Restart to update</button>
          : <button className="primary-button" disabled={busy || state.phase === 'disabled'} onClick={() => {
            setError(''); void onCheck().catch((cause) => setError(String(cause)))
          }}><ArrowDownToLine size={14} />{busy ? 'Updating…' : state.phase === 'error' ? 'Try again' : 'Check for updates'}</button>}
      </footer>
    </section>
  </div>, document.body)
}
