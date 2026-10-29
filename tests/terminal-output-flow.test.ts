import { describe, expect, it, vi } from 'vitest'
import HeadlessXterm from '@xterm/headless'
import { TerminalOutputFlow } from '../src/main/terminal-output-flow'

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function slowConsumer(limits: ConstructorParameters<typeof TerminalOutputFlow>[1] = {}) {
  const writes: string[] = []
  const callbacks: Array<() => void> = []
  const pause = vi.fn()
  const resume = vi.fn()
  const onParsed = vi.fn()
  const flow = new TerminalOutputFlow({
    pause,
    resume,
    onParsed,
    write(data, done) {
      writes.push(data)
      callbacks.push(done)
    }
  }, limits)
  return { flow, writes, callbacks, pause, resume, onParsed }
}

describe('terminal output parser flow control', () => {
  it('keeps the active parser write charged until completion and resumes only below the low watermark', async () => {
    const fixture = slowConsumer({ highWaterMark: 20, lowWaterMark: 5, maxBatchBytes: 8 })
    fixture.flow.enqueue('a'.repeat(12))
    fixture.flow.enqueue('b'.repeat(12))
    expect(fixture.pause).toHaveBeenCalledTimes(1)
    expect(fixture.flow.pendingBytes).toBe(24)
    await nextTurn()
    expect(fixture.writes).toEqual(['a'.repeat(8)])
    expect(fixture.flow.pendingBytes).toBe(24)
    await nextTurn()
    expect(fixture.writes).toHaveLength(1)

    fixture.callbacks.shift()!()
    expect(fixture.flow.pendingBytes).toBe(16)
    expect(fixture.resume).not.toHaveBeenCalled()
    await nextTurn()
    fixture.callbacks.shift()!()
    expect(fixture.flow.pendingBytes).toBe(8)
    expect(fixture.resume).not.toHaveBeenCalled()
    await nextTurn()
    fixture.callbacks.shift()!()
    expect(fixture.flow.pendingBytes).toBe(0)
    expect(fixture.resume).toHaveBeenCalledTimes(1)
    expect(fixture.onParsed).toHaveBeenCalledTimes(3)
    expect(fixture.writes.join('')).toBe('a'.repeat(12) + 'b'.repeat(12))
  })

  it('bounds a high-output producer that honors pause and never overlaps parser writes', async () => {
    const chunks = Array.from({ length: 600 }, (_, index) => `${index}:\u001b[31m${'x'.repeat(2048)}\0\r\n`)
    const fixture = slowConsumer()
    let sent = 0
    let peakBytes = 0
    while (sent < chunks.length || fixture.flow.pendingBytes > 0) {
      while (sent < chunks.length && !fixture.flow.paused) {
        fixture.flow.enqueue(chunks[sent++])
        peakBytes = Math.max(peakBytes, fixture.flow.pendingBytes)
      }
      await nextTurn()
      expect(fixture.callbacks).toHaveLength(1)
      expect(Buffer.byteLength(fixture.writes.at(-1)!, 'utf8')).toBeLessThanOrEqual(64 * 1024)
      fixture.callbacks.shift()!()
    }
    expect(fixture.writes.join('')).toBe(chunks.join(''))
    expect(peakBytes).toBeLessThan(256 * 1024 + Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk))))
    expect(fixture.pause.mock.calls.length).toBeGreaterThan(1)
    expect(fixture.resume).toHaveBeenCalledTimes(fixture.pause.mock.calls.length)
    expect(fixture.flow.pendingBytes).toBe(0)
  })

  it('preserves ANSI, NUL, Unicode and surrogate pairs split across source deliveries', async () => {
    const chunks = ['\u001b[31m\0é', '界🙂', '\ud83d', '\ude80\r\n', '\u001b]0;标题\u0007', '\ud800', 'end']
    const fixture = slowConsumer({ highWaterMark: 25, lowWaterMark: 8, maxBatchBytes: 7 })
    for (const chunk of chunks) fixture.flow.enqueue(chunk)
    while (fixture.flow.pendingBytes > 0) {
      await nextTurn()
      fixture.callbacks.shift()!()
    }
    expect(fixture.writes.join('')).toBe(chunks.join(''))
    expect(fixture.writes.every((chunk) => Buffer.byteLength(chunk) <= 7)).toBe(true)
    expect(fixture.flow.pendingBytes).toBe(0)
  })

  it('keeps actual headless parser text and title identical across small batch boundaries', async () => {
    const baseline = new HeadlessXterm.Terminal({ cols: 40, rows: 4, allowProposedApi: true })
    const streamed = new HeadlessXterm.Terminal({ cols: 40, rows: 4, allowProposedApi: true })
    const chunks = ['\u001b]0;Fixture ', 'title\u0007', '\u001b[31mred\u001b[0m\r\n', 'é界', '\ud83d', '\ude42\0!', '\r\nend']
    let baselineTitle = ''
    let streamedTitle = ''
    baseline.onTitleChange((title) => { baselineTitle = title })
    streamed.onTitleChange((title) => { streamedTitle = title })
    let flow: TerminalOutputFlow | undefined
    try {
      await new Promise<void>((resolve) => baseline.write(chunks.join(''), resolve))
      await new Promise<void>((resolve) => {
        flow = new TerminalOutputFlow({
          pause() {},
          resume() {},
          write: (data, done) => streamed.write(data, done),
          onParsed: () => { if (flow!.pendingBytes === 0) resolve() }
        }, { highWaterMark: 20, lowWaterMark: 5, maxBatchBytes: 7 })
        for (const chunk of chunks) flow.enqueue(chunk)
      })
      expect(streamedTitle).toBe(baselineTitle)
      expect(streamedTitle).toBe('Fixture title')
      for (let row = 0; row < 4; row += 1) {
        expect(streamed.buffer.active.getLine(row)?.translateToString(true))
          .toBe(baseline.buffer.active.getLine(row)?.translateToString(true))
      }
    } finally {
      flow?.dispose()
      baseline.dispose()
      streamed.dispose()
    }
  })

  it('yields between synchronous parser callbacks and coalesces tiny deliveries', async () => {
    let writes = 0
    const flow = new TerminalOutputFlow({
      pause() {},
      resume() {},
      write(_data, done) {
        writes += 1
        done()
      }
    }, { highWaterMark: 100, lowWaterMark: 20, maxBatchBytes: 8 })
    for (let index = 0; index < 64; index += 1) flow.enqueue('x')
    expect(writes).toBe(0)
    await nextTurn()
    expect(writes).toBe(1)
    while (flow.pendingBytes > 0) await nextTurn()
    expect(writes).toBe(8)
  })

  it('ignores a duplicate parser callback without releasing the next active write', async () => {
    const fixture = slowConsumer({ highWaterMark: 16, lowWaterMark: 5, maxBatchBytes: 8 })
    fixture.flow.enqueue('x'.repeat(24))
    await nextTurn()
    const firstDone = fixture.callbacks.shift()!
    firstDone()
    await nextTurn()
    firstDone()
    expect(fixture.flow.pendingBytes).toBe(16)
    expect(fixture.onParsed).toHaveBeenCalledTimes(1)
    expect(fixture.resume).not.toHaveBeenCalled()
    fixture.flow.dispose()
  })

  it('drops owned queue references on close and ignores pending and late work without resuming', async () => {
    const fixture = slowConsumer({ highWaterMark: 16, lowWaterMark: 5, maxBatchBytes: 8 })
    fixture.flow.enqueue('x'.repeat(100))
    await nextTurn()
    const done = fixture.callbacks.shift()!
    fixture.flow.dispose()
    done()
    fixture.flow.enqueue('ignored after close')
    await nextTurn()
    expect(fixture.writes).toHaveLength(1)
    expect(fixture.flow.pendingBytes).toBe(0)
    expect(fixture.resume).not.toHaveBeenCalled()
    expect(fixture.onParsed).not.toHaveBeenCalled()
    expect((fixture.flow as unknown as { chunks: unknown[] }).chunks).toHaveLength(0)

    const neverStarted = slowConsumer()
    neverStarted.flow.enqueue('scheduled')
    neverStarted.flow.dispose()
    await nextTurn()
    expect(neverStarted.writes).toHaveLength(0)
  })

  it('rejects invalid limits before owning output or touching the producer', () => {
    for (const limits of [
      { highWaterMark: 0 }, { lowWaterMark: -1 },
      { highWaterMark: 8, lowWaterMark: 8 }, { maxBatchBytes: 3 },
      { highWaterMark: Infinity }, { lowWaterMark: 0.5 }
    ]) {
      expect(() => slowConsumer(limits)).toThrow(RangeError)
    }
  })
})
