import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'
import { promisify } from 'node:util'
import * as pty from 'node-pty'
import type { HostTerminal, TerminalDataEvent, TerminalTransportEvent } from '../shared/types'
import type { Store } from './store'

const execAsync = promisify(execFile)
const LIMIT = 512 * 1024
const MAX_TERMINALS = 16
type HostStore = Pick<Store, 'listHostTerminals' | 'getHostTerminal' | 'createHostTerminal' | 'setHostTerminalState' | 'deleteHostTerminal'>
interface Dependencies {
  tmux: string | null
  home: string
  shell: string
  spawn: typeof pty.spawn
  run(file: string, args: string[]): Promise<string>
}
interface Events {
  changed(sessions: HostTerminal[]): void
  data(event: TerminalDataEvent): void
  transport(event: TerminalTransportEvent): void
}
interface Runtime { process: pty.IPty; output: string; intentional: boolean; subscriptions: pty.IDisposable[] }
interface Pane { name: string; owner: string; dead: boolean; exitCode: number }
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

export function hostTerminalSocket(profilePath: string): string {
  return `panepilot-host-${createHash('sha256').update(profilePath).digest('hex').slice(0, 16)}`
}

export function hostTerminalEnvironment(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  // A shell opened from PanePilot must not inherit a parent terminal's tmux or
  // project hook identity. In particular, it must not claim to be an SSH project.
  for (const key of Object.keys(env)) {
    if (key === 'TMUX' || key === 'TMUX_PANE' || key.startsWith('PANEPILOT_')) delete env[key]
  }
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}

function defaults(): Dependencies {
  const candidates = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((folder) => join(folder, 'tmux')),
    '/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']
  return {
    tmux: candidates.find((file) => existsSync(file)) ?? null,
    home: homedir(), shell: process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh',
    spawn: pty.spawn,
    run: async (file, args) => (await execAsync(file, args, {
      timeout: 5_000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env: hostTerminalEnvironment()
    })).stdout
  }
}

