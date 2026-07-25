import { describe, expect, it } from 'vitest'
import {
  clipboardPasteFits,
  decodeOsc52Clipboard,
  prepareClipboardPaste
} from '../src/renderer/src/lib/terminalClipboard'
import { terminalInputChunks } from '../src/main/terminal-manager'

describe('terminal clipboard', () => {
  it('removes NUL bytes and bounds paste payloads', () => {
    expect(prepareClipboardPaste('before\0after')).toBe('beforeafter')
    expect(clipboardPasteFits('small paste')).toBe(true)
    expect(clipboardPasteFits('x'.repeat(2 * 1024 * 1024 + 1))).toBe(false)
  })

  it('decodes bounded OSC 52 clipboard messages', () => {
    expect(decodeOsc52Clipboard('c;Y29waWVkIHRleHQ=')).toBe('copied text')
    expect(decodeOsc52Clipboard('c;?')).toBeNull()
    expect(decodeOsc52Clipboard('invalid')).toBeNull()
  })

  it('chunks terminal input without splitting Unicode surrogate pairs', () => {
    const input = `ab😀cd`
    const chunks = terminalInputChunks(input, 3)

    expect(chunks).toEqual(['ab', '😀c', 'd'])
    expect(chunks.join('')).toBe(input)
  })
})
