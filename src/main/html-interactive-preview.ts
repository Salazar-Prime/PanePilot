import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import type { WebContents } from 'electron'
import type { FilePreview, InteractiveHtmlPreview, OpenInteractiveHtmlInput } from '../shared/types'

export const HTML_PREVIEW_SCHEME = 'panepilot-preview'
export const HTML_PREVIEW_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
const MAX_FILES = 64
const MAX_BYTES = 32 * 1024 * 1024
const MAX_REQUESTS = 512
const MAX_PREVIEWS = 8
const MIME: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.xhtml': 'text/html',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp'
}

interface Asset { body: Buffer; mime: string }
interface Preview {
  owner: number
  projectId: string
  sourcePath: string
  source: string
  files: Map<string, Promise<Asset>>
  bytes: number
  requests: number
  running: number
  queue: Array<() => void>
  closed: boolean
}

function safePath(value: string): boolean {
  return Boolean(value) && value.length <= 4096 && !/[\\\u0000-\u001f\u007f]/.test(value) &&
    value.split('/').every((part) => part && !part.startsWith('.'))
}

export function isInteractiveHtmlUrl(value: string): boolean {
  return value.startsWith(`${HTML_PREVIEW_SCHEME}:`)
}

/** Ephemeral read-only capabilities, not a file server or application RPC endpoint. */
export class InteractiveHtmlPreviewService {
  private readonly previews = new Map<string, Preview>()
  private readonly closedOwners = new Set<number>()
  private readonly generations = new Map<number, number>()

  constructor(private readonly load: (projectId: string, path: string) => Promise<FilePreview>) {}

  async open(owner: number, input: OpenInteractiveHtmlInput): Promise<InteractiveHtmlPreview> {
    if (this.closedOwners.has(owner) || !input || typeof input.projectId !== 'string' || typeof input.path !== 'string' ||
      typeof input.content !== 'string' || !safePath(input.path) || !/\.(?:html?|xhtml)$/i.test(input.path) ||
      Buffer.byteLength(input.content) > 1024 * 1024) throw new Error('Choose a complete HTML file within the 1 MB preview limit.')
    if (this.previews.size >= MAX_PREVIEWS) throw new Error('Close another interactive HTML preview first (maximum eight).')
    // Verify the saved file's canonical boundary even when rendering an unsaved draft.
    const generation = this.generations.get(owner) ?? 0
    const saved = await this.load(input.projectId, input.path)
    if (this.closedOwners.has(owner) || generation !== (this.generations.get(owner) ?? 0)) throw new Error('Preview window closed or reloaded.')
    if (saved.binary || saved.truncated) throw new Error('This HTML file cannot be rendered interactively.')
    if (this.previews.size >= MAX_PREVIEWS) throw new Error('Too many interactive HTML previews are open.')
    const id = randomUUID()
    this.previews.set(id, {
      owner, projectId: input.projectId, sourcePath: input.path, source: input.content,
      files: new Map(), bytes: 0, requests: 0, running: 0, queue: [], closed: false
    })
    return { id, url: `${HTML_PREVIEW_SCHEME}://${id}/${input.path.split('/').map(encodeURIComponent).join('/')}` }
  }

  close(owner: number, id: string): void {
    const preview = this.previews.get(id)
    if (!preview || preview.owner !== owner) return
    preview.closed = true
    this.previews.delete(id)
    preview.files.clear()
  }

  closeOwner(owner: number): void {
    this.closedOwners.add(owner)
    this.resetOwner(owner)
  }

