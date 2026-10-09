import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckSquare, Plus, StickyNote, Trash2, X } from 'lucide-react'
import {
  QUICK_NOTES_ITEM_LIMIT, QUICK_NOTES_ITEM_TEXT_LIMIT, QUICK_NOTES_THOUGHT_LIMIT,
  type QuickNotesContent
} from '@shared/quickNotes'
import { useModalEscape } from '../lib/modalEscape'
import { QuickNotesDraft, quickNoteId } from '../lib/quickNotesDraft'
import '../quick-notes.css'

export function QuickNotesDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const model = useRef<QuickNotesDraft | null>(null)
  if (!model.current) model.current = new QuickNotesDraft((document) => window.projectConsole.quickNotes.save(document))
  const [draft, setDraft] = useState<QuickNotesContent | null>(null)
  const [mode, setMode] = useState<'thoughts' | 'checklist'>('thoughts')
  const [status, setStatus] = useState('Loading…')
  const [error, setError] = useState('')
  const [closing, setClosing] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const panel = useRef<HTMLElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const newItem = useRef<string | null>(null)

  useEffect(() => {
    if (!open || model.current!.value) return
    let canceled = false
    setError('')
    setStatus('Loading…')
    if (!window.projectConsole.quickNotes) {
      setStatus('Not loaded')
      setError('Restart PanePilot to enable Quick Notes. Your running terminals can stay in tmux.')
      return
    }
    void window.projectConsole.quickNotes.get().then((document) => {
      if (canceled) return
      model.current!.load(document)
      setDraft(model.current!.value)
      setStatus('Saved on this device')
    }).catch((cause) => {
      if (!canceled) { setStatus('Not loaded'); setError(String(cause instanceof Error ? cause.message : cause)) }
    })
    return () => { canceled = true }
  }, [open, loadAttempt])

  const save = useCallback(async () => {
    clearTimeout(timer.current)
    if (!model.current!.dirty) return
    setStatus('Saving…')
    setError('')
    try {
      await model.current!.flush()
      setStatus('Saved on this device')
    } catch (cause) {
      setStatus('Not saved')
      setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    }
  }, [])

  useEffect(() => {
    if (!draft || !model.current!.dirty) return
    timer.current = setTimeout(() => { void save().catch(() => {}) }, 400)
    return () => clearTimeout(timer.current)
  }, [draft, save])

  useEffect(() => {
    const flush = () => { void save().catch(() => {}) }
    window.addEventListener('blur', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      clearTimeout(timer.current)
      window.removeEventListener('blur', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [save])

  function change(next: QuickNotesContent) {
    model.current!.value = next
    setDraft(next)
    setStatus('Unsaved changes')
  }

  async function close() {
    if (closing) return
    setClosing(true)
    try { await save(); onClose() } catch { /* Keep unsaved text available for retry/copy. */ }
    finally { setClosing(false) }
  }
  useModalEscape(() => { void close() }, open, closing)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const target = panel.current?.querySelector<HTMLElement>('[data-notes-editor], [data-add-item]') ??
        panel.current?.querySelector<HTMLElement>('[aria-label="Close Quick Notes"]')
      target?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open, Boolean(draft), mode])
  useEffect(() => {
    if (!newItem.current) return
    panel.current?.querySelector<HTMLInputElement>(`[data-note-id="${newItem.current}"] input[type="text"]`)?.focus()
    newItem.current = null
  }, [draft])

  if (!open) return null
  return createPortal(<div className="modal-backdrop quick-notes-backdrop" onMouseDown={() => { void close() }}>
    <section className="modal quick-notes-modal" ref={panel} role="dialog" aria-modal="true" aria-labelledby="quick-notes-title"
      onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault(); void save().catch(() => {}); return
        }
        if (event.key !== 'Tab') return
        const controls = Array.from(panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled)'))
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && (document.activeElement === first || !panel.current!.contains(document.activeElement))) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !panel.current!.contains(document.activeElement))) {
          event.preventDefault(); first?.focus()
        }
      }}>
      <header className="quick-notes-heading"><StickyNote size={20} /><div><h2 id="quick-notes-title">Quick notes</h2><p>A place for things between projects.</p></div>
        <button className="icon-button" aria-label="Close Quick Notes" disabled={closing} onClick={() => { void close() }}><X size={17} /></button>
      </header>
      <div className="quick-notes-modes" aria-label="Note type">
        <button aria-pressed={mode === 'thoughts'} onClick={() => setMode('thoughts')}><StickyNote size={14} />Thoughts</button>
        <button aria-pressed={mode === 'checklist'} onClick={() => setMode('checklist')}><CheckSquare size={14} />Checklist{draft?.items.length ? <small>{draft.items.filter((item) => item.checked).length}/{draft.items.length}</small> : null}</button>
      </div>
      {draft ? <div className="quick-notes-body">
        {mode === 'thoughts' ? <textarea data-notes-editor aria-label="Quick thoughts" placeholder="An idea, a reminder, something to come back to…"
          disabled={closing} maxLength={QUICK_NOTES_THOUGHT_LIMIT} value={draft.thoughts} onChange={(event) => change({ ...draft, thoughts: event.target.value })} /> : <>
          <div className="quick-notes-checklist">
            {!draft.items.length && <p className="quick-notes-empty">Small things to remember. Check them off as you go.</p>}
            {draft.items.map((item, index) => <div className={`quick-notes-item ${item.checked ? 'checked' : ''}`} key={item.id} data-note-id={item.id}>
              <input type="checkbox" checked={item.checked} disabled={closing} aria-label={`Mark item ${index + 1} ${item.checked ? 'incomplete' : 'complete'}`}
                onChange={(event) => change({ ...draft, items: draft.items.map((row) => row.id === item.id ? { ...row, checked: event.target.checked } : row) })} />
              <input type="text" value={item.text} disabled={closing} maxLength={QUICK_NOTES_ITEM_TEXT_LIMIT} placeholder="What needs doing?" aria-label={`Checklist item ${index + 1}`}
                onChange={(event) => change({ ...draft, items: draft.items.map((row) => row.id === item.id ? { ...row, text: event.target.value } : row) })} />
              <button className="icon-button" disabled={closing} aria-label={`Delete checklist item ${index + 1}`} onClick={() => change({ ...draft, items: draft.items.filter((row) => row.id !== item.id) })}><Trash2 size={13} /></button>
            </div>)}
          </div>
          <button className="quick-notes-add" data-add-item disabled={closing || draft.items.length >= QUICK_NOTES_ITEM_LIMIT} onClick={() => {
            const id = quickNoteId(); newItem.current = id
            change({ ...draft, items: [...draft.items, { id, text: '', checked: false }] })
          }}><Plus size={14} />Add item</button>
        </>}
      </div> : <p className="quick-notes-loading">{error ? 'Your notes could not be loaded.' : 'Loading your notes…'}</p>}
      {error && <div className="quick-notes-error" role="alert"><span>{error}</span><button disabled={closing} onClick={() => {
        if (draft) void save().catch(() => {})
        else setLoadAttempt((value) => value + 1)
      }}>Retry</button></div>}
      <footer><span role="status">{closing ? 'Saving before closing…' : status}</span><span>Not tied to a project</span></footer>
    </section>
  </div>, document.body)
}
