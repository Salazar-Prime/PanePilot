import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostTerminal, TerminalDataEvent, TerminalTransportEvent } from '../src/shared/types'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { hostTerminalSocket, HostTerminalService } from '../src/main/host-terminal-service'
import { Store } from '../src/main/store'

type Disposable = { dispose(): void }
type PtyHandlers = {
  data: Array<(data: string) => void>
  exit: Array<(event: { exitCode: number }) => void>
  writes: string[]
  sizes: Array<[number, number]>
  kills: number
}

function ptyHarness() {
  const children: PtyHandlers[] = []
  const spawn = vi.fn((_file: string, _args: string[], _options: unknown) => {
    const handlers: PtyHandlers = { data: [], exit: [], writes: [], sizes: [], kills: 0 }
    children.push(handlers)
    return {
      write: (data: string) => handlers.writes.push(data),
      resize: (cols: number, rows: number) => handlers.sizes.push([cols, rows]),
      kill: () => { handlers.kills += 1 },
      onData: (listener: (data: string) => void): Disposable => {
        handlers.data.push(listener)
        return { dispose: () => { handlers.data = handlers.data.filter((item) => item !== listener) } }
      },
      onExit: (listener: (event: { exitCode: number }) => void): Disposable => {
        handlers.exit.push(listener)
        return { dispose: () => { handlers.exit = handlers.exit.filter((item) => item !== listener) } }
      }
    }
  })
  return { children, spawn }
}

function setup(options: { tmux?: string | null } = {}) {
  const path = mkdtempSync(join(tmpdir(), 'panepilot-host-terminal-service-'))
  const store = new Store(path)
  const sessions = new Map<string, { name: string; owner: string; dead: boolean; exit: number }>()
  const targets = new Map<string, string>()
  const calls: Array<{ file: string; args: string[] }> = []
  const pty = ptyHarness()
  const events = {
    changed: vi.fn<(sessions: HostTerminal[]) => void>(),
    data: vi.fn<(event: TerminalDataEvent) => void>(),
    transport: vi.fn<(event: TerminalTransportEvent) => void>()
  }
  let failKill = false
  let failSetOption = false
  let nextTarget = 1
  let listFailure: Error | null = null
  const run = vi.fn(async (file: string, args: string[]) => {
    calls.push({ file, args })
    const command = args[5]
    if (command === 'new-session') {
      const name = args[args.indexOf('-s') + 1]
      const target = `$${nextTarget++}`
      sessions.set(name, { name, owner: '', dead: false, exit: 0 })
      targets.set(target, name)
      return target
    }
    if (command === 'set-option') {
      if (failSetOption) throw new Error('set-option denied')
      const ownerOption = args.indexOf('@panepilot_host_terminal_id')
      if (ownerOption >= 0) {
        const target = args[args.indexOf('-t') + 1].replace(/:0$/, '')
        const name = targets.get(target)
        if (name) sessions.get(name)!.owner = args[ownerOption + 1]!
      }
      return ''
    }
    if (command === 'list-panes') {
      if (listFailure) throw listFailure
      return [...sessions.values()].map((pane) => `${pane.name}\t${pane.owner}\t${pane.dead ? 1 : 0}\t${pane.exit}`).join('\n')
    }
    if (command === 'kill-session') {
      if (failKill) throw new Error('kill denied')
      const target = args[args.indexOf('-t') + 1]!
      const name = targets.get(target) ?? target.slice(1)
      sessions.delete(name)
      for (const [key, value] of targets) if (value === name) targets.delete(key)
      return ''
    }
    if (command === 'capture-pane') return 'captured output\n'
    throw new Error(`Unexpected fake tmux command: ${args.join(' ')}`)
  })
  const service = new HostTerminalService(store, '/profile/path', events, {
    tmux: options.tmux === undefined ? '/fake/tmux' : options.tmux,
    home: '/test-home',
    shell: '/bin/zsh',
    spawn: pty.spawn as never,
    run
  })
  const close = () => {
    service.shutdown()
    store.close()
    rmSync(path, { recursive: true, force: true })
  }
  return { path, store, service, sessions, calls, pty, events, run, close, setFailKill: (value: boolean) => { failKill = value }, setFailSetOption: (value: boolean) => { failSetOption = value }, setListFailure: (value: Error | null) => { listFailure = value } }
}

