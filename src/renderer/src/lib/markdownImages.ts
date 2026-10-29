import type { FilePreview } from '@shared/types'
import { resolveMarkdownTarget } from './markdown'

// Match static HTML preview admission. The byte budget counts data URL characters,
// including base64 overhead, both per unique read and when repeated in the DOM.
const MAX_PROJECT_IMAGES = 16
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_READS = 3
const FILE_LIMIT = 'Image omitted: preview supports up to 16 project images.'
const BYTE_LIMIT = 'Image omitted: preview images exceed the 16 MiB limit.'

// IPC cannot cancel a read already sent to the host. Keep its slot occupied until
// it settles, even if its document unmounts, so edits/split panes cannot multiply
// SSH reads. Queued generations are removed immediately when their owner aborts.
let runningReads = 0
const pendingReads = new Set<() => void>()

function drainReads(): void {
  while (runningReads < MAX_IMAGE_READS && pendingReads.size) {
    pendingReads.values().next().value!()
  }
}

function admittedRead(load: () => Promise<FilePreview>, signal: AbortSignal): Promise<FilePreview | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const cancel = (): void => {
      if (pendingReads.delete(start)) resolve(null)
    }
    const start = (): void => {
      pendingReads.delete(start)
      signal.removeEventListener('abort', cancel)
      runningReads++
      void (async () => {
        try { resolve(await load()) } catch { resolve(null) }
        finally {
          runningReads--
          drainReads()
        }
      })()
    }
    signal.addEventListener('abort', cancel, { once: true })
    pendingReads.add(start)
    drainReads()
  })
}

/** Own one rendered document's bounded reads. Cleanup cancels queued IPC work. */
export function loadMarkdownImages(
  root: HTMLElement,
  path: string,
  load: (path: string) => Promise<FilePreview>
): () => void {
  let active = true
  const controller = new AbortController()
  let loadedBytes = 0
  let displayedBytes = 0
  let byteLimitReached = false
  const groups = new Map<string, HTMLImageElement[]>()
  const images = [...root.querySelectorAll('img')]
  const originals = images.map((image) => ({
    image,
    title: image.getAttribute('title'),
    label: image.getAttribute('aria-label'),
    description: image.getAttribute('aria-description')
  }))

  const display = (image: HTMLImageElement, dataUrl: string): void => {
    if (displayedBytes + dataUrl.length > MAX_IMAGE_BYTES) {
      markImageUnavailable(image, BYTE_LIMIT, true)
      return
    }
    displayedBytes += dataUrl.length
    image.src = dataUrl
    image.dataset.markdownImageStatus = 'loaded'
  }

  for (const image of images) {
    const source = image.dataset.markdownSrc ?? image.getAttribute('src') ?? ''
    image.removeAttribute('src')
    image.removeAttribute('srcset')
    image.classList.remove('markdown-image-unavailable')
    image.referrerPolicy = 'no-referrer'
    image.dataset.markdownImageStatus = 'queued'
    if (source.startsWith('data:image/')) {
      display(image, source)
      continue
    }
    const target = resolveMarkdownTarget(path, source)
    if (target.kind === 'external' && target.url.startsWith('https:')) {
      image.src = target.url
      image.dataset.markdownImageStatus = 'loaded'
    } else if (target.kind !== 'project') {
      markImageUnavailable(image)
    } else {
      const group = groups.get(target.path)
      if (group) group.push(image)
      else if (groups.size < MAX_PROJECT_IMAGES) groups.set(target.path, [image])
      else markImageUnavailable(image, FILE_LIMIT, true)
    }
  }

  const queue = [...groups.entries()]
  let next = 0
  const worker = async (): Promise<void> => {
    while (active && next < queue.length) {
      const [imagePath, group] = queue[next++]
      if (byteLimitReached) {
        for (const image of group) markImageUnavailable(image, BYTE_LIMIT, true)
        continue
      }
      const preview = await admittedRead(() => load(imagePath), controller.signal)
      if (!active) return
      const dataUrl = preview?.imageDataUrl
      const limited = preview?.truncated || (dataUrl && loadedBytes + dataUrl.length > MAX_IMAGE_BYTES)
      if (limited) byteLimitReached = true
      else if (dataUrl) loadedBytes += dataUrl.length
      for (const image of group) {
        if (!root.contains(image)) continue
        if (limited) markImageUnavailable(image, BYTE_LIMIT, true)
        else if (dataUrl) display(image, dataUrl)
        else markImageUnavailable(image)
      }
    }
  }
  // Exactly three worker promises, regardless of the number of Markdown refs.
  for (let index = 0; index < Math.min(MAX_IMAGE_READS, queue.length); index++) void worker()

  return () => {
    active = false
    controller.abort()
    // Path/project changes can reuse the same sanitized DOM. Restore authored
    // metadata before the next effect evaluates those images in its new context.
    for (const { image, title, label, description } of originals) {
      if (title === null) image.removeAttribute('title')
      else image.setAttribute('title', title)
      if (label === null) image.removeAttribute('aria-label')
      else image.setAttribute('aria-label', label)
      if (description === null) image.removeAttribute('aria-description')
      else image.setAttribute('aria-description', description)
    }
  }
}

function markImageUnavailable(image: HTMLImageElement, reason = 'Image unavailable.', limited = false): void {
  image.removeAttribute('src')
  image.classList.add('markdown-image-unavailable')
  image.dataset.markdownImageStatus = limited ? 'limited' : 'unavailable'
  image.title = reason
  image.setAttribute('aria-label', image.alt ? `${image.alt}. ${reason}` : reason)
  image.setAttribute('aria-description', reason)
}
