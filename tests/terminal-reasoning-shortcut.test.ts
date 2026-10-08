import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { terminalReasoningShortcut } from '../src/renderer/src/lib/terminalReasoningShortcut'

const optionComma = { key: '≤', code: 'Comma', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false }

describe('Codex Option reasoning shortcuts', () => {
  it('converts macOS Option punctuation into exact terminal Meta sequences', () => {
    expect(terminalReasoningShortcut(optionComma, 'codex', true)).toBe('\x1b,')
    expect(terminalReasoningShortcut({ ...optionComma, key: '≥', code: 'Period' }, 'codex', true)).toBe('\x1b.')
    expect(terminalReasoningShortcut({ ...optionComma, key: ',', code: '' }, 'codex', true)).toBe('\x1b,')
    expect(terminalReasoningShortcut({ ...optionComma, key: '.', code: '' }, 'codex', true)).toBe('\x1b.')
  })
  it('leaves other profiles, operating systems, modifiers, and composition untouched', () => {
    for (const profile of ['shell', 'claude', 'custom'] as const) expect(terminalReasoningShortcut(optionComma, profile, true)).toBeNull()
    expect(terminalReasoningShortcut(optionComma, 'codex', false)).toBeNull()
    for (const change of [{ altKey: false }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { key: 'Dead' }, { code: 'KeyE', key: '´' }]) {
      expect(terminalReasoningShortcut({ ...optionComma, ...change }, 'codex', true)).toBeNull()
    }
  })
  it('routes only keydown to the focused, active, writable terminal, bypassing paste', () => {
    const view = readFileSync('src/renderer/src/components/ManagedTerminal.tsx', 'utf8')
    const handler = view.slice(view.indexOf('      const reasoningKey'), view.indexOf('      const key = event.key'))
    expect(handler).toContain("event.type === 'keydown' && activeRef.current && writableRef.current")
    expect(handler).toContain('host.contains(document.activeElement)')
    expect(handler).toContain('terminals.write(session.id, reasoningKey)')
    expect(handler).toContain('return false')
    expect(handler).not.toContain('paste(')
  })
})