/** One local-only collection. Its private tmux server never participates in project discovery. */
export class HostTerminalService {
  private readonly deps: Dependencies
  private readonly socket: string
  private readonly runtimes = new Map<string, Runtime>()
  private readonly buffers = new Map<string, string>()
  private queue: Promise<unknown> = Promise.resolve()
  private shuttingDown = false
  private polling: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly store: HostStore, profilePath: string, private readonly events: Events, dependencies?: Partial<Dependencies>) {
    this.deps = { ...defaults(), ...dependencies }
    this.socket = hostTerminalSocket(profilePath)
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.queue.then(() => {
      if (this.shuttingDown) throw new Error('PanePilot is closing.')
      return operation()
    })
    this.queue = work.catch(() => {})
    return work
  }
  private get(id: string): HostTerminal {
    if (typeof id !== 'string') throw new Error('Invalid host terminal.')
    const session = this.store.getHostTerminal(id)
    if (!session) throw new Error('Host terminal not found.')
    return session
  }
  private notify(): void { if (!this.shuttingDown) this.events.changed(this.store.listHostTerminals()) }
  private async tmux(args: string[]): Promise<string> {
    if (!this.deps.tmux) throw new Error('Tmux is unavailable on this computer.')
    return this.deps.run(this.deps.tmux, ['-u', '-L', this.socket, '-f', '/dev/null', ...args])
  }
  private async panes(): Promise<Pane[]> {
    try {
      const output = await this.tmux(['list-panes', '-a', '-F', '#{session_name}\t#{@panepilot_host_terminal_id}\t#{pane_dead}\t#{pane_dead_status}'])
      return output.trim().split('\n').filter(Boolean).map((line) => {
        const [name, owner, dead, exitCode] = line.split('\t')
        return { name, owner, dead: dead === '1', exitCode: Number(exitCode || 0) }
      })
    } catch (cause) {
      const error = cause as Error & { stderr?: string; code?: number | string }
      // A timeout, permissions failure, or bad executable is not proof a shell ended.
      if (error.code === 1 && /no server running|no sessions|error connecting.*No such file|failed to connect.*No such file/i.test(error.stderr ?? error.message)) return []
      throw cause
    }
  }
  private async reconcile(): Promise<void> {
    const sessions = this.store.listHostTerminals()
    const panes = sessions.some((session) => session.backend === 'tmux') && this.deps.tmux ? await this.panes() : null
    if (this.shuttingDown) return
    let changed = false
    for (const session of sessions) {
      let state = session.state
      if (session.backend === 'pty' && !this.runtimes.has(session.id)) state = 'completed'
      if (session.backend === 'tmux' && panes) {
        const pane = panes.find((item) => item.name === session.tmuxName)
        if (!pane) state = 'completed'
        else if (pane.owner !== session.id) state = 'error'
        else if (pane.dead) state = pane.exitCode === 0 ? 'completed' : 'error'
      }
      if (state !== session.state) { this.store.setHostTerminalState(session.id, state); changed = true }
    }
    if (changed) this.notify()
  }
  list(): Promise<HostTerminal[]> {
    return this.serialize(async () => { await this.reconcile(); return this.store.listHostTerminals() })
  }
  create(): Promise<HostTerminal> {
    return this.serialize(async () => {
      const sessions = this.store.listHostTerminals()
      if (sessions.length >= MAX_TERMINALS) throw new Error(`Close a host terminal before opening more than ${MAX_TERMINALS}.`)
      const id = randomUUID()
      const name = `Host ${id.slice(0, 8)}`
      const backend = this.deps.tmux ? 'tmux' : 'pty'
      let createdTarget: string | null = null
      try {
        if (backend === 'tmux') {
          const target = (await this.tmux(['new-session', '-d', '-P', '-F', '#{session_id}', '-s', name,
            '-c', this.deps.home, '-x', '100', '-y', '30', `exec ${quote(this.deps.shell)} -l`])).trim()
          if (!/^\$\d+$/.test(target)) throw new Error('Tmux did not return the new session identity.')
          createdTarget = target
          // set-option does not implement the '=name' exact-match prefix.
          // Its immutable $session-id is unambiguous and remains safe on rename.
          await this.tmux(['set-option', '-t', target, '@panepilot_host_terminal_id', id,
            ';', 'set-option', '-w', '-t', `${target}:0`, 'remain-on-exit', 'on',
            ';', 'set-option', '-t', target, 'destroy-unattached', 'off'])
        }
        if (this.shuttingDown) throw new Error('PanePilot is closing.')
        const session = this.store.createHostTerminal({ id, name, backend, tmuxName: backend === 'tmux' ? name : null })
        if (backend === 'pty') this.spawn(session, 100, 30)
        this.notify()
        return this.get(id)
      } catch (cause) {
        // Never leave an invisible shell behind after a failed creation.
        if (createdTarget) await this.tmux(['kill-session', '-t', createdTarget]).catch(() => {})
        if (!this.shuttingDown) this.store.deleteHostTerminal(id)
        throw cause
      }
    })
  }
  private spawn(session: HostTerminal, cols: number, rows: number): Runtime {
    const child = session.backend === 'tmux'
      ? this.deps.spawn(this.deps.tmux!, ['-u', '-L', this.socket, '-f', '/dev/null', 'attach-session', '-t', `=${session.tmuxName}`],
        { name: 'xterm-256color', cols, rows, cwd: this.deps.home, env: hostTerminalEnvironment() })
      : this.deps.spawn(this.deps.shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd: this.deps.home, env: hostTerminalEnvironment() })
    const runtime: Runtime = { process: child, output: '', intentional: false, subscriptions: [] }
    this.runtimes.set(session.id, runtime)
    runtime.subscriptions.push(child.onData((data) => {
      runtime.output = (runtime.output + data).slice(-LIMIT)
      if (!this.shuttingDown) this.events.data({ sessionId: session.id, data })
    }), child.onExit(({ exitCode }) => {
      if (this.runtimes.get(session.id) !== runtime) return
      this.runtimes.delete(session.id)
      this.buffers.set(session.id, runtime.output)
      for (const disposable of runtime.subscriptions) disposable.dispose()
      if (this.shuttingDown || runtime.intentional) return
      if (session.backend === 'pty') {
        this.store.setHostTerminalState(session.id, exitCode === 0 ? 'completed' : 'error')
        this.notify()
      }
      this.events.transport({ sessionId: session.id, state: 'detached', attempt: 0, message: 'The local terminal disconnected. Reopen or retry to reconnect.' })
    }))
    this.schedulePoll()
    return runtime
  }
  private schedulePoll(): void {
    if (this.polling || this.shuttingDown || !this.runtimes.size) return
    this.polling = setTimeout(() => {
      this.polling = null
      void this.list().catch(() => {}).finally(() => this.schedulePoll())
    }, 3_000)
    this.polling.unref()
  }
  private dimensions(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || cols > 500 || rows < 1 || rows > 300) throw new Error('Invalid terminal dimensions.')
  }
  attach(id: string, cols: number, rows: number): Promise<{ output: string }> {
    return this.serialize(async () => {
      this.dimensions(cols, rows)
      await this.reconcile()
      const session = this.get(id)
      if (session.state !== 'idle') return { output: await this.capture(id) }
      const current = this.runtimes.get(id)
      if (current) { current.process.resize(cols, rows); return { output: current.output } }
      if (session.backend === 'pty') throw new Error('This shell ended. Create a new host terminal.')
      const pane = (await this.panes()).find((item) => item.name === session.tmuxName)
      if (!pane || pane.owner !== id || pane.dead) throw new Error('The exact host terminal is no longer available.')
      this.spawn(session, cols, rows)
      return { output: '' }
    })
  }
  async retryAttach(id: string, cols: number, rows: number): Promise<void> {
    await this.attach(id, cols, rows)
    this.events.transport({ sessionId: id, state: 'attached', attempt: 0, message: null })
  }
  write(id: string, data: string): void {
    const session = this.get(id)
    if (this.shuttingDown || typeof data !== 'string' || Buffer.byteLength(data, 'utf8') > 2 * 1024 * 1024) throw new Error('Invalid terminal input (maximum 2 MB).')
    const runtime = this.runtimes.get(id)
    if (!runtime || session.state !== 'idle') throw new Error('The host terminal is not connected.')
    // Small writes avoid blocking Electron's event loop on large clipboard pastes.
    for (let offset = 0; offset < data.length; offset += 16 * 1024) runtime.process.write(data.slice(offset, offset + 16 * 1024))
  }
  resize(id: string, cols: number, rows: number): void {
    this.get(id); this.dimensions(cols, rows)
    if (!this.shuttingDown) this.runtimes.get(id)?.process.resize(cols, rows)
  }
  private async capture(id: string): Promise<string> {
    const session = this.get(id)
    if (session.backend === 'tmux' && this.deps.tmux) {
      const pane = (await this.panes()).find((item) => item.name === session.tmuxName)
      if (pane && pane.owner !== id) throw new Error('Host terminal ownership changed; the other session was not accessed.')
      if (pane) return (await this.tmux(['capture-pane', '-p', '-e', '-S', '-5000', '-t', `=${session.tmuxName}:0.0`])).slice(-LIMIT).replace(/\r?\n/g, '\r\n')
    }
    return this.runtimes.get(id)?.output ?? this.buffers.get(id) ?? ''
  }
  captureBuffer(id: string): Promise<string> { return this.serialize(() => this.capture(id)) }
  close(id: string): Promise<void> {
    return this.serialize(async () => {
      const session = this.get(id)
      if (session.backend === 'tmux') {
        const pane = (await this.panes()).find((item) => item.name === session.tmuxName)
        if (pane && pane.owner !== id) throw new Error('Host terminal ownership changed. Nothing was stopped or deleted.')
        if (pane) {
          await this.tmux(['kill-session', '-t', `=${session.tmuxName}`])
          if ((await this.panes()).some((item) => item.name === session.tmuxName)) throw new Error('The host terminal is still running; its record was kept.')
        }
      }
      const runtime = this.runtimes.get(id)
      if (runtime) {
        runtime.intentional = true
        runtime.process.kill()
        for (const disposable of runtime.subscriptions) disposable.dispose()
        this.runtimes.delete(id)
      }
      this.buffers.delete(id)
      this.store.deleteHostTerminal(id)
      this.notify()
    })
  }
  updateRestartBlocker(): string | null {
    return [...this.runtimes.keys()].some((id) => this.store.getHostTerminal(id)?.backend === 'pty')
      ? 'Close non-tmux host terminals before restarting to update.' : null
  }
  shutdown(): void {
    this.shuttingDown = true
    if (this.polling) clearTimeout(this.polling)
    for (const [id, runtime] of this.runtimes) {
      runtime.intentional = true
      for (const disposable of runtime.subscriptions) disposable.dispose()
      try { runtime.process.kill() } catch { /* The process may have just exited. */ }
      if (this.store.getHostTerminal(id)?.backend === 'pty') this.store.setHostTerminalState(id, 'completed')
    }
    this.runtimes.clear()
    this.buffers.clear()
  }
}
