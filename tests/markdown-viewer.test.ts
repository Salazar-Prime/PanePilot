import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'
import { readMarkdownViewerFile } from '../src/main/markdown-viewer'
import { MARKDOWN_PREVIEW_BYTE_LIMIT } from '../src/shared/markdownViewer'

const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })
function location() { const root = mkdtempSync(join(tmpdir(), 'panepilot-markdown-viewer-')); paths.push(root); return root }

describe('app-wide Markdown preview history', () => {
  it('keeps up to 50 unique snapshots, promotes repeats, and sends only summaries in the list', () => {
    const store = new Store(location())
    try {
      const entries = Array.from({ length: 51 }, (_, i) => store.addMarkdownPreview(`# Preview ${i}\n\nBody ${i}`, 'clipboard'))
      const summaries = store.listMarkdownPreviews()
      expect(summaries).toHaveLength(50)
      expect(summaries[0].id).toBe(entries[50].id)
      expect(summaries.at(-1)?.id).toBe(entries[1].id)
      expect(summaries.every((entry) => !('content' in entry))).toBe(true)
      expect(() => store.getMarkdownPreview(entries[0].id)).toThrow('no longer')
      const repeated = store.addMarkdownPreview(entries[12].content, 'clipboard')
      expect(repeated.id).toBe(entries[12].id)
      expect(store.listMarkdownPreviews()[0].id).toBe(entries[12].id)
      expect(store.listMarkdownPreviews()).toHaveLength(50)
    } finally { store.close() }
  })

  it('retains content across restarts and project deletion; removal only deletes the selected snapshot', () => {
    const root = location()
    let store = new Store(root)
    store.syncConnections([])
    const project = store.createProject({ type: 'terminal', name: 'Disposable', connectionId: 'local', folder: root, repositoryUrl: null })
    const clip = store.addMarkdownPreview('# Clipboard\n\nSaved text', 'clipboard')
    const file = store.addMarkdownPreview('# From file', 'file', join(root, 'README.md'))
    store.archiveProject(project.id, true)
    store.deleteProject(project.id)
    store.close()
    store = new Store(root)
    try {
      expect(store.getMarkdownPreview(clip.id)).toEqual(clip)
      expect(store.getMarkdownPreview(file.id)).toEqual(file)
      store.removeMarkdownPreview(file.id)
      expect(store.listMarkdownPreviews().map((row) => row.id)).toEqual([clip.id])
      expect(store.getMarkdownPreview(clip.id)).toEqual(clip)
    } finally { store.close() }
  })

  it('keeps file revisions separately and derives readable bounded titles without modifying Markdown', () => {
    const store = new Store(location())
    try {
      const first = store.addMarkdownPreview('# Old', 'file', '/fixture/notes.md')
      const second = store.addMarkdownPreview('# New', 'file', '/fixture/notes.md')
      expect(first.id).not.toBe(second.id)
      expect(first.title).toBe('notes.md')
      const content = '# ' + '😀'.repeat(120) + '\n\n```js\nconst x = 1;\n```'
      const saved = store.addMarkdownPreview(content, 'clipboard')
      expect(saved.title.length).toBeLessThanOrEqual(100)
      expect(saved.content).toBe(content)
      expect(saved.sourcePath).toBeNull()
    } finally { store.close() }
  })

  it('rejects empty, binary, oversized UTF-8 text and invalid IDs without touching history', () => {
    const store = new Store(location())
    try {
      const good = store.addMarkdownPreview('# Keep', 'clipboard')
      for (const content of ['', '  \n', 'bad\0data', 'x'.repeat(MARKDOWN_PREVIEW_BYTE_LIMIT + 1), '😀'.repeat(MARKDOWN_PREVIEW_BYTE_LIMIT / 4 + 1)]) {
        expect(() => store.addMarkdownPreview(content, 'clipboard')).toThrow()
      }
      expect(() => store.addMarkdownPreview('Text', 'file')).toThrow('path')
      expect(() => store.getMarkdownPreview('../wrong')).toThrow('Invalid')
      expect(() => store.removeMarkdownPreview('0'.repeat(64))).toThrow('no longer')
      expect(store.listMarkdownPreviews().map((row) => row.id)).toEqual([good.id])
    } finally { store.close() }
  })
})

describe('explicit native Markdown file selection', () => {
  it('reads a bounded UTF-8 snapshot asynchronously without changing the selected file', async () => {
    const root = location(), path = join(root, 'Read me.md'), content = '# Hello 😀\n\n- [x] Done'
    writeFileSync(path, content)
    expect(await readMarkdownViewerFile(path)).toEqual({ path: realpathSync(path), content })
    expect(readFileSync(path, 'utf8')).toBe(content)
  })

  it('rejects binary, non-UTF-8, non-Markdown and oversized files', async () => {
    const root = location()
    const cases = [
      ['binary.md', Buffer.from('bad\0data')], ['invalid.md', Buffer.from([0xc3, 0x28])],
      ['other.txt', Buffer.from('# Text')], ['huge.md', Buffer.alloc(MARKDOWN_PREVIEW_BYTE_LIMIT + 1)]
    ] as const
    for (const [name, content] of cases) {
      const path = join(root, name)
      writeFileSync(path, content)
      await expect(readMarkdownViewerFile(path)).rejects.toThrow()
    }
  })
})
