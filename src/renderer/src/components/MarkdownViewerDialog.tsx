import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clipboard, FileText, FolderOpen, Search, Trash2, X } from 'lucide-react'
import { MARKDOWN_HISTORY_LIMIT, type MarkdownViewerEntry, type MarkdownViewerSummary } from '@shared/markdownViewer'
import { useModalEscape } from '../lib/modalEscape'
import { useMarkdownViewerResize } from '../lib/useMarkdownViewerResize'
import { MarkdownPreview } from './MarkdownPreview'
import '../markdown-viewer.css'

export function MarkdownViewerDialog({ clipboardOnOpen, onClose }: { clipboardOnOpen: boolean; onClose(): void }) {
  const [history, setHistory] = useState<MarkdownViewerSummary[]>([])
  const [selected, setSelected] = useState<MarkdownViewerEntry | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const panel = useRef<HTMLElement>(null)
  const resize = useMarkdownViewerResize(panel)
  const generation = useRef(0)
  const alive = useRef(true)
  const mutating = useRef(false)
  const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
  useModalEscape(onClose, true, busy)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const frame = requestAnimationFrame(() => {
      const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('input,button:not(:disabled)') ?? [])
        .filter((element) => element.getClientRects().length > 0)
      ;(controls.find((element) => element.tagName === 'INPUT') ?? controls[0])?.focus()
    })
    return () => {
      alive.current = false
      generation.current++
      cancelAnimationFrame(frame)
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    alive.current = true
    const token = ++generation.current
    const current = () => alive.current && generation.current === token
    void (async () => {
      try {
        const api = window.projectConsole.markdownViewer
        if (!api) throw new Error('Restart PanePilot to enable the Markdown viewer.')
        let entry: MarkdownViewerEntry | null = null
        if (clipboardOnOpen) {
          try { entry = await api.fromClipboard() }
          catch (cause) { if (current()) setError(message(cause)) }
        }
        const entries = await api.list()
        if (!entry && entries[0]) entry = await api.get(entries[0].id)
        if (current()) { setHistory(entries); setSelected(entry) }
      } catch (cause) { if (current()) setError(message(cause)) }
      finally { if (current()) setLoading(false) }
    })()
    return () => { generation.current++ }
  }, [clipboardOnOpen])

  async function choose(id: string) {
    if (mutating.current || selected?.id === id) return
    const token = ++generation.current
    setError('')
    try {
      const entry = await window.projectConsole.markdownViewer.get(id)
      if (alive.current && token === generation.current) setSelected(entry)
    } catch (cause) { if (alive.current && token === generation.current) setError(message(cause)) }
  }

  async function add(source: 'clipboard' | 'file') {
    if (mutating.current || loading) return
    mutating.current = true
    setBusy(true); setError('')
    const token = ++generation.current
    try {
      const api = window.projectConsole.markdownViewer
      const entry = await (source === 'clipboard' ? api.fromClipboard() : api.openFile())
      if (!entry) return
      const entries = await api.list()
      if (alive.current && token === generation.current) { setSelected(entry); setHistory(entries) }
    } catch (cause) { if (alive.current && token === generation.current) setError(message(cause)) }
    finally { mutating.current = false; if (alive.current) setBusy(false) }
  }

  async function remove() {
    if (!selected || mutating.current) return
    mutating.current = true
    setBusy(true); setError('')
    const token = ++generation.current
    try {
      const api = window.projectConsole.markdownViewer
      await api.remove(selected.id)
      const entries = await api.list()
      const entry = entries[0] ? await api.get(entries[0].id) : null
      if (alive.current && token === generation.current) { setHistory(entries); setSelected(entry) }
    } catch (cause) { if (alive.current && token === generation.current) setError(message(cause)) }
    finally { mutating.current = false; if (alive.current) setBusy(false) }
  }

  const results = history.filter((entry) => `${entry.title} ${entry.sourcePath ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return createPortal(<div className="modal-backdrop markdown-viewer-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
    <section className={`modal markdown-viewer-modal${resize.resizing ? ' is-resizing' : ''}`} style={resize.style} ref={panel} role="dialog" aria-modal="true" aria-labelledby="markdown-viewer-title"
      onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const controls = Array.from(panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]'))
          .filter((element) => element.getClientRects().length > 0)
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && (document.activeElement === first || !panel.current!.contains(document.activeElement))) {
          event.preventDefault(); last?.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !panel.current!.contains(document.activeElement))) {
          event.preventDefault(); first?.focus()
        }
      }}>
      <header className="markdown-viewer-heading">
        <FileText size={19} /><h2 id="markdown-viewer-title">Markdown</h2>
        <button disabled={loading || busy} onClick={() => void add('clipboard')}><Clipboard size={14} />From clipboard</button>
        <button disabled={loading || busy} onClick={() => void add('file')}><FolderOpen size={14} />Open file</button>
        <button className="icon-button" disabled={busy} aria-label="Close Markdown viewer" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="markdown-viewer-layout">
        <aside className="markdown-viewer-history">
          <div className="markdown-history-heading"><span>Recent previews</span><small>{history.length}/{MARKDOWN_HISTORY_LIMIT}</small></div>
          <label className="markdown-history-search"><Search size={13} /><input aria-label="Search Markdown history" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a preview…" /></label>
          <nav aria-label="Markdown preview history">{results.map((entry) => <button key={entry.id} aria-current={selected?.id === entry.id ? 'true' : undefined}
            disabled={busy} onClick={() => void choose(entry.id)} title={entry.sourcePath ?? entry.title}>
            {entry.source === 'clipboard' ? <Clipboard size={14} /> : <FileText size={14} />}
            <span><strong>{entry.title}</strong><small>{entry.source === 'clipboard' ? 'Clipboard' : 'File'} · {new Date(entry.openedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></span>
          </button>)}</nav>
          {!loading && !results.length && <p>{query ? 'No matching previews.' : 'Your recent previews will appear here.'}</p>}
        </aside>
        <main className="markdown-viewer-document" aria-busy={loading || busy}>
          {selected ? <>
            <div className="markdown-document-heading"><span title={selected.sourcePath ?? selected.title}>{selected.title}</span>
              <button className="icon-button" disabled={busy} aria-label="Remove preview from history" title="Remove from history; the original file is untouched" onClick={() => void remove()}><Trash2 size={14} /></button>
            </div>
            <MarkdownPreview key={selected.id} projectId={null} path="preview.md" content={selected.content}
              onError={setError} onOpenProjectPath={() => setError('Relative links require a project folder. Open the file in the Files workspace to follow them.')} />
          </> : <div className="markdown-viewer-empty"><FileText size={32} /><h3>{loading ? 'Opening preview…' : 'A place to read Markdown'}</h3>
            <p>Preview text from your clipboard or open a Markdown file.<br />The last 50 previews stay on this device.</p>
          </div>}
        </main>
      </div>
      {error && <div className="markdown-viewer-error" role="alert">{error}</div>}
      <footer><span role="status">{busy ? 'Updating history…' : 'Saved on this device'}</span><span title="HTML is sanitized and scripts cannot run. Relative images and file links require the Files workspace; HTTPS images may contact their hosts.">Read-only snapshot · GitHub-style preview</span></footer>
      <button type="button" className="markdown-viewer-resize" aria-label="Resize Markdown viewer"
        title="Drag to resize · Arrow keys adjust · Double-click or press Enter to reset" {...resize.handle}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 12 12 4M8 12l4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </section>
  </div>, document.body)
}
