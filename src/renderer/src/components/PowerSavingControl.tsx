import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Leaf, X } from 'lucide-react'
import { DEFAULT_POWER_SAVING, type AppMemorySnapshot, type ProcessMemoryGroup, type PowerSavingSettings, type PowerSavingState } from '@shared/powerSaving'
import { useModalEscape } from '../lib/modalEscape'
import '../power-saving.css'

const memoryLabel = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes > 0 && bytes < 1024 ** 2 ? '<1 MB' : `${Math.round(bytes / 1024 ** 2)} MB`
const processLabel = (count: number) => `${count} ${count === 1 ? 'process' : 'processes'}`

function MemoryGroup({ label, group, note }: { label: string; group?: ProcessMemoryGroup; note: string }) {
  return <details className="power-memory-group">
    <summary><span>{label}<small>{!group ? 'Reading…' : group.bytes == null ? 'Unavailable' : `${processLabel(group.processCount)}${group.warning ? ' measured' : ''}`}</small></span>
      <b>{group?.bytes == null ? '—' : `${group.warning ? '≥ ' : ''}${memoryLabel(group.bytes)}`}</b></summary>
    <p>{note}</p>
    {group?.warning && <p className="power-memory-warning" role="status">{group.warning}</p>}
    <div className="power-memory-rows">
      {group?.rows.map(row => <div className="power-memory-row" key={row.id}>
        <span title={row.name}>{row.name}<small>{row.detail} · {row.bytes == null ? 'Unavailable' : processLabel(row.processCount)}</small></span>
        <span>{row.bytes == null ? '—' : memoryLabel(row.bytes)}</span>
      </div>)}
      {group && !group.rows.length && !group.warning && <p>No active processes in this group.</p>}
      {!!group?.omittedRows && <p>Showing the 100 largest entries; {group.omittedRows} more included in the total.</p>}
    </div>
  </details>
}

