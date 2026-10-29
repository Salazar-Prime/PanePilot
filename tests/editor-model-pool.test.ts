import { describe, expect, it } from 'vitest'
import { EditorModelPool } from '../src/renderer/src/lib/editorModelPool'
import { LatexSourceCache } from '../src/renderer/src/lib/latexSourceCache'

class Model {
  disposed = false
  listeners = new Set<() => void>()
  constructor(public value: string) {}
  getValue() { return this.value }
  getValueLength() { return this.value.length }
  setValue(value: string) { this.value = value; for (const listener of this.listeners) listener() }
  isDisposed() { return this.disposed }
  dispose() { this.disposed = true }
  onDidChangeContent(listener: () => void) { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener) } } }
}

describe('editor model ownership', () => {
  it('refreshes retained clean content but never overwrites a live dirty draft with stale props', () => {
    const pool = new EditorModelPool<Model, null>()
    const model = new Model('old saved')
    pool.acquire('note', model, 'old saved', 'old saved')
    pool.release('note', null)
    pool.acquire('note', model, 'new saved', 'new saved')
    expect(model.getValue()).toBe('new saved')
    pool.acquire('note', model, 'stale saved', 'stale saved')
    expect(model.getValue()).toBe('new saved')
    model.setValue('unsaved typing')
    pool.acquire('note', model, 'new saved', 'new saved')
    expect(model.getValue()).toBe('unsaved typing')
  })

  it('pins live split panes until the final owner releases, then evicts oldest clean models', () => {
    const pool = new EditorModelPool<Model, { line: number }>(1)
    const shared = new Model('saved')
    pool.acquire('shared', shared, 'saved')
    pool.acquire('shared', shared, 'saved')
    pool.release('shared', { line: 12 })
    for (let i = 0; i < 40; i++) {
      pool.acquire(`source-${i}`, new Model('saved'), 'saved')
      pool.release(`source-${i}`, null)
    }
    pool.sweep()
    expect(shared.disposed).toBe(false)
    expect(pool.acquire('shared', shared, 'saved')).toEqual({ line: 12 })
    pool.release('shared', null)
    pool.release('shared', null)
    pool.acquire('last', new Model('saved'), 'saved')
    pool.release('last', null)
    pool.sweep()
    expect(shared.disposed).toBe(true)
    expect(pool.size).toBe(1)
  })

  it('never evicts a dirty source after more than 32 other models or a second pane', () => {
    const pool = new EditorModelPool<Model, null>()
    const draft = new Model('saved')
    pool.acquire('draft', draft, 'saved')
    draft.setValue('unsaved typing')
    pool.release('draft', null)
    for (let i = 0; i < 50; i++) {
      pool.acquire(`${i}`, new Model('clean'), 'clean')
      pool.release(`${i}`, null)
    }
    pool.sweep()
    expect(draft.disposed).toBe(false)
    expect(pool.size).toBe(33)
    pool.acquire('draft', draft, 'saved')
    pool.acquire('draft', draft, 'saved')
    pool.forget('draft')
    pool.release('draft', null)
    pool.release('draft', null)
    pool.sweep()
    expect(draft.disposed).toBe(false)
    pool.discard('draft', 'saved')
    pool.sweep()
    expect(draft.getValue()).toBe('saved')
  })

  it('bounds clean text bytes independently of count and releases explicit closed drafts', () => {
    const pool = new EditorModelPool<Model, null>(32, 32)
    const models = [new Model('12345'), new Model('12345')]
    models.forEach((model, i) => { pool.acquire(`${i}`, model, model.value); pool.release(`${i}`, null) })
    pool.sweep()
    expect(models[0].disposed).toBe(true)
    expect(models[1].disposed).toBe(false)
    const owner = {}
    pool.acquire('dirty', new Model('draft'), 'saved', 'draft', owner)
    pool.forget('dirty', owner)
    pool.sweep()
    expect(pool.size).toBe(2)
    pool.release('dirty', null, owner)
    pool.sweep()
    expect(pool.size).toBe(1)
  })

  it('does not let an inactive tab forget another pane’s sole live dirty model', () => {
    const pool = new EditorModelPool<Model, null>(0)
    const owner = {}
    const model = new Model('draft')
    pool.acquire('shared', model, 'saved', 'draft', owner)
    pool.forget('shared')
    pool.forget('shared', {})
    pool.release('shared', null, owner)
    pool.sweep()
    expect(model.disposed).toBe(false)
  })
})

describe('LaTeX source snapshots', () => {
  it('retains early dirty drafts and their update guards beyond the clean cache limit', () => {
    const evicted: string[] = []
    const cache = new LatexSourceCache((key) => evicted.push(key))
    cache.set('early-draft', { savedContent: 'saved', draft: 'unsaved' })
    for (let i = 0; i < 50; i++) cache.set(`${i}`, { savedContent: 'clean', draft: 'clean' })
    expect(cache.get('early-draft')?.draft).toBe('unsaved')
    expect(cache.size).toBe(33)
    expect(evicted).toHaveLength(18)
    expect(evicted).not.toContain('early-draft')
  })

  it('bounds clean bytes while never applying that budget to unsaved user content', () => {
    const cache = new LatexSourceCache(() => {}, 32, 16)
    cache.set('dirty', { savedContent: 'a', draft: 'large unsaved draft' })
    cache.set('clean', { savedContent: 'large clean text', draft: 'large clean text' })
    expect(cache.has('dirty')).toBe(true)
    expect(cache.has('clean')).toBe(false)
  })
})