describe('host terminal service', () => {
  const cleanups: Array<() => void> = []
  function make(options: { tmux?: string | null } = {}) {
    const context = setup(options)
    cleanups.push(context.close)
    return context
  }
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  it('creates host shells without requiring a project', async () => {
    const { service, store, calls } = make()
    const session = await service.create()
    expect(store.listHostTerminals()).toEqual([session])
    expect(session.profile).toBe('shell')
    expect(session.state).toBe('idle')
    expect(calls.every(({ args }) => args.slice(0, 5).join(' ') === `-u -L ${hostTerminalSocket('/profile/path')} -f /dev/null`)).toBe(true)
    expect(hostTerminalSocket('/profile/path')).not.toBe(hostTerminalSocket('/another-profile'))
    expect(calls[0]!.args).toContain('/test-home')
    expect(calls[0]!.args).toContain(`exec '/bin/zsh' -l`)
    expect(calls.every(({ args }) => !args.some((arg) => /ssh|default/i.test(arg)))).toBe(true)
  })

  it('serializes concurrent creates into unique names and private tmux sessions', async () => {
    const { service, calls, run, pty } = make()
    const sessions = await Promise.all(Array.from({ length: 3 }, () => service.create()))
    expect(new Set(sessions.map(({ name }) => name)).size).toBe(3)
    expect(run).toHaveBeenCalledTimes(6)
    expect(calls.filter(({ args }) => args[5] === 'new-session').map(({ args }) => args[args.indexOf('-s') + 1])).toEqual(sessions.map(({ name }) => name))
    expect(calls.every(({ args }) => args[0] === '-u' && args[1] === '-L' && args[2] !== 'default')).toBe(true)
    expect(pty.spawn).not.toHaveBeenCalled()
    expect(calls.every(({ args }) => !args.includes('new-window') && !args.includes('list-sessions'))).toBe(true)
  })

  it('starts the shell as a login shell at home and uses a profile-specific private socket', async () => {
    const { service, calls, pty } = make()
    await service.create()
    await service.attach((await service.list())[0]!.id, 90, 28)
    const call = pty.spawn.mock.calls[0]!
    expect(call[0]).toBe('/fake/tmux')
    expect(call[1]).toContain('attach-session')
    expect(call[2]).toMatchObject({ cwd: '/test-home', cols: 90, rows: 28 })
    expect(calls[0]!.args.slice(0, 5)).toEqual(['-u', '-L', calls[0]!.args[2], '-f', '/dev/null'])
    expect(calls[0]!.args[2]).not.toBe('default')
  })

  it('lists without attaching, attaches the exact pane, and reattaches without creating another session', async () => {
    const { service, calls, pty } = make()
    const session = await service.create()
    const count = calls.length
    expect(await service.list()).toHaveLength(1)
    expect(calls.length).toBe(count + 1)
    expect(pty.spawn).not.toHaveBeenCalled()
    await service.attach(session.id, 100, 30)
    pty.children[0]!.exit.forEach((listener) => listener({ exitCode: 0 }))
    await service.attach(session.id, 110, 35)
    expect(pty.spawn).toHaveBeenCalledTimes(2)
    expect(calls.filter(({ args }) => args[5] === 'new-session')).toHaveLength(1)
  })

  it('cleans up the exact newly created session when metadata configuration fails', async () => {
    const { service, sessions, store, setFailSetOption } = make()
    const first = await service.create()
    setFailSetOption(true)
    await expect(service.create()).rejects.toThrow('set-option denied')
    expect(sessions.size).toBe(1)
    expect(sessions.has(first.tmuxName!)).toBe(true)
    expect(store.listHostTerminals().map(({ id }) => id)).toEqual([first.id])
  })

  it('closes and verifies only the exact owned session', async () => {
    const { service, store, sessions, calls } = make()
    const first = await service.create()
    const second = await service.create()
    await service.close(first.id)
    expect(store.getHostTerminal(first.id)).toBeNull()
    expect(store.getHostTerminal(second.id)).not.toBeNull()
    expect(sessions.has(second.tmuxName!)).toBe(true)
    expect(calls.some(({ args }) => args[5] === 'kill-server')).toBe(false)
  })

  it('preserves the record when stopping the exact tmux session fails', async () => {
    const { service, store, setFailKill } = make()
    const session = await service.create()
    setFailKill(true)
    await expect(service.close(session.id)).rejects.toThrow('kill denied')
    expect(store.getHostTerminal(session.id)).not.toBeNull()
  })

  it('refuses attach, capture, and kill when the pane ownership marker differs', async () => {
    const { service, sessions, store, calls } = make()
    const session = await service.create()
    sessions.get(session.tmuxName!)!.owner = 'other-owner'
    await expect(service.attach(session.id, 80, 24)).rejects.toThrow(/ownership changed/)
    await expect(service.captureBuffer(session.id)).rejects.toThrow(/ownership changed/)
    await expect(service.close(session.id)).rejects.toThrow(/ownership changed/)
    expect(store.getHostTerminal(session.id)).not.toBeNull()
    expect(calls.some(({ args }) => args[5] === 'kill-session')).toBe(false)
  })

  it('does not mark sessions completed when pane listing fails unexpectedly', async () => {
    const { service, store, setListFailure } = make()
    const session = await service.create()
    setListFailure(Object.assign(new Error('permission denied'), { code: 1, stderr: 'permission denied' }))
    await expect(service.list()).rejects.toThrow('permission denied')
    expect(store.getHostTerminal(session.id)?.state).toBe('idle')
  })

  it('marks sessions completed only when the private server is confirmed absent, without resurrection', async () => {
    const { service, store, setListFailure, run } = make()
    const session = await service.create()
    const missing = Object.assign(new Error('no server running'), { code: 1, stderr: 'no server running' })
    setListFailure(missing)
    expect((await service.list())[0]!.state).toBe('completed')
    await expect(service.attach(session.id, 80, 24)).resolves.toEqual({ output: '' })
    expect(run.mock.calls.filter(([, args]) => args[5] === 'new-session')).toHaveLength(1)
    expect(store.getHostTerminal(session.id)?.state).toBe('completed')
  })

  it('uses a PTY fallback without tmux and marks it completed on shutdown', async () => {
    const { service, store, calls, pty } = make({ tmux: null })
    const session = await service.create()
    expect(session.backend).toBe('pty')
    expect(calls).toHaveLength(0)
    expect(pty.spawn).toHaveBeenCalledWith('/bin/zsh', ['-l'], expect.objectContaining({ cwd: '/test-home' }))
    service.shutdown()
    expect(store.getHostTerminal(session.id)?.state).toBe('completed')
    expect(pty.children[0]!.kills).toBe(1)
  })

  it('kills attached tmux clients, not the private server, on shutdown', async () => {
    const { service, calls } = make()
    const session = await service.create()
    await service.attach(session.id, 80, 24)
    service.shutdown()
    expect(calls.some(({ args }) => args[5] === 'kill-server')).toBe(false)
    expect(calls.some(({ args }) => args[5] === 'kill-session')).toBe(false)
  })

  it('bounds captured runtime output and rejects invalid dimensions, IDs, and input', async () => {
    const { service, pty } = make({ tmux: null })
    const session = await service.create()
    await service.attach(session.id, 80, 24)
    pty.children[0]!.data.forEach((listener) => listener('x'.repeat(600 * 1024)))
    expect((await service.captureBuffer(session.id)).length).toBeLessThanOrEqual(512 * 1024)
    await expect(service.attach(session.id, 1, 24)).rejects.toThrow(/dimensions/)
    await expect(service.captureBuffer('missing')).rejects.toThrow(/not found/)
    expect(() => service.write(session.id, 'x'.repeat(2 * 1024 * 1024 + 1))).toThrow(/2 MB/)
  })

  it('enforces the sixteen-terminal maximum', async () => {
    const { service } = make({ tmux: null })
    for (let index = 0; index < 16; index += 1) await service.create()
    await expect(service.create()).rejects.toThrow(/16/)
  })
})
