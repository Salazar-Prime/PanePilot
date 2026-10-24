import { describe, expect, it } from 'vitest'
import type { FilePreview } from '../src/shared/types'
import { keepFileTab, openPreviewTab, protectFileTab, type OpenFileTab } from '../src/renderer/src/lib/fileTabs'

const tab = (path: string, temporary = true): OpenFileTab => ({
  preview: { path, content: path, binary: false, truncated: false } as FilePreview,
  draft: path, editing: false, viewMode: 'preview', temporary
})

describe('temporary file tabs', () => {
  it('reuses one preview slot instead of growing the tab strip', () => {
    const first = openPreviewTab([], tab('a.md'))
    const next = openPreviewTab(first, tab('b.html'))
    expect(next.map((file) => file.preview.path)).toEqual(['b.html'])
    expect(first[0].preview.path).toBe('a.md')
  })
  it('keeps a clicked or double-clicked file and opens later previews beside it', () => {
    const kept = keepFileTab([tab('a.md')], 'a.md')
    expect(openPreviewTab(kept, tab('b.html')).map((file) => file.temporary)).toEqual([false, true])
    expect(openPreviewTab([tab('a.md')], tab('a.md', false))[0].temporary).toBe(false)
  })
  it('replaces the same slot without moving permanent tabs or duplicating existing files', () => {
    const current = [tab('kept.md', false), tab('preview.png'), tab('other.txt', false)]
    expect(openPreviewTab(current, tab('new.pdf')).map((file) => file.preview.path)).toEqual(['kept.md', 'new.pdf', 'other.txt'])
    const revisited = openPreviewTab(current, tab('kept.md'))
    expect(revisited).toHaveLength(3)
    expect(revisited[0].temporary).toBe(false)
    expect(revisited[1]).toBe(current[1])
  })
  it('automatically protects edits, even if editing or draft state arrives during a slow read', () => {
    const editing = { ...tab('a.md'), editing: true }
    expect(protectFileTab(editing).temporary).toBe(false)
    const dirty = { ...tab('b.md'), draft: 'unsaved' }
    const result = openPreviewTab([editing, dirty], tab('c.md'))
    expect(result.map((file) => file.temporary)).toEqual([false, false, true])
    expect(result[1].draft).toBe('unsaved')
  })
  it('keeps existing drafts, edit state and view mode when revisiting a linked file', () => {
    const current = { ...tab('a.html', false), draft: 'unsaved', editing: true, viewMode: 'source' as const }
    expect(openPreviewTab([current], tab('a.html'))[0]).toEqual(current)
    expect(openPreviewTab([current], tab('a.html'), 'preview')[0]).toEqual({ ...current, viewMode: 'preview' })
  })
  it('supports non-text previews without treating them as editable', () => {
    const image = { ...tab('image.png'), preview: { ...tab('image.png').preview, binary: true, imageMimeType: 'image/png' } }
    expect(openPreviewTab([image], tab('data.bin'))).toHaveLength(1)
    expect(keepFileTab([image], 'image.png')[0].temporary).toBe(false)
  })
})
