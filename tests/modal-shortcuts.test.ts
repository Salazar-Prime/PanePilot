import { describe, expect, it } from 'vitest'
import { modalShortcutAction } from '../src/renderer/src/lib/modalShortcuts'

const plain = {
  code: 'Digit1',
  key: '1',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false
}

describe('modal shortcuts', () => {
  it('numbers controls by their one-based Command or Control digit', () => {
    expect(modalShortcutAction({ ...plain, metaKey: true })).toEqual({ kind: 'control', index: 0 })
    expect(modalShortcutAction({ ...plain, code: 'Digit3', key: '3', ctrlKey: true })).toEqual({ kind: 'control', index: 2 })
    expect(modalShortcutAction({ ...plain, code: 'Digit9', key: '9', metaKey: true })).toEqual({ kind: 'control', index: 8 })
  })

  it('reserves Command or Control Enter for the modal submit action', () => {
    expect(modalShortcutAction({ ...plain, code: 'Enter', key: 'Enter', metaKey: true })).toEqual({ kind: 'submit' })
    expect(modalShortcutAction({ ...plain, code: 'NumpadEnter', key: 'Enter', ctrlKey: true })).toEqual({ kind: 'submit' })
  })

  it('leaves unmodified, shifted, Alt, repeated, and composing keys alone', () => {
    expect(modalShortcutAction(plain)).toBeNull()
    expect(modalShortcutAction({ ...plain, metaKey: true, altKey: true })).toBeNull()
    expect(modalShortcutAction({ ...plain, metaKey: true, shiftKey: true })).toBeNull()
    expect(modalShortcutAction({ ...plain, metaKey: true, repeat: true })).toBeNull()
    expect(modalShortcutAction({ ...plain, metaKey: true, isComposing: true })).toBeNull()
    expect(modalShortcutAction({ ...plain, code: 'Digit0', key: '0', metaKey: true })).toBeNull()
  })
})
