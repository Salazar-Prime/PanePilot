import DOMPurify from 'dompurify'
import type { FilePreview } from '@shared/types'
import { resolveMarkdownTarget } from './markdown'

export function isHtmlPath(path: string): boolean {
  return /\.(?:html?|xhtml)$/i.test(path)
}

// This CSP is additional to the app CSP. The iframe also has no script/form permissions.
const PREVIEW_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
const MAX_ASSETS = 16
const MAX_INLINE_BYTES = 16 * 1024 * 1024
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)[;,]/i

export interface HtmlPreviewDocument {
  html: string
  unavailable: number
  limited: boolean
}

/** Build in an inert document, never the app DOM. Only project-bounded IPC reads are allowed. */
export async function buildHtmlPreview(
  content: string,
  path: string,
  load: (path: string) => Promise<FilePreview>,
  signal: AbortSignal
): Promise<HtmlPreviewDocument> {
  const root = DOMPurify.sanitize(content, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    ADD_TAGS: ['link'],
    FORBID_TAGS: ['script', 'base', 'meta', 'iframe', 'frame', 'frameset', 'object', 'embed',
      'portal', 'fencedframe', 'audio', 'video', 'source', 'track', 'foreignObject',
      'animate', 'animateMotion', 'animateTransform', 'set'],
    FORBID_ATTR: ['srcset', 'srcdoc', 'action', 'formaction', 'target', 'download', 'ping', 'nonce', 'autofocus'],
    ALLOW_UNKNOWN_PROTOCOLS: false
  }) as HTMLHtmlElement
  let unavailable = 0
  let limited = false
  let loadedBytes = 0
  let inlineBytes = content.length * 2
  let running = 0
  const queue: Array<() => void> = []
  const assets = new Map<string, Promise<FilePreview | null>>()
  const acquire = () => new Promise<void>((done) => {
    if (running < 3) { running++; done() }
    else queue.push(() => { running++; done() })
  })
  const asset = (assetPath: string): Promise<FilePreview | null> => {
    const cached = assets.get(assetPath)
    if (cached) return cached
    if (assets.size >= MAX_ASSETS) { limited = true; return Promise.resolve(null) }
    const promise = (async () => {
      await acquire()
      try {
        if (signal.aborted) return null
        const preview = await load(assetPath)
        const bytes = preview.imageDataUrl?.length ?? preview.content.length * 2
        if (preview.truncated || loadedBytes + bytes > MAX_INLINE_BYTES) {
          limited = true
          return null
        }
        loadedBytes += bytes
        return preview
      } catch { return null }
      finally { running--; queue.shift()?.() }
    })()
    assets.set(assetPath, promise)
    return promise
  }
  const reserve = (value: string): string | null => {
    // Repeating one large image/stylesheet must not expand a small HTML file without bound.
    if (inlineBytes + value.length > MAX_INLINE_BYTES) { limited = true; return null }
    inlineBytes += value.length
    return value
  }
  const imageUrl = async (source: string, basePath: string): Promise<string | null> => {
    if (DATA_IMAGE.test(source)) return reserve(source)
    const target = resolveMarkdownTarget(basePath, source)
    if (target.kind !== 'project') return null
    const preview = await asset(target.path)
    return preview?.imageDataUrl && DATA_IMAGE.test(preview.imageDataUrl) ? reserve(preview.imageDataUrl) : null
  }
  const css = async (source: string, basePath: string): Promise<string> => {
    // Imports are deliberately not fetched. CSP also blocks escaped/unsupported remote URLs.
    const withoutImports = source.replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;?/gi, '')
    const urls = [...withoutImports.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi)]
    const replacements = await Promise.all(urls.map(async (match) => {
      const value = (match[1] ?? match[2] ?? match[3] ?? '').trim()
      if (value.startsWith('#')) return match[0]
      const resolved = await imageUrl(value, basePath)
      if (!resolved) unavailable++
      return resolved ? `url("${resolved.replace(/"/g, '%22')}")` : 'none'
    }))
    let index = 0
    const result = withoutImports.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi,
      () => replacements[index++]).replace(/<\/style/gi, '<\\/style')
    return reserve(result) ?? ''
  }

  const jobs: Promise<void>[] = []
  for (const element of [root, ...root.querySelectorAll('*')]) {
    // Never trust file-supplied routing metadata or let non-image resources load implicitly.
    element.removeAttribute('data-preview-href')
    const tag = element.localName.toLowerCase()
    const source = element.getAttribute('src') ?? element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? ''
    element.removeAttribute('src')
    element.removeAttribute('xlink:href')
    if (tag === 'a' || tag === 'area') {
      element.setAttribute('data-preview-href', source)
      element.setAttribute('href', '#')
    } else if (tag !== 'link') {
      // Preserve SVG fragment references, never remote/file navigation or image requests.
      if (!source.startsWith('#')) element.removeAttribute('href')
    }
    if (tag === 'img' || tag === 'image') {
      element.removeAttribute('href')
      jobs.push((async () => {
        const resolved = await imageUrl(source, path)
        if (resolved) element.setAttribute(tag === 'img' ? 'src' : 'href', resolved)
        else if (source) unavailable++
      })())
    }
    if (tag === 'link') {
      const replacement = root.ownerDocument.createElement('style')
      if (element.getAttribute('rel')?.toLowerCase() === 'stylesheet') {
        const target = resolveMarkdownTarget(path, source)
        const media = element.getAttribute('media')
        if (media) replacement.setAttribute('media', media)
        element.replaceWith(replacement)
        jobs.push((async () => {
          const preview = target.kind === 'project' ? await asset(target.path) : null
          if (preview && !preview.binary && !preview.imageMimeType) replacement.textContent = await css(preview.content, target.kind === 'project' ? target.path : path)
          else unavailable++
        })())
      } else element.remove()
    }
    if (tag === 'style') jobs.push((async () => { element.textContent = await css(element.textContent ?? '', path) })())
    const style = element.getAttribute('style')
    if (style) jobs.push((async () => { element.setAttribute('style', await css(style, path)) })())
    if (['input', 'button', 'select', 'textarea'].includes(tag)) element.setAttribute('disabled', '')
    element.removeAttribute('contenteditable')
  }
  await Promise.all(jobs)
  if (signal.aborted) throw new DOMException('Preview canceled', 'AbortError')
  const head = root.querySelector('head')!
  const policy = root.ownerDocument.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', PREVIEW_CSP)
  head.prepend(policy)
  const charset = root.ownerDocument.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  head.prepend(charset)
  return { html: `<!doctype html>\n${root.outerHTML}`, unavailable, limited }
}