  resetOwner(owner: number): void {
    this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1)
    for (const [id, preview] of this.previews) if (preview.owner === owner) this.close(owner, id)
  }

  allowsNavigation(owner: number, destination: string, source: string, mainFrame: boolean): boolean {
    if (!isInteractiveHtmlUrl(source) && !isInteractiveHtmlUrl(destination)) return true
    if (mainFrame || !isInteractiveHtmlUrl(destination)) return false
    try {
      const target = new URL(destination)
      return !target.username && !target.password && !target.port && this.previews.get(target.hostname)?.owner === owner &&
        (!isInteractiveHtmlUrl(source) || new URL(source).hostname === target.hostname)
    } catch { return false }
  }

  private async asset(preview: Preview, path: string): Promise<Asset> {
    const cached = preview.files.get(path)
    if (cached) return cached
    if (preview.files.size >= MAX_FILES) throw new Error('Asset count limit reached.')
    const promise = (async () => {
      if (preview.running >= 3) await new Promise<void>((done) => preview.queue.push(done))
      preview.running++
      try {
        if (preview.closed) throw new Error('Preview closed.')
        const mime = MIME[extname(path).toLowerCase()]
        if (!mime) throw new Error('Unsupported asset type.')
        let body: Buffer
        if (path === preview.sourcePath) body = Buffer.from(preview.source)
        else {
          const file = await this.load(preview.projectId, path)
          if (preview.closed || file.truncated) throw new Error('Asset is unavailable or exceeds its preview limit.')
          if (file.imageDataUrl) {
            const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=]*)$/i.exec(file.imageDataUrl)
            if (!match) throw new Error('Invalid image asset.')
            body = Buffer.from(match[1], 'base64')
          } else {
            if (file.binary) throw new Error('Unsupported binary asset.')
            body = Buffer.from(file.content)
          }
        }
        if (preview.bytes + body.length > MAX_BYTES) throw new Error('Asset byte limit reached.')
        preview.bytes += body.length
        return { body, mime }
      } finally {
        preview.running--
        preview.queue.shift()?.()
      }
    })()
    // Rejected requests remain cached too, so a broken page cannot repeatedly scan SSH files.
    preview.files.set(path, promise)
    return promise
  }

  async handle(request: Request): Promise<Response> {
    let url: URL
    try { url = new URL(request.url) } catch { return new Response('Invalid preview URL.', { status: 400 }) }
    const preview = this.previews.get(url.hostname)
    if (url.protocol !== `${HTML_PREVIEW_SCHEME}:` || url.username || url.password || url.port || !preview) {
      return new Response('This interactive preview has closed.', { status: 404 })
    }
    const origin = `${HTML_PREVIEW_SCHEME}://${url.hostname}`
    const headers = {
      'Content-Security-Policy': `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' ${origin}; style-src 'unsafe-inline' ${origin}; img-src data: blob: ${origin}; font-src 'none'; connect-src ${origin}; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`,
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), payment=(), fullscreen=(), autoplay=(), accelerometer=(), gyroscope=(), magnetometer=()',
      'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      'X-DNS-Prefetch-Control': 'off',
      'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*'
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Read-only preview.', { status: 405, headers })
    if (++preview.requests > MAX_REQUESTS) return new Response('Request limit reached. Reload the preview.', { status: 429, headers })
    try {
      const path = decodeURIComponent(url.pathname.slice(1))
      if (!safePath(path) || !MIME[extname(path).toLowerCase()]) throw new Error('Unsupported project asset.')
      const asset = await this.asset(preview, path)
      if (preview.closed) throw new Error('Preview closed.')
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(asset.body), {
        headers: { ...headers, 'Content-Type': `${asset.mime}${asset.mime.startsWith('text/') ? '; charset=utf-8' : ''}` }
      })
    } catch {
      // Do not expose host filesystem paths, SSH diagnostics, or project secrets in a page.
      return new Response('Project asset unavailable or preview limit reached.', { status: 404, headers })
    }
  }
}

export function guardInteractiveHtmlNavigation(contents: WebContents, service: InteractiveHtmlPreviewService): void {
  const owner = contents.id
  const guard = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
    const source = [event.frame?.url, event.initiator?.url].find((url) => url && isInteractiveHtmlUrl(url)) ?? ''
    if (!service.allowsNavigation(owner, event.url, source, event.isMainFrame)) event.preventDefault()
  }
  contents.on('will-frame-navigate', guard)
  contents.on('will-redirect', guard)
  contents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) service.resetOwner(owner)
  })
  contents.on('render-process-gone', () => service.resetOwner(owner))
  contents.once('destroyed', () => service.closeOwner(owner))
}
