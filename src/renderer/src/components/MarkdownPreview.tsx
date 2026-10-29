import DOMPurify from 'dompurify'
import { useEffect, useMemo, useRef } from 'react'
import {
  renderMarkdownDocument,
  resolveMarkdownTarget
} from '../lib/markdown'
import { loadMarkdownImages } from '../lib/markdownImages'

export interface MarkdownPreviewAnchor {
  fragment: string
  requestId: number
}

interface MarkdownPreviewProps {
  projectId: string
  path: string
  content: string
  anchor?: MarkdownPreviewAnchor | null
  onOpenProjectPath(path: string, fragment: string | null): void
  onError(message: string): void
}

export function MarkdownPreview({
  projectId,
  path,
  content,
  anchor = null,
  onOpenProjectPath,
  onError
}: MarkdownPreviewProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const html = useMemo(() => {
    const sanitized = DOMPurify.sanitize(renderMarkdownDocument(content), {
      ALLOW_UNKNOWN_PROTOCOLS: false,
      FORBID_ATTR: ['srcset', 'style'],
      FORBID_TAGS: [
        'audio',
        'embed',
        'form',
        'iframe',
        'object',
        'script',
        'style',
        'video'
      ],
      USE_PROFILES: { html: true }
    })
    const template = document.createElement('template')
    template.innerHTML = sanitized
    for (const image of template.content.querySelectorAll('img')) {
      const source =
        image.dataset.markdownSrc ?? image.getAttribute('src') ?? ''
      image.dataset.markdownSrc = source
      image.removeAttribute('src')
      image.removeAttribute('srcset')
      image.setAttribute('loading', 'lazy')
      image.setAttribute('decoding', 'async')
      image.setAttribute('referrerpolicy', 'no-referrer')
    }
    for (const link of template.content.querySelectorAll('a')) {
      const href = link.dataset.markdownHref ?? link.getAttribute('href') ?? ''
      link.dataset.markdownHref = href
    }
    for (const input of template.content.querySelectorAll('input')) {
      input.setAttribute('disabled', '')
    }
    return template.innerHTML
  }, [content])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    for (const input of root.querySelectorAll('input')) {
      input.disabled = true
    }
    return loadMarkdownImages(root, path, (imagePath) =>
      window.projectConsole.files.preview(projectId, imagePath)
    )
  }, [html, path, projectId])

  useEffect(() => {
    if (!anchor) return
    const frame = window.requestAnimationFrame(() => {
      const destination = [...(rootRef.current?.querySelectorAll('[id]') ?? [])]
        .find((element) => element.id === anchor.fragment)
      destination?.scrollIntoView({ block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [anchor?.requestId, html])

  function handleClick(event: React.MouseEvent<HTMLDivElement>): void {
    const clicked = event.target
    if (!(clicked instanceof Element)) return
    const link = clicked.closest<HTMLAnchorElement>('a')
    if (!link || !event.currentTarget.contains(link)) return
    const href = link.dataset.markdownHref ?? link.getAttribute('href') ?? ''
    const target = resolveMarkdownTarget(path, href)
    event.preventDefault()

    if (target.kind === 'fragment') {
      const destination = [...event.currentTarget.querySelectorAll('[id]')]
        .find((element) => element.id === target.fragment)
      destination?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    if (target.kind === 'external') {
      void window.projectConsole.system
        .openExternal(target.url)
        .catch((caught) =>
          onError(caught instanceof Error ? caught.message : String(caught))
        )
      return
    }
    if (target.kind === 'project') {
      onOpenProjectPath(target.path, target.fragment)
    }
  }

  return (
    <div className="markdown-preview-scroll">
      <article
        ref={rootRef}
        className="markdown-body"
        onClick={handleClick}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
