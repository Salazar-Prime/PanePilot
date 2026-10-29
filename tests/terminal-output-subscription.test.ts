import { describe, expect, it } from 'vitest'
import type { TerminalAttachResult, TerminalDataEvent } from '../src/shared/types'
import { subscribeTerminalOutput } from '../src/renderer/src/lib/terminalOutputSubscription'

function fixture() {
  const listeners = new Set<(event: TerminalDataEvent) => void>()
  const acknowledgements: unknown[][] = []
  const removals: unknown[][] = []
  const attaches: Array<{
    consumerId: string
    resolve(result: TerminalAttachResult): void
    reject(error: unknown): void
  }> = []
  const bridge: Parameters<typeof subscribeTerminalOutput>[0]['bridge'] = {
    attach: (_id, _cols, _rows, consumerId) => new Promise((resolve, reject) => {
      attaches.push({ consumerId: consumerId!, resolve, reject })
    }),
    onData: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    acknowledgeOutput: (...args) => { acknowledgements.push(args) },
    unsubscribeOutput: (...args) => { removals.push(args) }
  }
  function mount(consumerId = 'surface-a') {
    const writes: Array<{ data: string; parsed(): void }> = []
    const errors: unknown[] = []
    let ready = 0
    const dispose = subscribeTerminalOutput({
      bridge, sessionId: 'terminal', cols: 80, rows: 24, consumerId,
      write: (data, parsed) => { writes.push({ data, parsed }) },
      onReady: () => { ready++ }, onError: (error) => { errors.push(error) }
    })
    return { writes, errors, dispose, get ready() { return ready } }
  }
  function emit(sequence: number, data = `live-${sequence}`, consumerId = 'surface-a', generation = 'generation-a') {
    for (const listener of listeners) listener({ sessionId: 'terminal', consumerId, generation, sequence, data })
  }
  async function replay(index = 0, output = 'replay', generation = 'generation-a') {
    attaches[index].resolve({ output, generation, sequence: 0 })
    await Promise.resolve()
  }
  return { mount, emit, replay, attaches, listeners, acknowledgements, removals }
}

describe('renderer terminal output subscription', () => {
  it('acknowledges replay and each live write only after parsing, preserving raw ordered text', async () => {
    const source = fixture()
    const surface = source.mount()
    await source.replay(0, '\x1b[31mreplay\x1b[0m\r\n')
    expect(source.acknowledgements).toEqual([])
    expect(surface.ready).toBe(0)
    surface.writes[0].parsed()
    expect(source.acknowledgements).toEqual([['terminal', 'surface-a', 'generation-a', 0]])
    expect(surface.ready).toBe(1)
    source.emit(1, '\0🙂\x1b]52;c;Zm9v\x07')
    expect(source.acknowledgements).toHaveLength(1)
    surface.writes[1].parsed()
    source.emit(2, '\r\nsecond')
    expect(source.acknowledgements).toHaveLength(2)
    surface.writes[2].parsed()
    expect(surface.writes.map((write) => write.data).join(''))
      .toBe('\x1b[31mreplay\x1b[0m\r\n\0🙂\x1b]52;c;Zm9v\x07\r\nsecond')
    expect(source.acknowledgements.map((ack) => ack[3])).toEqual([0, 1, 2])
    expect(surface.errors).toEqual([])
  })

  it('keeps independent credits for two surfaces displaying the same session', async () => {
    const source = fixture()
    const first = source.mount('surface-a')
    const second = source.mount('surface-b')
    await source.replay(0)
    await source.replay(1, 'replay', 'generation-b')
    first.writes[0].parsed()
    expect(second.ready).toBe(0)
    expect(source.acknowledgements).toHaveLength(1)
    second.writes[0].parsed()
    source.emit(1)
    source.emit(1, 'second pane', 'surface-b', 'generation-b')
    first.writes[1].parsed()
    expect(source.acknowledgements.at(-1)).toEqual(['terminal', 'surface-a', 'generation-a', 1])
    expect(second.writes.map((write) => write.data)).toEqual(['replay', 'second pane'])
    second.writes[1].parsed()
    expect(source.acknowledgements.at(-1)).toEqual(['terminal', 'surface-b', 'generation-b', 1])
    first.dispose()
    expect(source.listeners.size).toBe(1)
    expect(source.removals).toEqual([['terminal', 'surface-a']])
  })

  it('ignores stale generations, other consumers, duplicate events and callbacks after disposal', async () => {
    const source = fixture()
    const surface = source.mount()
    await source.replay()
    surface.writes[0].parsed()
    source.emit(1, 'old', 'surface-a', 'old-generation')
    source.emit(1, 'other', 'surface-b')
    source.emit(1, 'current')
    source.emit(1, 'duplicate')
    expect(surface.writes.map((write) => write.data)).toEqual(['replay', 'current'])
    surface.dispose()
    surface.dispose()
    surface.writes[1].parsed()
    source.emit(2)
    expect(source.acknowledgements).toHaveLength(1)
    expect(source.removals).toHaveLength(1)
    expect(source.listeners.size).toBe(0)
  })

  it('releases both an unmounted pending attach and any late registration', async () => {
    const source = fixture()
    const surface = source.mount()
    surface.dispose()
    await source.replay()
    expect(surface.writes).toEqual([])
    expect(surface.ready).toBe(0)
    expect(surface.errors).toEqual([])
    expect(source.acknowledgements).toEqual([])
    expect(source.removals).toEqual([['terminal', 'surface-a'], ['terminal', 'surface-a']])
  })

  it('unsubscribes a failed attach and can reattach with a new token without accepting old events', async () => {
    const source = fixture()
    const failed = source.mount()
    source.attaches[0].reject(new Error('fixture attach failed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(source.listeners.size).toBe(0)
    expect(failed.errors).toHaveLength(1)
    expect(source.removals).toEqual([['terminal', 'surface-a']])
    const fresh = source.mount('surface-new')
    await source.replay(1, 'new replay', 'generation-new')
    fresh.writes[0].parsed()
    source.emit(1)
    source.emit(1, 'new live', 'surface-new', 'generation-new')
    expect(fresh.writes.map((write) => write.data)).toEqual(['new replay', 'new live'])
  })

  it('rejects premature or interrupted streams without accumulating a pre-attach queue', async () => {
    for (const phase of ['before-replay', 'during-replay', 'sequence-gap'] as const) {
      const source = fixture()
      const surface = source.mount()
      if (phase !== 'before-replay') await source.replay()
      if (phase === 'sequence-gap') surface.writes[0].parsed()
      source.emit(phase === 'sequence-gap' ? 2 : 1)
      for (let sequence = 3; sequence < 1000; sequence++) source.emit(sequence)
      expect(surface.errors).toHaveLength(1)
      expect(source.listeners.size).toBe(0)
      expect(surface.writes).toHaveLength(phase === 'before-replay' ? 0 : 1)
      expect(source.removals).toHaveLength(1)
    }
  })
})
