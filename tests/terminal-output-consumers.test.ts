import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import type { TerminalOutputFlow } from '../src/main/terminal-output-flow'
import type { Connection, TerminalDataEvent, TerminalSession } from '../src/shared/types'

interface FakeRuntime {
  session: TerminalSession
  connection: Connection
  pty: {
    pause: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    onData: ReturnType<typeof vi.fn>
    onExit: ReturnType<typeof vi.fn>
  }
  screen: { write(data: string, parsed: () => void): void; dispose(): void } | null
  finishParsing: (() => void) | null
  closingTransport: boolean
  scanTimer: null
  providerTimer: null
  actionTimer: null
  detector: null
}
interface OutputState {
  generation: string
  sequence: number
  received: number
  dispatched: number
  consumers: Map<string, unknown>
  flow: TerminalOutputFlow
}
interface Internals {
  runtimes: Map<string, FakeRuntime>
  outputs: Map<string, OutputState>
  outputState(id: string): OutputState
  retainTerminalOutput(session: TerminalSession, data: string): void
  closeRuntimeForReconnect(runtime: FakeRuntime): void
  launchOnce(session: TerminalSession, folder: string, connection: Connection, cols: number, rows: number, create: boolean): Promise<void>
  tmuxPathForConnection(connection: Connection): Promise<string | null>
  spawnTerminal(...args: unknown[]): Promise<FakeRuntime['pty']>
  scheduleProviderDiscovery(...args: unknown[]): void
  scheduleActionCompletion(...args: unknown[]): void
  serializeOperation<T>(key: string, operation: () => Promise<T>): Promise<T>
}

const cleanups: Array<() => void> = []
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

