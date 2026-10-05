import { describe, expect, it } from 'vitest'
import { safeTerminalText, subagentTranscript, SUBAGENTS_PER_PAGE } from '../src/renderer/src/lib/subagentTerminal'
import { terminalTheme } from '../src/renderer/src/lib/terminalTheme'

describe('read-only sub-agent terminal formatting', () => {
  it('preserves standard, 256-color, and RGB SGR styling', () => {
    const text = '\x1b[31mError\x1b[0m \x1b[38;5;42mSuccess\x1b[0m \x1b[38;2;1;2;3mRGB\x1b[0m'
    expect(safeTerminalText(text)).toBe(text)
    expect(safeTerminalText('\x9b32mGreen\x9b0m')).toBe('\x1b[32mGreen\x1b[0m')
  })
  it('strips clipboard, hyperlinks, device requests, cursor movement, and screen erasure', () => {
    expect(safeTerminalText('Before\x1b]52;c;c2VjcmV0\x07After')).toBe('BeforeAfter')
    expect(safeTerminalText('\x1b]8;;https://example.com\x1b\\Link\x1b]8;;\x1b\\')).toBe('Link')
    expect(safeTerminalText('\x1b[2J\x1b[H\x1b[6n\x1b[?1049h\x1bPignored\x1b\\Text\x07\x08')).toBe('Text')
    expect(safeTerminalText('Hello\x1b]52;c;unterminated')).toBe('Hello')
  })
  it('keeps lines and tabs while preventing carriage-return overwrites', () => {
    expect(safeTerminalText('one\r\ntwo\rthree\tfour')).toBe('one\ntwo\nthree\tfour')
  })
  it('formats commands like terminal commands, colors messages, and keeps result colors', () => {
    const transcript = subagentTranscript([
      { kind: 'message', text: 'Checking tests', timestamp: null },
      { kind: 'tool', text: 'exec_command\n{"cmd":"npm test"}', timestamp: null },
      { kind: 'result', text: '\x1b[32m12 passed\x1b[0m', timestamp: null }
    ], false)
    expect(transcript).toContain('\x1b[1;36m●\x1b[0m Checking tests')
    expect(transcript).toContain('› $ npm test')
    expect(transcript).toContain('\x1b[32m12 passed')
    expect(transcript).not.toContain('{"cmd"')
  })
  it('retains previous transcript as a prefix when output is appended', () => {
    const first = { kind: 'message' as const, text: 'First', timestamp: null }
    expect(subagentTranscript([first, { ...first, text: 'Next' }], false).startsWith(subagentTranscript([first], false))).toBe(true)
  })
  it('makes bounded history and empty output explicit', () => {
    expect(subagentTranscript([], true)).toContain('Recent output')
    expect(subagentTranscript([], false)).toContain('Waiting for output')
  })
  it('uses eight panes and the same terminal palette', () => {
    expect(SUBAGENTS_PER_PAGE).toBe(8)
    expect(terminalTheme.green).toBe('#63d5a4')
    expect(terminalTheme.background).toBe('#090b10')
  })
})
