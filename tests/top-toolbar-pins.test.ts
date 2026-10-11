import { describe, expect, it } from 'vitest'
import { loadTopToolbarPins, saveTopToolbarPins, toggleTopToolbarPin } from '../src/renderer/src/lib/topToolbarPins'

describe('top toolbar pins', () => {
  it('keeps valid, unique pins in the chosen order', () => {
    const storage = { getItem: () => '["quick-notes","unknown","quick-notes","project-settings"]' }
    expect(loadTopToolbarPins(storage)).toEqual(['quick-notes', 'project-settings'])
  })

  it('falls back safely when a saved preference is invalid', () => {
    expect(loadTopToolbarPins({ getItem: () => '{' })).toEqual([])
    expect(loadTopToolbarPins({ getItem: () => '{}' })).toEqual([])
  })

  it('toggles a pin without rearranging the others and persists it', () => {
    const first = toggleTopToolbarPin(['quick-notes'], 'new-project')
    expect(first).toEqual(['quick-notes', 'new-project'])
    const second = toggleTopToolbarPin(first, 'quick-notes')
    expect(second).toEqual(['new-project'])
    let saved = ''
    saveTopToolbarPins(second, { setItem: (_key, value) => { saved = value } })
    expect(saved).toBe('["new-project"]')
  })
})
