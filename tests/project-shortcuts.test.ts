import { describe, expect, it } from 'vitest'
import {
  directSessionIndex,
  isShortcutOverlayToggle,
  keyTipActionKey,
  keyTipSessionIndex,
  sessionCycleDirection
} from '../src/renderer/src/lib/projectShortcuts'

function keyEvent(overrides: Partial<{
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}> = {}) {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('project keyboard shortcuts', () => {
  it('uses Command or Control plus slash for the KeyTips overlay', () => {
    expect(
      isShortcutOverlayToggle(keyEvent({ key: '/', code: 'Slash', metaKey: true }))
    ).toBe(true)
    expect(
      isShortcutOverlayToggle(keyEvent({ key: '/', code: 'Slash', ctrlKey: true }))
    ).toBe(true)
    expect(
      isShortcutOverlayToggle(
        keyEvent({ key: '/', code: 'Slash', metaKey: true, shiftKey: true })
      )
    ).toBe(false)
  })

  it('maps direct and overlay number keys to zero-based session indexes', () => {
    expect(
      directSessionIndex(keyEvent({ key: '4', code: 'Digit4', metaKey: true }))
    ).toBe(3)
    expect(directSessionIndex(keyEvent({ key: '4', code: 'Digit4' }))).toBeNull()
    expect(keyTipSessionIndex(keyEvent({ key: '9', code: 'Digit9' }))).toBe(8)
    expect(
      keyTipSessionIndex(keyEvent({ key: '9', code: 'Digit9', ctrlKey: true }))
    ).toBeNull()
  })

  it('supports bracket and Page Up/Page Down tab cycling', () => {
    expect(
      sessionCycleDirection(
        keyEvent({ code: 'BracketLeft', metaKey: true, shiftKey: true })
      )
    ).toBe(-1)
    expect(
      sessionCycleDirection(
        keyEvent({ code: 'BracketRight', ctrlKey: true, shiftKey: true })
      )
    ).toBe(1)
    expect(sessionCycleDirection(keyEvent({ code: 'PageUp', ctrlKey: true }))).toBe(
      -1
    )
    expect(
      sessionCycleDirection(keyEvent({ code: 'PageDown', ctrlKey: true }))
    ).toBe(1)
  })

  it('accepts unmodified letters only while routing KeyTips', () => {
    expect(keyTipActionKey(keyEvent({ key: 'Q', code: 'KeyQ' }))).toBe('q')
    expect(
      keyTipActionKey(keyEvent({ key: 'q', code: 'KeyQ', metaKey: true }))
    ).toBeNull()
  })
})
