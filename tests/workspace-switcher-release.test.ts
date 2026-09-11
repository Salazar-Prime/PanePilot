import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_SWITCHER_RELEASE_DELAY_MS as delay,
  WorkspaceSwitcherReleaseGuard
} from '../src/renderer/src/lib/workspaceSwitcherRelease'

const key = (overrides = {}) => ({
  type: 'keyup', key: 'Meta', metaKey: false, ctrlKey: false,
  repeat: false, isTrusted: true, ...overrides
})

describe('workspace switcher modifier release', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('stays open for an arbitrarily long hold, including repeated navigation', () => {
    const release = vi.fn()
    const guard = new WorkspaceSwitcherReleaseGuard(() => true)
    for (let index = 0; index < 50; index++) {
      guard.observe(key({ type: 'keydown', key: 'ArrowDown', metaKey: true, repeat: true }), 'Meta', release)
      vi.advanceTimersByTime(10_000)
    }
    expect(release).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['Meta', 'Control'] as const)('confirms a real %s release once', (modifier) => {
    const release = vi.fn()
    const guard = new WorkspaceSwitcherReleaseGuard(() => true)
    guard.observe(key({ key: modifier }), modifier, release)
    vi.advanceTimersByTime(delay - 1)
    expect(release).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(release).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_000)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('ignores a Command key-up that still reports Command held', () => {
    const release = vi.fn()
    const guard = new WorkspaceSwitcherReleaseGuard(() => true)
    guard.observe(key({ metaKey: true }), 'Meta', release)
    vi.advanceTimersByTime(10_000)
    expect(release).not.toHaveBeenCalled()
  })

  it.each([
    key({ type: 'keydown', metaKey: true }),
    key({ type: 'keydown', key: 'ArrowUp', metaKey: true, repeat: true }),
    key({ key: 'ArrowDown', metaKey: true })
  ])('cancels a transient release when held-key evidence arrives: %j', (event) => {
    const release = vi.fn()
    const guard = new WorkspaceSwitcherReleaseGuard(() => true)
    guard.observe(key(), 'Meta', release)
    vi.advanceTimersByTime(delay / 2)
    guard.observe(event, 'Meta', release)
    vi.advanceTimersByTime(10_000)
    expect(release).not.toHaveBeenCalled()
    guard.observe(key(), 'Meta', release)
    vi.advanceTimersByTime(delay)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it.each([
    key({ isTrusted: false }), key({ repeat: true }),
    key({ key: 'ArrowDown' }), key({ key: 'Control' })
  ])('ignores synthetic, repeated and unrelated releases: %j', (event) => {
    const release = vi.fn()
    const guard = new WorkspaceSwitcherReleaseGuard(() => true)
    guard.observe(event, 'Meta', release)
    vi.advanceTimersByTime(10_000)
    expect(release).not.toHaveBeenCalled()
  })

  it('cancels pending navigation on close, blur, or unmount', () => {
    const release = vi.fn()
    const guard = new WorkspaceSwitcherReleaseGuard(() => true)
    guard.observe(key(), 'Meta', release)
    guard.reset()
    vi.advanceTimersByTime(delay)
    expect(release).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not commit after losing focus even if no blur event was delivered', () => {
    let focused = true
    const release = vi.fn()
    const guard = new WorkspaceSwitcherReleaseGuard(() => focused)
    guard.observe(key(), 'Meta', release)
    focused = false
    vi.advanceTimersByTime(delay)
    expect(release).not.toHaveBeenCalled()
  })

  it('does not carry a release over to a new gesture', () => {
    const staleRelease = vi.fn()
    const release = vi.fn()
    const guard = new WorkspaceSwitcherReleaseGuard(() => true)
    guard.observe(key(), 'Meta', staleRelease)
    guard.reset()
    guard.observe(key({ type: 'keydown', key: 'ArrowDown', metaKey: true }), 'Meta', release)
    vi.advanceTimersByTime(delay)
    expect(staleRelease).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    guard.observe(key(), 'Meta', release)
    vi.advanceTimersByTime(delay)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