beforeEach(() => {
  // The constructor primes a login PATH asynchronously. Avoid invoking any user
  // shell even though every backend in this fixture is synthetic.
  vi.stubEnv('SHELL', '/panepilot-output-fixture-no-shell')
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function fixture({ screen = false, profile = 'codex' as 'codex' | 'shell' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'panepilot-output-consumers-'))
  const store = new Store(root)
  store.syncConnections([])
  const project = store.createProject({
    type: 'terminal', name: 'Output fixture', connectionId: 'local', folder: root, repositoryUrl: null
  })
  const session = store.createSession({
    projectId: project.id, name: 'Exact output fixture', profile, providerSessionName: null,
    customCommand: null, backend: 'tmux', tmuxName: 'Exact output fixture', dangerousMode: false
  })
  store.setSessionState(session.id, 'completed')
  session.state = 'completed'
  const sent: Array<{ channel: string; data: TerminalDataEvent }> = []
  let destroyed = false
  const window = {
    isDestroyed: () => destroyed,
    webContents: { send: (channel: string, data: TerminalDataEvent) => sent.push({ channel, data }) }
  } as unknown as BrowserWindow
  const manager = new TerminalManager(store, () => window, new ConversationIndexer(), new RemoteConversationIndexer())
  const internal = manager as unknown as Internals
  const parsed: Array<() => void> = []
  const parserWrites: string[] = []
  const child = () => ({ pause: vi.fn(), resume: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() })
  const runtime: FakeRuntime = {
    session, connection: store.getConnection('local')!, pty: child(),
    screen: screen ? {
      write(data, done) { parserWrites.push(data); parsed.push(done) }, dispose: vi.fn()
    } : null,
    finishParsing: null, closingTransport: false, scanTimer: null,
    providerTimer: null, actionTimer: null, detector: null
  }
  internal.runtimes.set(session.id, runtime)
  const state = internal.outputState(session.id)
  const data = () => sent.filter((event) => event.channel === 'terminal:data').map((event) => event.data)
  const emit = (text: string) => {
    // This is the native onData boundary: the replay and absolute character
    // position advance before the asynchronous parser/renderer queue drains.
    internal.retainTerminalOutput(session, text)
    state.received += text.length
    state.flow.enqueue(text)
  }
  const attach = (consumer: string) => manager.attach(session.id, 80, 24, consumer)
  const ack = (consumer: string, sequence: number, generation = state.generation) =>
    manager.acknowledgeOutput(session.id, consumer, generation, sequence)
  cleanups.push(() => { manager.shutdown(); store.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, store, manager, internal, session, runtime, state, parsed, parserWrites, data, emit, attach, ack, child,
    destroyWindow: () => { destroyed = true } }
}

describe('terminal manager output consumers', () => {
  it('cuts overlapping replay from live output and gates delivery on replay ACK zero', async () => {
    const f = fixture()
    const replay = '\x1b[31mreplay🙂\0'
    const live = '\x1b[0mLIVE🚀\r\n'
    f.emit(replay)
    const attached = await f.attach('pane-a')
    expect(attached).toEqual({ output: replay, generation: f.state.generation, sequence: 0 })
    f.emit(live)
    await turn()
    expect(f.state.dispatched).toBe(replay.length + live.length)
    expect(f.data()).toEqual([])
    expect(f.state.flow.pendingBytes).toBe(Buffer.byteLength(replay + live))
    f.ack('pane-a', 0, 'stale-generation')
    expect(f.data()).toEqual([])
    f.ack('pane-a', 0)
    expect(f.data()).toEqual([expect.objectContaining({ consumerId: 'pane-a', sequence: 1, data: live })])
    expect(attached.output + f.data().map((event) => event.data).join('')).toBe(replay + live)
    expect(f.state.flow.pendingBytes).toBeGreaterThan(0)
    f.ack('pane-a', 1)
    expect(f.state.flow.pendingBytes).toBe(0)
  })

  it('waits for both renderer consumers and the headless parser before dispatching the next batch', async () => {
    const f = fixture({ screen: true })
    await f.attach('pane-a')
    await f.attach('pane-b')
    f.ack('pane-a', 0)
    f.ack('pane-b', 0)
    f.emit('first')
    await turn()
    f.emit('second')
    expect(f.data().map((event) => event.consumerId)).toEqual(['pane-a', 'pane-b'])
    expect(f.parserWrites).toEqual(['first'])
    f.ack('pane-a', 1)
    f.ack('pane-a', 1) // Duplicate callbacks must not grant a second credit.
    f.parsed.shift()!()
    await turn()
    expect(f.parserWrites).toEqual(['first'])
    expect(f.state.flow.pendingBytes).toBe(Buffer.byteLength('firstsecond'))
    f.ack('pane-b', 1)
    await turn()
    expect(f.parserWrites).toEqual(['first', 'second'])
    expect(f.data().map((event) => [event.consumerId, event.sequence, event.data])).toEqual([
      ['pane-a', 1, 'first'], ['pane-b', 1, 'first'], ['pane-a', 2, 'second'], ['pane-b', 2, 'second']
    ])
    f.ack('pane-a', 2)
    f.ack('pane-b', 2)
    expect(f.state.flow.pendingBytes).toBe(Buffer.byteLength('second'))
    f.parsed.shift()!()
    expect(f.state.flow.pendingBytes).toBe(0)
  })

  it('starts a late first consumer at live sequence one after unobserved batches have drained', async () => {
    const f = fixture()
    for (const text of ['unobserved one\r\n', 'unobserved two\r\n']) {
      f.emit(text)
      await turn()
    }
    expect(f.state.flow.pendingBytes).toBe(0)
    expect(f.data()).toEqual([])
    const replay = await f.attach('late-first-pane')
    expect(replay.output).toBe('unobserved one\r\nunobserved two\r\n')
    expect(replay.sequence).toBe(0)
    f.ack('late-first-pane', 0)
    f.emit('first live')
    await turn()
    expect(f.data()).toEqual([
      expect.objectContaining({ consumerId: 'late-first-pane', sequence: 1, data: 'first live' })
    ])
    f.ack('late-first-pane', 1)
    expect(f.state.flow.pendingBytes).toBe(0)
  })

  it('gives a newly joined second surface its own sequence while the existing surface keeps progressing', async () => {
    const f = fixture()
    await f.attach('existing-pane')
    f.ack('existing-pane', 0)
    for (let sequence = 1; sequence <= 3; sequence++) {
      f.emit(`old-${sequence}\r\n`)
      await turn()
      f.ack('existing-pane', sequence)
    }
    const joined = await f.attach('joined-pane')
    expect(joined.output).toBe('old-1\r\nold-2\r\nold-3\r\n')
    expect(joined.sequence).toBe(0)
    f.ack('joined-pane', 0)
    f.emit('shared live')
    await turn()
    expect(f.data().slice(-2)).toEqual([
      expect.objectContaining({ consumerId: 'existing-pane', sequence: 4, data: 'shared live' }),
      expect.objectContaining({ consumerId: 'joined-pane', sequence: 1, data: 'shared live' })
    ])
    f.ack('existing-pane', 4)
    expect(f.state.flow.pendingBytes).toBeGreaterThan(0)
    f.ack('joined-pane', 4) // Another surface's progress cannot release this one.
    expect(f.state.flow.pendingBytes).toBeGreaterThan(0)
    f.ack('joined-pane', 1)
    expect(f.state.flow.pendingBytes).toBe(0)
  })

  it('ignores wrong sequence/generation acknowledgements and releases an unsubscribed stalled surface', async () => {
    const f = fixture()
    await f.attach('slow-pane')
    f.ack('slow-pane', 0)
    f.emit('first')
    await turn()
    f.emit('next')
    f.ack('slow-pane', 2)
    f.ack('slow-pane', 1, 'wrong-generation')
    f.ack('missing-pane', 1)
    await turn()
    expect(f.data()).toHaveLength(1)
    f.manager.unsubscribeOutput(f.session.id, 'slow-pane')
    f.manager.unsubscribeOutput(f.session.id, 'slow-pane')
    await turn()
    expect(f.state.flow.pendingBytes).toBe(0)
    expect(f.data()).toHaveLength(1)
    f.ack('slow-pane', 1)
    await f.attach('fresh-pane')
    f.ack('fresh-pane', 0, 'wrong-generation')
    f.emit('fresh')
    await turn()
    expect(f.data()).toHaveLength(1)
    f.ack('fresh-pane', 0)
    expect(f.data().at(-1)).toMatchObject({ consumerId: 'fresh-pane', sequence: 1, data: 'fresh' })
    f.ack('fresh-pane', f.data().at(-1)!.sequence!)
    expect(f.state.flow.pendingBytes).toBe(0)
  })

  it('retains the same flow and renderer credits across transport replacement and resumes the replacement PTY', async () => {
    const f = fixture({ profile: 'shell', screen: true })
    await f.attach('pane-a')
    f.ack('pane-a', 0)
    const text = 'x'.repeat(256 * 1024)
    f.emit(text)
    expect(f.runtime.pty.pause).toHaveBeenCalledOnce()
    await turn()
    const original = f.state
    expect(original.flow.paused).toBe(true)
    expect(f.parserWrites).toHaveLength(1)
    f.internal.closeRuntimeForReconnect(f.runtime)
    expect(f.runtime.pty.kill).toHaveBeenCalledOnce()
    expect(f.internal.outputs.get(f.session.id)).toBe(original)
    expect(original.consumers.size).toBe(1)
    const replacement = f.child()
    vi.spyOn(f.internal, 'tmuxPathForConnection').mockResolvedValue('/fixture/tmux')
    vi.spyOn(f.internal, 'spawnTerminal').mockResolvedValue(replacement)
    vi.spyOn(f.internal, 'scheduleProviderDiscovery').mockImplementation(() => {})
    vi.spyOn(f.internal, 'scheduleActionCompletion').mockImplementation(() => {})
    await f.internal.launchOnce(f.session, f.root, f.runtime.connection, 80, 24, false)
    expect(replacement.pause).toHaveBeenCalledOnce()
    expect(f.internal.outputs.get(f.session.id)).toBe(original)
    // Headless completion on transport close releases only that parser's credit.
    expect(f.data()).toHaveLength(1)
    f.parsed[0]() // A disposed parser's late callback must remain idempotent.
    expect(original.flow.pendingBytes).toBe(Buffer.byteLength(text))
    for (let attempts = 0; original.flow.pendingBytes > 0 && attempts < 10; attempts++) {
      const event = f.data().at(-1)!
      f.ack('pane-a', event.sequence!)
      await turn()
    }
    expect(original.flow.pendingBytes).toBe(0)
    expect(f.data().map((event) => event.data).join('')).toBe(text)
    expect(replacement.resume).toHaveBeenCalledOnce()
    expect(f.runtime.pty.resume).not.toHaveBeenCalled()
    expect(original.generation).toBe(f.state.generation)
    // Exercise the actual launch-installed native callback after replacement,
    // rather than only the synthetic boundary used to set up the backlog.
    const onData = replacement.onData.mock.calls[0][0] as (data: string) => void
    onData('\0replacement🙂\r\n')
    await turn()
    const final = f.data().at(-1)!
    expect(final.data).toBe('\0replacement🙂\r\n')
    f.ack('pane-a', final.sequence!)
    expect(original.received).toBe(text.length + '\0replacement🙂\r\n'.length)
    expect((await f.manager.attach(f.session.id, 80, 24)).output).toBe(text + '\0replacement🙂\r\n')
  })

  it('keeps replay and parsing without renderer IPC when no output consumers exist', async () => {
    const f = fixture({ screen: true })
    f.emit('unobserved\r\n')
    await turn()
    expect(f.data()).toEqual([])
    expect(f.parserWrites).toEqual(['unobserved\r\n'])
    f.parsed.shift()!()
    expect(f.state.flow.pendingBytes).toBe(0)
    const legacy = await f.manager.attach(f.session.id, 80, 24)
    expect(legacy).toEqual({ output: 'unobserved\r\n' })
    expect(f.state.consumers.size).toBe(0)
  })

  it('clears all consumers, releases replay-gated batches, and cancels an attach still awaiting its operation', async () => {
    const f = fixture()
    await f.attach('waiting-for-replay')
    f.emit('pending-live')
    await turn()
    expect(f.data()).toEqual([])
    expect(f.state.flow.pendingBytes).toBeGreaterThan(0)
    let release!: () => void
    const barrier = f.internal.serializeOperation(f.session.id, () => new Promise<void>((resolve) => { release = resolve }))
    await Promise.resolve()
    await Promise.resolve()
    const pending = f.attach('late-attach')
    f.manager.clearOutputConsumers()
    release()
    await barrier
    expect(await pending).toEqual({ output: 'pending-live' })
    expect(f.state.consumers.size).toBe(0)
    expect(f.state.flow.pendingBytes).toBe(0)
    f.ack('waiting-for-replay', 0)
    expect(f.data()).toEqual([])
  })

  it('cancels an individually unsubscribed pending attach and removes consumers when their window is gone', async () => {
    const f = fixture()
    const pending = f.attach('late-pane')
    f.manager.unsubscribeOutput(f.session.id, 'late-pane')
    expect(await pending).toEqual({ output: '' })
    expect(f.state.consumers.size).toBe(0)
    await f.attach('closing-window')
    f.ack('closing-window', 0)
    f.destroyWindow()
    f.emit('last')
    await turn()
    expect(f.data()).toEqual([])
    expect(f.state.consumers.size).toBe(0)
    expect(f.state.flow.pendingBytes).toBe(0)
  })
})
