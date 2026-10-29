import { describe, expect, it } from 'vitest'
import { FilesWorkspaceCache, restoreEvictedPreview, type CachedFileTab } from '../src/renderer/src/lib/filesWorkspaceCache'

const image = (path = 'image.png', length = 20): CachedFileTab => ({
  preview: { path, content: '', imageDataUrl: 'x'.repeat(length), imageMimeType: 'image/png', binary: true, truncated: false },
  draft: '', editing: false, viewMode: 'preview', temporary: true
})
const snapshot = (openFiles: CachedFileTab[]) => ({ openFiles, activeFilePath: openFiles[0]?.preview.path, path: 'folder', searchQuery: 'image' })

describe('Files workspace image payload cache', () => {
  it('evicts least recently used inactive payloads while retaining complete tab/navigation metadata', () => {
    const cache = new FilesWorkspaceCache<ReturnType<typeof snapshot>>(80)
    const original = snapshot([image('first.png')])
    cache.set('first', original)
    cache.set('second', snapshot([image('second.png')]))
    cache.get('first')
    cache.set('third', snapshot([image('third.png')]))
    expect(cache.get('second')!.openFiles[0]).toEqual({ ...image('second.png'), preview: { ...image('second.png').preview, imageDataUrl: null }, previewEvicted: true })
    expect(cache.get('first')).toBe(original)
    expect(cache.get('second')!.path).toBe('folder')
    expect(cache.get('second')!.searchQuery).toBe('image')
    expect(cache.get('second')!.activeFilePath).toBe('second.png')
    expect(original.openFiles[0].preview.imageDataUrl).toHaveLength(20)
  })

  it('pins each mounted owner until the final pane unmounts, and releases oversized payloads', () => {
    const cache = new FilesWorkspaceCache<ReturnType<typeof snapshot>>(10)
    const releaseLeft = cache.acquire('project')
    const releaseRight = cache.acquire('project')
    cache.set('project', snapshot([image()]))
    releaseLeft()
    releaseLeft()
    expect(cache.get('project')!.openFiles[0].preview.imageDataUrl).toHaveLength(20)
    releaseRight()
    expect(cache.get('project')!.openFiles[0].preview.imageDataUrl).toBeNull()
    expect(cache.get('project')!.openFiles[0].previewEvicted).toBe(true)
  })

  it('preserves text originals, dirty drafts, editing state, and temporary-tab decisions under pressure', () => {
    const cache = new FilesWorkspaceCache<ReturnType<typeof snapshot>>(0)
    const dirty = { ...image('dirty.png'), draft: 'unsaved', temporary: false }
    const editing = { ...image('editing.png'), editing: true }
    const text = { ...image('source.md'), preview: { ...image().preview, path: 'source.md', content: 'original text', binary: false, imageDataUrl: null, imageMimeType: null }, draft: 'modified text', editing: true }
    const clean = { ...image('clean.png'), temporary: false }
    cache.set('project', snapshot([dirty, editing, text, clean]))
    const cached = cache.get('project')!.openFiles
    expect(cached.slice(0, 3)).toEqual([dirty, editing, text])
    expect(cached[0]).toBe(dirty)
    expect(cached[3].temporary).toBe(false)
    expect(cached[3].previewEvicted).toBe(true)
  })

  it('rehydrates only the exact evicted tab without changing its mode or keep-open choice', () => {
    const evicted = { ...image(), temporary: false, viewMode: 'source' as const, preview: { ...image().preview, imageDataUrl: null }, previewEvicted: true }
    const restored = restoreEvictedPreview(evicted, image().preview)
    expect(restored).toEqual({ ...evicted, preview: image().preview, previewEvicted: false })
    expect(restoreEvictedPreview(evicted, image('renamed.png').preview)).toBe(evicted)
    const changed = { ...evicted, draft: 'new draft' }
    expect(restoreEvictedPreview(changed, image().preview)).toBe(changed)
    const alreadyLoaded = image()
    expect(restoreEvictedPreview(alreadyLoaded, image().preview)).toBe(alreadyLoaded)
  })
})
