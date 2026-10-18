import { useEffect, useRef, useState } from 'react'
import { buildHtmlPreview, type HtmlPreviewDocument } from '../lib/htmlPreview'
import { resolveMarkdownTarget } from '../lib/markdown'
import type { MarkdownPreviewAnchor } from './MarkdownPreview'

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
  const frameRef = useRef<HTMLIFrameElement>(null)
  const detachRef = useRef<(() => void) | null>(null)
  const callbacks = useRef({ onOpenProjectPath, onError, anchor, path })
  callbacks.current = { onOpenProjectPath, onError, anchor, path }
  const current = prepared?.projectId === projectId && prepared.path === path && prepared.content === content
    ? prepared.document : null

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void buildHtmlPreview(content, path,
      (assetPath) => window.projectConsole.files.preview(projectId, assetPath), controller.signal)
      .then((document) => { if (!controller.signal.aborted) setPrepared({ projectId, path, content, document }) })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => controller.abort()
  }, [projectId, path, content])

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
      <span>Static HTML preview</span>
      <span>Scripts, forms and remote assets disabled</span>
      {current && current.unavailable > 0 && <span>{current.unavailable} unavailable asset{current.unavailable === 1 ? '' : 's'}</span>}
      {current?.limited && <span>Asset limit reached</span>}
    </div>
    {error ? <div className="preview-empty">Could not prepare HTML preview: {error}. Use Source to view the file.</div>
      : current ? <iframe ref={frameRef} className="html-preview-frame" title={`HTML preview: ${path}`}
        sandbox="allow-same-origin" referrerPolicy="no-referrer" srcDoc={current.html} onLoad={attachFrame} />
        : <div className="preview-empty" role="status">Preparing HTML preview…</div>}
  </div>
}
