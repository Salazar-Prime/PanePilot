import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InteractiveHtmlPreviewService } from '../src/main/html-interactive-preview'
import { previewLocalFileAsync } from '../src/main/file-service'
import type { FilePreview } from '../src/shared/types'

const file = (path: string, content = '<h1>Saved</h1>'): FilePreview => ({ path, content, binary: false, truncated: false, imageMimeType: null, imageDataUrl: null })
const input = { projectId: 'remote-project', path: 'docs/demo.html', content: '<h1>Unsaved draft</h1><script src="./demo.js"></script>' }

describe('read-only interactive HTML capabilities', () => {
  it('serves the exact unsaved draft and project-relative scripts with restrictive headers', async () => {
    const load = vi.fn(async (_project: string, path: string) => file(path, 'window.demoReady=true;'))
    const service = new InteractiveHtmlPreviewService(load)
    const preview = await service.open(1, input)
    const document = await service.handle(new Request(preview.url))
    expect(await document.text()).toBe(input.content)
    expect(document.headers.get('content-security-policy')).toContain('sandbox allow-scripts;')
    expect(document.headers.get('content-security-policy')).not.toContain('allow-same-origin')
    expect(document.headers.get('content-security-policy')).toContain("frame-src 'none'")
    expect(document.headers.get('content-security-policy')).toContain("form-action 'none'")
    expect(document.headers.get('content-security-policy')).toContain("worker-src 'none'")
    expect(document.headers.get('permissions-policy')).toContain('clipboard-read=()')
    expect(document.headers.get('cache-control')).toBe('no-store')
    const script = await service.handle(new Request(new URL('./demo.js', preview.url)))
    expect(script.headers.get('content-type')).toContain('text/javascript')
    expect(await script.text()).toBe('window.demoReady=true;')
    expect(load.mock.calls).toEqual([['remote-project', 'docs/demo.html'], ['remote-project', 'docs/demo.js']])
  })

  it('allows only GET/HEAD and whitelisted, non-hidden project assets', async () => {
    const load = vi.fn(async (_project: string, path: string) => file(path))
    const service = new InteractiveHtmlPreviewService(load)
    const preview = await service.open(1, input)
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      expect((await service.handle(new Request(preview.url, { method }))).status).toBe(405)
    }
    for (const path of ['/.env', '/.git/config', '/private.pem', '/%2fetc/passwd', '/docs/%2eprivate.js', '/docs/%5c..%5csecret.js']) {
      expect((await service.handle(new Request(new URL(path, preview.url)))).status).toBe(404)
    }
    expect(load).toHaveBeenCalledTimes(1)
    expect((await service.handle(new Request(preview.url, { method: 'HEAD' }))).body).toBeNull()
  })

  it('coalesces reads and keeps SSH resource concurrency bounded to three', async () => {
    let running = 0, max = 0
    const load = vi.fn(async (_project: string, path: string) => {
      running++; max = Math.max(max, running)
      await new Promise((done) => setTimeout(done, 3))
      running--; return file(path, '/* script */')
    })
    const service = new InteractiveHtmlPreviewService(load)
    const preview = await service.open(1, input)
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => service.handle(new Request(new URL(`file${i % 6}.js`, preview.url)))))
    expect(responses.every((response) => response.status === 200)).toBe(true)
    expect(load).toHaveBeenCalledTimes(7)
    expect(max).toBe(3)
  })

  it('rejects invalid, missing, oversized or truncated starting documents', async () => {
    const service = new InteractiveHtmlPreviewService(async (_project, path) => file(path))
    for (const path of ['../demo.html', '/demo.html', '.hidden/demo.html', 'demo.js']) {
      await expect(service.open(1, { ...input, path })).rejects.toThrow()
    }
    await expect(service.open(1, { ...input, content: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow()
    await expect(new InteractiveHtmlPreviewService(async () => { throw new Error('Missing file') }).open(1, input)).rejects.toThrow('Missing file')
    await expect(new InteractiveHtmlPreviewService(async () => ({ ...file(input.path), truncated: true })).open(1, input)).rejects.toThrow()
  })

  it('revokes tokens only for their owning window and never exposes loader diagnostics', async () => {
    const service = new InteractiveHtmlPreviewService(async (_project, path) => {
      if (path.endsWith('.js')) throw new Error('secret SSH host /private/path/key')
      return file(path)
    })
    const preview = await service.open(1, input)
    const missing = await service.handle(new Request(new URL('missing.js', preview.url)))
    expect(await missing.text()).not.toMatch(/secret|private|SSH/)
    service.close(2, preview.id)
    expect((await service.handle(new Request(preview.url))).status).toBe(200)
    service.close(1, preview.id)
    expect((await service.handle(new Request(preview.url))).status).toBe(404)
  })

  it('does not issue a late token after its window is destroyed', async () => {
    let resolve!: (value: FilePreview) => void
    const service = new InteractiveHtmlPreviewService(() => new Promise((done) => { resolve = done }))
    const pending = service.open(1, input)
    service.closeOwner(1)
    resolve(file(input.path))
    await expect(pending).rejects.toThrow('closed')
  })

  it('revokes pending and existing previews on renderer reload while permitting fresh opt-ins', async () => {
    let release!: (value: FilePreview) => void
    const service = new InteractiveHtmlPreviewService(async (_project, path) => path === 'docs/slow.html'
      ? new Promise<FilePreview>((done) => { release = done }) : file(path))
    const old = await service.open(1, input)
    const pending = service.open(1, { ...input, path: 'docs/slow.html' })
    service.resetOwner(1)
    release(file('docs/slow.html'))
    await expect(pending).rejects.toThrow('reloaded')
    expect((await service.handle(new Request(old.url))).status).toBe(404)
    const fresh = await service.open(1, input)
    expect((await service.handle(new Request(fresh.url))).status).toBe(200)
  })

  it('blocks app-frame navigation, escaped URLs, cross-preview hops, and stale tokens', async () => {
    const service = new InteractiveHtmlPreviewService(async (_project, path) => file(path))
    const a = await service.open(1, input), b = await service.open(1, input)
    expect(service.allowsNavigation(1, a.url, 'about:blank', false)).toBe(true)
    expect(service.allowsNavigation(1, new URL('next.html', a.url).href, a.url, false)).toBe(true)
    for (const destination of ['https://example.com', 'file:///etc/passwd', 'data:text/html,unsafe', 'about:blank', b.url]) {
      expect(service.allowsNavigation(1, destination, a.url, false)).toBe(false)
    }
    expect(service.allowsNavigation(1, a.url, '', true)).toBe(false)
    expect(service.allowsNavigation(2, a.url, '', false)).toBe(false)
    service.closeOwner(1)
    expect(service.allowsNavigation(1, a.url, '', false)).toBe(false)
  })

  it('bounds asset counts and cumulative bytes, including failed reads', async () => {
    const service = new InteractiveHtmlPreviewService(async (_project, path) => file(path))
    const preview = await service.open(1, input)
    for (let i = 0; i < 64; i++) expect((await service.handle(new Request(new URL(`${i}.js`, preview.url)))).status).toBe(200)
    expect((await service.handle(new Request(new URL('65.js', preview.url)))).status).toBe(404)
    const big = new InteractiveHtmlPreviewService(async (_project, path) => file(path, 'x'.repeat(1024 * 1024)))
    const large = await big.open(1, input)
    for (let i = 0; i < 32; i++) expect((await big.handle(new Request(new URL(`${i}.js`, large.url)))).status).toBe(200)
    expect((await big.handle(new Request(new URL('overflow.js', large.url)))).status).toBe(404)
  })

  it('caps preview instances and repeat requests without growing memory indefinitely', async () => {
    const service = new InteractiveHtmlPreviewService(async (_project, path) => file(path))
    const opened = await Promise.all(Array.from({ length: 8 }, () => service.open(1, input)))
    await expect(service.open(1, input)).rejects.toThrow('maximum eight')
    for (let i = 0; i < 512; i++) expect((await service.handle(new Request(opened[0].url))).status).toBe(200)
    expect((await service.handle(new Request(opened[0].url))).status).toBe(429)
    service.close(1, opened[0].id)
    expect((await service.open(1, input)).id).not.toBe(opened[0].id)
  })

  it('decodes image assets without exposing data URL metadata as file contents', async () => {
    const service = new InteractiveHtmlPreviewService(async (_project, path) => path.endsWith('.png')
      ? { ...file(path), binary: true, imageMimeType: 'image/png', imageDataUrl: 'data:image/png;base64,Ynl0ZXM=' }
      : file(path))
    const preview = await service.open(1, input)
    const image = await service.handle(new Request(new URL('image.png', preview.url)))
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(await image.text()).toBe('bytes')
  })
})

describe('asynchronous local interactive asset containment', () => {
  const roots: string[] = []
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
  it('reads UTF-8 sibling scripts but rejects an escaping symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'panepilot-html-assets-')); roots.push(root)
    await mkdir(join(root, 'project'))
    await writeFile(join(root, 'project', 'demo.js'), 'window.label="Hello 🌈"')
    await writeFile(join(root, 'outside.js'), 'private')
    await symlink(join(root, 'outside.js'), join(root, 'project', 'escape.js'))
    expect((await previewLocalFileAsync(join(root, 'project'), 'demo.js')).content).toBe('window.label="Hello 🌈"')
    await expect(previewLocalFileAsync(join(root, 'project'), 'escape.js')).rejects.toThrow('outside')
    await expect(previewLocalFileAsync(join(root, 'project'), '.')).rejects.toThrow('not a file')
  })

  it('retains the existing text truncation limit instead of loading an unbounded script', async () => {
    const root = await mkdtemp(join(tmpdir(), 'panepilot-html-assets-')); roots.push(root)
    await writeFile(join(root, 'large.js'), 'x'.repeat(1024 * 1024 + 1))
    const result = await previewLocalFileAsync(root, 'large.js')
    expect(result.truncated).toBe(true)
    expect(result.content.length).toBe(1024 * 1024)
  })
})
