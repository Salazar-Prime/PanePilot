import { useEffect, useRef, useState } from 'react'
import { buildHtmlPreview, type HtmlPreviewDocument } from '../lib/htmlPreview'
import { resolveMarkdownTarget } from '../lib/markdown'
import type { MarkdownPreviewAnchor } from './MarkdownPreview'
import type { InteractiveHtmlPreview } from '@shared/types'

export function HtmlPreview({ projectId, path, content, anchor = null, onOpenProjectPath, onError }: {
  projectId: string
  path: string
  content: string
  anchor?: MarkdownPreviewAnchor | null
  onOpenProjectPath(path: string, fragment: string | null): void
  onError(message: string): void
}) {
  const [prepared, setPrepared] = useState<{ projectId: string; path: string; content: string; document: HtmlPreviewDocument } | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'static' | 'interactive'>('static')
  const [interactive, setInteractive] = useState<InteractiveHtmlPreview | null>(null)
  const [revision, setRevision] = useState(0)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const detachRef = useRef<(() => void) | null>(null)
  const callbacks = useRef({ onOpenProjectPath, onError, anchor, path })
  callbacks.current = { onOpenProjectPath, onError, anchor, path }
  const current = prepared?.projectId === projectId && prepared.path === path && prepared.content === content
    ? prepared.document : null

  useEffect(() => {
    if (mode !== 'static') return
    const controller = new AbortController()
    setError('')
    void buildHtmlPreview(content, path,
      (assetPath) => window.projectConsole.files.preview(projectId, assetPath), controller.signal)
      .then((document) => { if (!controller.signal.aborted) setPrepared({ projectId, path, content, document }) })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => controller.abort()
  }, [projectId, path, content, mode])

  useEffect(() => {
    if (mode !== 'interactive') return
    let active = true
    let opened: InteractiveHtmlPreview | null = null
    setInteractive(null)
    setError('')
    const close = (preview: InteractiveHtmlPreview) => {
      void window.projectConsole.files.closeInteractiveHtml(preview.id).catch(() => {})
    }
    if (!window.projectConsole.files.openInteractiveHtml) {
      setError('Relaunch PanePilot with the new build to enable Interactive preview')
      return
    }
    void window.projectConsole.files.openInteractiveHtml({ projectId, path, content }).then((preview) => {
      if (!active) { close(preview); return }
      opened = preview
      setInteractive(preview)
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false; if (opened) close(opened) }
  }, [projectId, path, content, mode, revision])

  function revealFragment(fragment: string): void {
    frameRef.current?.contentDocument?.getElementById(fragment)?.scrollIntoView({ block: 'start' })
  }
  useEffect(() => { if (anchor) revealFragment(anchor.fragment) }, [anchor?.requestId, current])
  useEffect(() => () => detachRef.current?.(), [])

  function attachFrame(): void {
    detachRef.current?.()
    const doc = frameRef.current?.contentDocument
    if (!doc) return
    const click = (event: MouseEvent) => {
      const target = event.target as Element | null
      const link = target?.closest?.('a,area')
      if (!link) return
      event.preventDefault()
      // Middle-click is explicitly routed too; right-click never opens a browser.
      if (event.button > 1) return
      const href = link.getAttribute('data-preview-href') ?? ''
      const resolved = resolveMarkdownTarget(callbacks.current.path, href)
      if (resolved.kind === 'fragment') revealFragment(resolved.fragment)
      else if (resolved.kind === 'project') callbacks.current.onOpenProjectPath(resolved.path, resolved.fragment)
      else if (resolved.kind === 'external') {
        void window.projectConsole.system.openExternal(resolved.url)
          .catch((cause) => callbacks.current.onError(cause instanceof Error ? cause.message : String(cause)))
      }
    }
    const submit = (event: Event) => event.preventDefault()
    doc.addEventListener('click', click)
    doc.addEventListener('auxclick', click)
    doc.addEventListener('submit', submit)
    detachRef.current = () => {
      doc.removeEventListener('click', click)
      doc.removeEventListener('auxclick', click)
      doc.removeEventListener('submit', submit)
    }
    if (callbacks.current.anchor) revealFragment(callbacks.current.anchor.fragment)
  }

  return <div className="html-preview-shell">
    <div className="html-preview-notice" role="status">
      <div className="preview-mode-switch" role="group" aria-label="HTML execution mode">
        <button className={mode === 'static' ? 'active' : ''} aria-pressed={mode === 'static'} onClick={() => setMode('static')}>Static</button>
        <button className={mode === 'interactive' ? 'active' : ''} aria-pressed={mode === 'interactive'}
          title="Run trusted project HTML with read-only assets and no PanePilot API access. Browser sandboxing is not an OS-level network jail."
          onClick={() => setMode('interactive')}>Interactive</button>
      </div>
      {mode === 'interactive' ? <>
        <span>Trusted HTML only · project scripts enabled · external assets and app APIs blocked</span>
        <button className="html-preview-reload" onClick={() => setRevision((value) => value + 1)}>Reload</button>
      </> : <>
        <span>{/<script[\s>]/i.test(content) ? 'This page uses JavaScript — choose Interactive to render it.' : 'Scripts, forms and remote assets disabled'}</span>
        {current && current.unavailable > 0 && <span>{current.unavailable} unavailable asset{current.unavailable === 1 ? '' : 's'}</span>}
        {current?.limited && <span>Asset limit reached</span>}
      </>}
    </div>
    {error ? <div className="preview-empty">Could not prepare HTML preview: {error}. Use Source to view the file.</div>
      : mode === 'interactive' ? interactive ? <iframe key={interactive.id} className="html-preview-frame" title={`Interactive HTML preview: ${path}`}
        sandbox="allow-scripts" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
        referrerPolicy="no-referrer" src={`${interactive.url}${anchor ? `#${encodeURIComponent(anchor.fragment)}` : ''}`} />
        : <div className="preview-empty" role="status">Starting isolated interactive preview…</div>
      : current ? <iframe key="static" ref={frameRef} className="html-preview-frame" title={`HTML preview: ${path}`}
        sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={current.html} onLoad={attachFrame} />
        : <div className="preview-empty" role="status">Preparing HTML preview…</div>}
  </div>
}
