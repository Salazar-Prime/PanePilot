import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, LoaderCircle, Play, X } from 'lucide-react'
import type { Project } from '@shared/types'
import { actionRunActive, lastProjectAction } from '../lib/lastProjectAction'
import { runProjectAction, useActionRunPending } from '../lib/actionRuns'
import { useModalEscape } from '../lib/modalEscape'
import { ACTION_ORDER_CHANGED, ACTION_ORDER_PREFIX, loadActionOrder, validActionOrder } from '../lib/actionOrder'
import { StatusDot } from './StatusDot'

interface Props {
  project: Project
  active: boolean
  keytip?: ReactNode
  onOpen(): void
  onChanged(): Promise<void>
}

export function LastActionTool(props: Props) {
  return <LastActionToolInstance key={props.project.id} {...props} />
}

function LastActionToolInstance({ project, active, keytip, onOpen, onChanged }: Props) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [savedOrder, setSavedOrder] = useState(() => loadActionOrder(project.id))
  const [placement, setPlacement] = useState<CSSProperties>({})
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const runButton = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const mounted = useRef(true)
  const restoringFocus = useRef(false)
  const focusRequested = useRef(false)
  const id = useId()
  const last = lastProjectAction(project, savedOrder)
  const pending = useActionRunPending(last?.action.id ?? null)
  const running = !!last && actionRunActive(last.session)
  const status = pending ? 'Starting…' : running ? 'Running' : last?.session
    ? last.session.state === 'error' ? 'Failed' : 'Finished' : 'Ready to run'
  const clearTimer = () => { clearTimeout(timer.current) }
  const contains = (node: EventTarget | null) => node instanceof Node &&
    (!!trigger.current?.contains(node) || !!panel.current?.contains(node))

  function close(restoreFocus = false) {
    clearTimer()
    setOpen(false)
    if (restoreFocus) {
      restoringFocus.current = true
      trigger.current?.focus({ preventScroll: true })
      restoringFocus.current = false
    }
  }
  function focusRun() {
    const target = runButton.current && !runButton.current.disabled
      ? runButton.current : panel.current?.querySelector<HTMLButtonElement>('.last-action-open')
    target?.focus()
  }
  useModalEscape(() => close(true), open)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; clearTimer() }
  }, [])

  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; ids: string[] }>).detail
      if (detail?.projectId === project.id) setSavedOrder(validActionOrder(detail.ids))
    }
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === ACTION_ORDER_PREFIX + project.id) setSavedOrder(loadActionOrder(project.id))
    }
    window.addEventListener(ACTION_ORDER_CHANGED, changed)
    window.addEventListener('storage', storage)
    return () => { window.removeEventListener(ACTION_ORDER_CHANGED, changed); window.removeEventListener('storage', storage) }
  }, [project.id])

  // Never silently swap the command beneath a pointer or keyboard selection.
  useEffect(() => { close() }, [last?.action.id])

  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const rect = trigger.current.getBoundingClientRect()
    const width = Math.min(410, window.innerWidth - 24)
    setPlacement({ width, left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2)),
      bottom: window.innerHeight - rect.top, maxHeight: Math.max(80, rect.top - 12) })
    if (focusRequested.current) { focusRequested.current = false; focusRun() }
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (event: Event) => { if (!contains(event.target)) close() }
    const blur = () => close()
    const hidden = () => { if (document.hidden) close() }
    const scrolled = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close() }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    document.addEventListener('scroll', scrolled, true)
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('blur', blur)
    window.addEventListener('resize', blur)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('scroll', scrolled, true)
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('blur', blur)
      window.removeEventListener('resize', blur)
    }
  }, [open])

  function leave() {
    clearTimer()
    timer.current = setTimeout(() => {
      if (!contains(document.activeElement)) close()
    }, 180)
  }

  async function run() {
    if (!last || pending || running) return
    setError('')
    try { await runProjectAction(last.action.id, onChanged) }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  return <>
    <button className={active ? 'active' : ''} ref={trigger}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch') return
        clearTimer()
        timer.current = setTimeout(() => setOpen(true), 160)
      }}
      onPointerLeave={leave}
      onFocus={() => { if (!restoringFocus.current) { clearTimer(); setOpen(true) } }}
      onBlur={(event) => { if (!contains(event.relatedTarget)) close() }}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        clearTimer()
        if (open) focusRun()
        else { focusRequested.current = true; setOpen(true) }
      }}
      onClick={() => { close(); onOpen() }}>
      <Play size={15} /> Actions{keytip}
    </button>
    {open && createPortal(<div className="last-action-popover-anchor" style={placement} ref={panel}
      onPointerEnter={clearTimer} onPointerLeave={leave}
      onBlur={(event) => { if (!contains(event.relatedTarget)) close() }}>
      <div className="status-session-menu last-action-popover" id={id} role="dialog" aria-label={`Quick action for ${project.name}`}>
        <header><strong>Actions</strong><small>{project.name}</small>
          <button className="status-session-close" aria-label="Close action popup" onClick={() => close(true)}><X size={13} /></button>
        </header>
        <div className="status-session-list last-action-list">
        {last ? <button key={last.action.id} className="last-action-run" ref={runButton} disabled={pending || running}
          aria-label={`Run ${last.action.name}`} onClick={() => void run()} title={last.action.command}>
          <StatusDot state={running ? 'running' : last.session?.state ?? 'idle'} compact />
          <span className="status-session-copy"><strong>{last.action.name}</strong><small>{last.action.command}</small></span>
          <span className="last-action-run-label">{pending || running ? <LoaderCircle size={12} className="spin" /> : <Play size={12} />}{pending ? 'Starting…' : running ? 'Running' : 'Run'}</span>
        </button> : <p className="last-action-empty">No actions yet. Open Actions to create one.</p>}
        </div>
        {last && <div className="last-action-status" role="status" aria-live="polite"><span>{last.source === 'first' ? 'First action' : 'Last used action'}</span><strong>{status}</strong></div>}
        {error && <p className="last-action-error" role="alert">{error}</p>}
        <button className="last-action-open" onClick={() => { close(); onOpen() }}>Open Actions <ArrowUpRight size={12} /></button>
      </div>
    </div>, document.body)}
  </>
}