export function PowerSavingControl() {
  const [state, setState] = useState<PowerSavingState | null>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(DEFAULT_POWER_SAVING)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [memory, setMemory] = useState<AppMemorySnapshot | null>(null)
  const [memoryError, setMemoryError] = useState('')
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  const saving = useRef(false)
  const alive = useRef(true)
  function cancelPress() { if (press.current) clearTimeout(press.current.timer); press.current = null }
  function close(restore = false) { if (saving.current) return; setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }) }
  function showSettings() { cancelPress(); setDraft(state?.settings ?? DEFAULT_POWER_SAVING); setError(''); setOpen(true) }
  useModalEscape(() => close(true), open, busy)

  useEffect(() => {
    alive.current = true
    const api = window.projectConsole.powerSaving
    if (!api) { setError('Restart PanePilot to enable power saving.'); return }
    let changed = false
    const unsubscribe = api.onChanged(next => { changed = true; if (alive.current) setState(next) })
    void api.get().then(next => { if (alive.current && !changed) setState(next) }).catch(cause => { if (alive.current) setError(String(cause)) })
    const blur = () => cancelPress()
    window.addEventListener('blur', blur)
    return () => { alive.current = false; cancelPress(); unsubscribe(); window.removeEventListener('blur', blur) }
  }, [])

  useEffect(() => {
    if (!open) return
    panel.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
    const outside = (event: Event) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside) }
  }, [open])

  useEffect(() => {
    if (!open) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let pending = false
    const read = async () => {
      if (stopped || pending || document.hidden) return
      pending = true
      try {
        const next = await window.projectConsole.powerSaving.memory()
        if (!stopped) { setMemory(next); setMemoryError('') }
      } catch { if (!stopped) setMemoryError('Memory information unavailable.') }
      finally { pending = false; if (!stopped && !document.hidden) timer = setTimeout(read, 5000) }
    }
    const visible = () => { if (timer) clearTimeout(timer); if (!document.hidden) void read() }
    void read()
    document.addEventListener('visibilitychange', visible)
    return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visible) }
  }, [open])

  async function save(settings: PowerSavingSettings, dismiss = false) {
    if (saving.current || !state) return
    saving.current = true; setBusy(true); setError('')
    try {
      const next = await window.projectConsole.powerSaving.save(settings)
      if (alive.current) { setState(next); setDraft(next.settings); if (dismiss) { setOpen(false); trigger.current?.focus({ preventScroll: true }) } }
    } catch (cause) { if (alive.current) { setError(cause instanceof Error ? cause.message : String(cause)); setOpen(true) } }
    finally { saving.current = false; if (alive.current) setBusy(false) }
  }

  const enabled = state?.settings.enabled ?? false
  return <>
    <button ref={trigger} className={`power-saving-toggle${enabled ? ' enabled' : ''}`} aria-label="Power saving"
      aria-pressed={enabled} aria-haspopup="dialog" aria-expanded={open} disabled={busy}
      title={`Power saving ${enabled ? 'on' : 'off'} · Click to toggle · Hold or right-click for settings`}
      onClick={() => { if (suppressClick.current) { suppressClick.current = false; return }; if (!state) { showSettings(); return }; void save({ ...state.settings, enabled: !enabled }) }}
      onContextMenu={event => { event.preventDefault(); showSettings() }}
      onPointerDown={event => {
        if (event.button !== 0) return
        cancelPress(); suppressClick.current = false
        press.current = { x: event.clientX, y: event.clientY, timer: setTimeout(() => { suppressClick.current = true; showSettings() }, 500) }
      }}
      onPointerMove={event => { if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) cancelPress() }}
      onPointerUp={cancelPress} onPointerCancel={cancelPress} onPointerLeave={cancelPress}
      onKeyDown={event => {
        suppressClick.current = false
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10') || event.key === 'ArrowUp') {
          event.preventDefault(); showSettings()
        }
      }}><Leaf size={13} fill={enabled ? 'currentColor' : 'none'} strokeWidth={1.5} /></button>
    {open && createPortal(<div ref={panel} className="status-session-menu power-saving-popover" role="dialog" aria-label="Power saving settings">
      <header><Leaf size={15} /><strong>Power saving</strong><small>{enabled ? 'On' : 'Off'}</small>
        <button className="status-session-close" aria-label="Close power saving settings" disabled={busy} onClick={() => close(true)}><X size={14} /></button>
      </header>
      <form onSubmit={event => { event.preventDefault(); void save({ ...draft, enabled }, true) }}>
        <label>Pause idle chats after <span><input aria-label="Idle timeout in minutes" type="number" min="1" max="10080" required value={Number.isFinite(draft.idleMinutes) ? draft.idleMinutes : ''}
          disabled={busy} onChange={event => setDraft({ ...draft, idleMinutes: event.target.valueAsNumber })} /> min</span></label>
        <label>Keep at least <span><input aria-label="Minimum open chats" type="number" min="0" max="1000" required value={Number.isFinite(draft.keepAtLeast) ? draft.keepAtLeast : ''}
          disabled={busy} onChange={event => setDraft({ ...draft, keepAtLeast: event.target.valueAsNumber })} /> chats</span></label>
        <p>On this Mac. Idle Codex and Claude chats resume when reopened. Working, visible, unread, and input-waiting chats stay open, as do chats attached from another client.</p>
        <div className="power-saving-counts">{state?.liveChats == null ? 'Checked every 30 seconds while enabled' : `${state.liveChats} chat backends · ${state.suspended} paused this launch`}</div>
        {(error || state?.error) && <div role="alert" className="power-saving-error">{error || state?.error}</div>}
        <button className="power-saving-apply" type="submit" disabled={!state || busy}>{busy ? 'Saving…' : 'Save settings'}</button>
      </form>
      <section className="power-saving-memory" aria-label="Local memory usage">
        <div className="power-memory-heading"><strong>Memory</strong><small>This Mac</small></div>
        <MemoryGroup label="Electron" group={memory ? { bytes: memory.totalBytes, processCount: memory.processes.length, warning: null, omittedRows: 0,
          rows: memory.processes.map(item => ({ id: String(item.pid), name: item.name, detail: `PID ${item.pid}`, bytes: item.bytes, processCount: 1 })) } : undefined}
          note="PanePilot's main process, renderer, GPU and utilities." />
        <MemoryGroup label="tmux" group={memory?.tmux} note="The local shared tmux server and its attached clients. The server may also support sessions outside PanePilot." />
        <MemoryGroup label="Agents" group={memory?.agents} note="PanePilot-managed local Codex and Claude session trees, including shells and child tools. Shared PIDs count once in the total." />
        <p>{memoryError || 'Resident-memory estimates; shared pages may be counted twice. Remote hosts and unrelated agent sessions are excluded. Refreshes here every 5 seconds.'}</p>
      </section>
    </div>, document.body)}
  </>
}
