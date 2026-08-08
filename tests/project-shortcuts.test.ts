import { describe, expect, it } from 'vitest'
import {
  advanceShortcutOverlayGesture,
  directSessionIndex,
  isShortcutOverlayTap,
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
  it('recognizes only Control plus the question-mark key for the help gesture', () => {
    expect(
      isShortcutOverlayTap(
        keyEvent({ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true })
      )
    ).toBe(true)
    expect(
      isShortcutOverlayTap(
        keyEvent({ key: '?', code: 'Slash', metaKey: true, shiftKey: true })
      )
    ).toBe(false)
    expect(
      isShortcutOverlayTap(keyEvent({ key: '/', code: 'Slash', ctrlKey: true }))
    ).toBe(true)
    expect(isShortcutOverlayTap(keyEvent({ key: '?', code: 'Slash' }))).toBe(false)
  })

  it('opens help after three timely question-mark taps and then resets', () => {
    const event = keyEvent({
      key: '?',
      code: 'Slash',
      ctrlKey: true,
      shiftKey: true
    })
    const first = advanceShortcutOverlayGesture(event, { count: 0, lastTapAt: 0 }, 100)
    const second = advanceShortcutOverlayGesture(event, first.state, 500)
    const third = advanceShortcutOverlayGesture(event, second.state, 900)

    expect(first).toMatchObject({ recognized: true, triggered: false })
    expect(second).toMatchObject({ recognized: true, triggered: false })
    expect(third).toEqual({
      state: { count: 0, lastTapAt: 0 },
      recognized: true,
      triggered: true
    })
  })

  it('restarts the help gesture after its time window or another key', () => {
    const questionMark = keyEvent({
      key: '?',
      code: 'Slash',
      ctrlKey: true,
      shiftKey: true
    })
    const first = advanceShortcutOverlayGesture(
      questionMark,
      { count: 0, lastTapAt: 0 },
      100
    )
    const expired = advanceShortcutOverlayGesture(questionMark, first.state, 1_301)
    const interrupted = advanceShortcutOverlayGesture(
      keyEvent({ key: 'x', code: 'KeyX', ctrlKey: true }),
      expired.state,
      1_400
    )

    expect(expired).toMatchObject({
      state: { count: 1, lastTapAt: 1_301 },
      triggered: false
    })
    expect(interrupted).toEqual({
      state: { count: 0, lastTapAt: 0 },
      recognized: false,
      triggered: false
    })
  })

  it('does not interrupt the help gesture when Shift is pressed between taps', () => {
    const first = advanceShortcutOverlayGesture(
      keyEvent({ key: '/', code: 'Slash', ctrlKey: true }),
      { count: 0, lastTapAt: 0 },
      100
    )
    const shift = advanceShortcutOverlayGesture(
      keyEvent({ key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true }),
      first.state,
      200
    )
    const second = advanceShortcutOverlayGesture(
      keyEvent({ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }),
      shift.state,
      300
    )

    expect(shift).toMatchObject({
      state: first.state,
      recognized: false,
      triggered: false
    })
    expect(second.state.count).toBe(2)
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
