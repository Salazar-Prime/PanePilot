import { describe, expect, it } from 'vitest'
import { loadActionSelection, resolveActionSelection, saveActionSelection } from '../src/renderer/src/lib/actionSelection'

describe('remembered action selection', () => {
  it('restores the exact action, regardless of list order, and falls back if removed', () => {
    expect(resolveActionSelection([{ id: 'first' }, { id: 'last-used' }], 'last-used')).toBe('last-used')
    expect(resolveActionSelection([{ id: 'other' }], 'removed')).toBe('other')
    expect(resolveActionSelection([], 'removed')).toBeNull()
  })
  it('stores each project independently and survives reopening', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    saveActionSelection('local', 'build', storage)
    saveActionSelection('ssh', 'test', storage)
    expect(loadActionSelection('local', storage)).toBe('build')
    expect(loadActionSelection('ssh', storage)).toBe('test')
    expect(loadActionSelection('new', storage)).toBeNull()
  })
  it('keeps the UI usable if preference storage is blocked', () => {
    const blocked = { getItem: () => { throw Error('Blocked') }, setItem: () => { throw Error('Full') } }
    expect(loadActionSelection('p', blocked)).toBeNull()
    expect(() => saveActionSelection('p', 'a', blocked)).not.toThrow()
  })
})
