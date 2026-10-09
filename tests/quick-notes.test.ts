import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Store } from '../src/main/store'
import { validateQuickNotes, QUICK_NOTES_THOUGHT_LIMIT, QUICK_NOTES_ITEM_LIMIT, type QuickNotesDocument } from '../src/shared/quickNotes'
import { QuickNotesDraft } from '../src/renderer/src/lib/quickNotesDraft'

const blank = (): QuickNotesDocument => ({ revision: 0, thoughts: '', items: [] })
const sample = (): QuickNotesDocument => ({ revision: 0, thoughts: 'An idea\nKeep thinking…', items: [{ id: 'first', text: 'Remember this', checked: true }] })
const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })
function location() { const path = mkdtempSync(join(tmpdir(), 'panepilot-quick-notes-')); paths.push(path); return path }

describe('app-wide Quick Notes storage', () => {
  it('works without projects and survives closing/reopening and migration', () => {
    const path = location()
    const store = new Store(path)
    expect(store.getQuickNotes()).toEqual(blank())
    const saved = store.saveQuickNotes(sample())
    expect(saved.revision).toBe(1)
    store.close()
    const reopened = new Store(path)
    try {
      expect(reopened.getQuickNotes()).toEqual(saved)
      const removed = reopened.saveQuickNotes({ ...saved, items: [] })
      expect(reopened.getQuickNotes()).toEqual(removed)
    } finally { reopened.close() }
  })
  it('does not overwrite newer notes from a stale renderer', () => {
    const store = new Store(location())
    try {
      const saved = store.saveQuickNotes(sample())
      expect(() => store.saveQuickNotes({ ...sample(), thoughts: 'Stale text' })).toThrow('another window')
      expect(store.getQuickNotes()).toEqual(saved)
    } finally { store.close() }
  })
  it('keeps notes independent of project removal', () => {
    const path = location(), store = new Store(path)
    try {
      store.syncConnections([])
      const project = store.createProject({ type: 'terminal', name: 'Disposable project', connectionId: 'local', folder: path, repositoryUrl: null })
      const saved = store.saveQuickNotes(sample())
      store.archiveProject(project.id, true)
      store.deleteProject(project.id)
      expect(store.getQuickNotes()).toEqual(saved)
    } finally { store.close() }
  })
  it('rejects malformed or oversized documents without changing saved text', () => {
    for (const value of [null, {}, { ...blank(), revision: -1 }, { ...blank(), thoughts: 'x'.repeat(QUICK_NOTES_THOUGHT_LIMIT + 1) },
      { ...blank(), items: Array.from({ length: QUICK_NOTES_ITEM_LIMIT + 1 }, (_, id) => ({ id: String(id), text: '', checked: false })) },
      { ...sample(), items: [{ id: '../bad', text: 'x', checked: true }] },
      { ...sample(), items: [{ id: 'a', text: 'x', checked: 'yes' }] },
      { ...sample(), items: [sample().items[0], sample().items[0]] }]) expect(() => validateQuickNotes(value)).toThrow()
    expect(validateQuickNotes(sample())).toEqual(sample())
  })
})

describe('Quick Notes autosave sequencing', () => {
  it('does not save an untouched document', async () => {
    const save = vi.fn(async (document: QuickNotesDocument) => ({ ...document, revision: document.revision + 1 }))
    const model = new QuickNotesDraft(save)
    model.load(blank())
    await model.flush()
    expect(save).not.toHaveBeenCalled()
  })
  it('coalesces flushes and saves typing made during a pending write before closing', async () => {
    const finish: Array<() => void> = []
    const save = vi.fn((document: QuickNotesDocument) => new Promise<QuickNotesDocument>((resolve) => finish.push(() => resolve({ ...document, revision: document.revision + 1 }))))
    const model = new QuickNotesDraft(save)
    model.load(blank())
    model.value = { thoughts: 'First', items: [] }
    const pending = model.flush()
    model.value = { thoughts: 'Later typing', items: sample().items }
    expect(model.flush()).toBe(pending)
    expect(save).toHaveBeenCalledTimes(1)
    finish[0]()
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0]).toMatchObject({ revision: 1, thoughts: 'Later typing' })
    finish[1]()
    await pending
    expect(model.dirty).toBe(false)
    expect(model.value?.thoughts).toBe('Later typing')
  })
  it('retains drafts after a failed save and retries with the last successful revision', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('Disk full')).mockImplementation(async (document: QuickNotesDocument) => ({ ...document, revision: document.revision + 1 }))
    const model = new QuickNotesDraft(save)
    model.load(blank())
    model.value = { thoughts: 'Do not lose this', items: [] }
    await expect(model.flush()).rejects.toThrow('Disk full')
    expect(model.dirty).toBe(true)
    expect(model.value?.thoughts).toBe('Do not lose this')
    await model.flush()
    expect(save.mock.calls[1][0].revision).toBe(0)
    expect(model.dirty).toBe(false)
  })
})
