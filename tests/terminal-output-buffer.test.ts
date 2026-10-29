import { describe, expect, it } from 'vitest'
import { TerminalOutputBuffer } from '../src/main/terminal-output-buffer'

function retainedSuffix(text: string, maximumBytes: number): string {
  if (maximumBytes === 0) return ''
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.length <= maximumBytes) return text
  let start = encoded.length - maximumBytes
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1
  return encoded.subarray(start).toString('utf8')
}

function expectOutput(buffer: TerminalOutputBuffer, expected: string, limit: number): void {
  expect(buffer.read()).toBe(expected)
  expect(buffer.byteLength).toBe(Buffer.byteLength(expected, 'utf8'))
  expect(buffer.byteLength).toBeLessThanOrEqual(limit)
}

describe('volatile terminal replay buffer', () => {
  it('preserves ordered terminal controls and exact suffixes through repeated saturation', () => {
    const limit = 8 * 1024
    const buffer = new TerminalOutputBuffer(limit)
    let expected = ''
    for (let index = 0; index < 800; index += 1) {
      const data = `\u001b[31m${index}: output\0\r\n\u001b[0m\u001b]0;title\u0007`.repeat(3)
      buffer.append(data)
      expected = retainedSuffix(expected + data, limit)
      expectOutput(buffer, expected, limit)
    }
  })

  it('keeps whole UTF-8 characters at every byte boundary', () => {
    for (const limit of [0, 1, 2, 3, 4, 5, 7, 11, 17, 31]) {
      const buffer = new TerminalOutputBuffer(limit)
      let expected = ''
      for (let index = 0; index < 20; index += 1) {
        for (const data of ['a', 'é', '界', '🙂', '\r\n', '🚀é-end']) {
          buffer.append(data)
          expected = retainedSuffix(expected + data, limit)
          expectOutput(buffer, expected, limit)
          expect(buffer.read()).not.toContain('\ufffd')
        }
      }
    }
  })

  it('accounts for Unicode pairs split across input writes and segment boundaries', () => {
    const limit = 16 * 1024
    const buffer = new TerminalOutputBuffer(limit)
    const chunks = ['a'.repeat(4095), '\ud83d', '\ude42', '界'.repeat(2500), '\ud83d', '\ude80']
    let expected = ''
    for (const chunk of chunks) {
      buffer.append(chunk)
      expected = retainedSuffix(expected + chunk, limit)
      expectOutput(buffer, expected, limit)
    }
    expect(buffer.read()).toContain('🙂')
    expect(buffer.read()).toContain('🚀')

    const small = new TerminalOutputBuffer(4)
    small.append('x\ud83d')
    small.append('\ude42')
    expectOutput(small, '🙂', 4)
    small.append('!')
    expectOutput(small, '!', 4)
  })

  it('replaces earlier replay with the bounded suffix of an oversized write', () => {
    const limit = 32 * 1024
    const buffer = new TerminalOutputBuffer(limit)
    buffer.append('discarded prefix')
    const huge = `${'🙂界abc'.repeat(100_000)}\u001b[0mfinal\r\n`
    buffer.append(huge)
    const expected = retainedSuffix(huge, limit)
    expectOutput(buffer, expected, limit)
    expect(buffer.read()).not.toContain('discarded prefix')
    buffer.append('next')
    expectOutput(buffer, retainedSuffix(expected + 'next', limit), limit)
  })

  it('bounds segment storage and releases consumed strings for tiny writes', () => {
    const limit = 8 * 1024
    const buffer = new TerminalOutputBuffer(limit)
    const input = '0123456789'.repeat(50_000)
    for (const character of input) buffer.append(character)
    expectOutput(buffer, input.slice(-limit), limit)
    // Inspect ownership as well as visible text: a correct tail must not keep
    // an ever-growing array of consumed segment references behind its head.
    const state = buffer as unknown as {
      segments: Array<{ text: string } | undefined>
      head: number
    }
    expect(buffer.chunkCount).toBeLessThanOrEqual(3)
    expect(state.segments.length).toBeLessThanOrEqual(67)
    expect(state.segments.slice(0, state.head).every((segment) => segment === undefined)).toBe(true)
    expect(state.segments.reduce((sum, segment) => sum + (segment?.text.length ?? 0), 0))
      .toBeLessThanOrEqual(limit + 4096)
  })

  it('clears ownership and starts a fresh replay after reuse', () => {
    const buffer = new TerminalOutputBuffer(17)
    buffer.append('old'.repeat(100))
    buffer.clear()
    expectOutput(buffer, '', 17)
    expect(buffer.chunkCount).toBe(0)
    buffer.append('new 🙂')
    buffer.append('')
    expectOutput(buffer, 'new 🙂', 17)
  })
})
