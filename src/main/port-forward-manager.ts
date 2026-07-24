import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import type {
  ConnectionTestResult,
  CreatePortForwardInput,
  PortForward,
  PortForwardState
} from '../shared/types'
import { Store } from './store'

interface ForwardRuntime {
  child: ChildProcess
  state: Extract<PortForwardState, 'starting' | 'running'>
  stderr: string
  stopping: boolean
}

function validPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535
}

function validateInput(input: CreatePortForwardInput): void {
  if (!input.name.trim()) throw new Error('Forward name is required.')
  if (input.name.trim().length > 80) {
    throw new Error('Forward names must be 80 characters or fewer.')
  }
  if (!validPort(input.localPort)) throw new Error('Local port must be between 1 and 65535.')
  if (!validPort(input.remotePort)) throw new Error('Remote port must be between 1 and 65535.')
  if (!/^[a-zA-Z0-9._-]+$/.test(input.remoteHost.trim())) {
    throw new Error('Remote host must be a hostname or IPv4 address without spaces.')
  }
  if (input.remoteHost.trim().length > 255) throw new Error('Remote host is too long.')
}

export function testSshConnection(sshAlias: string): ConnectionTestResult {
  const started = Date.now()
  const result = spawnSync(
    'ssh',
    [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=6',
      '-o',
      'ClearAllForwardings=yes',
      sshAlias,
      'printf panepilot-ok'
    ],
    { encoding: 'utf8', timeout: 8_000 }
  )
  const latencyMs = Date.now() - started
  if (result.error) {
    return { ok: false, message: result.error.message, latencyMs }
  }
  if (result.status !== 0 || result.stdout !== 'panepilot-ok') {
    const detail = (result.stderr ?? '').trim().split(/\r?\n/).at(-1)
    return {
      ok: false,
      message: detail || `SSH exited with status ${result.status ?? 'unknown'}.`,
      latencyMs
    }
  }
  return { ok: true, message: `Connected to ${sshAlias}.`, latencyMs }
}

export class PortForwardManager {
  private readonly runtimes = new Map<string, ForwardRuntime>()
  private readonly errors = new Map<string, string>()

  constructor(
    private readonly store: Store,
    private readonly onChanged: () => void
  ) {}

  list(connectionId: string): PortForward[] {
    return this.store.listPortForwards(connectionId).map((forward) => {
      const runtime = this.runtimes.get(forward.id)
      return {
        ...forward,
        state: runtime?.state ?? (this.errors.has(forward.id) ? 'error' : 'stopped'),
        error: this.errors.get(forward.id) ?? null
      }
    })
  }

  async create(input: CreatePortForwardInput): Promise<PortForward> {
    validateInput(input)
    const forward = this.store.createPortForward({
      ...input,
      name: input.name.trim(),
      remoteHost: input.remoteHost.trim()
    })
    try {
      await this.start(forward.id)
    } catch (error) {
      this.onChanged()
      throw error
    }
    return this.list(input.connectionId).find((item) => item.id === forward.id)!
  }

  async start(id: string): Promise<void> {
    if (this.runtimes.has(id)) return
    const forward = this.store.getPortForward(id)
    if (!forward) throw new Error('Port forward not found.')
    const connection = this.store.getConnection(forward.connectionId)
    if (!connection || connection.kind !== 'ssh' || !connection.sshAlias) {
      throw new Error('SSH connection not found.')
    }
    const duplicate = [...this.runtimes.keys()]
      .map((runtimeId) => this.store.getPortForward(runtimeId))
      .find(
        (candidate) =>
          candidate?.bindAddress === forward.bindAddress &&
          candidate.localPort === forward.localPort
      )
    if (duplicate) {
      throw new Error(`Local port ${forward.localPort} is already used by ${duplicate.name}.`)
    }

    this.errors.delete(id)
    const child = spawn(
      'ssh',
      [
        '-N',
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=8',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ClearAllForwardings=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '-L',
        `${forward.bindAddress}:${forward.localPort}:${forward.remoteHost}:${forward.remotePort}`,
        connection.sshAlias
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    const runtime: ForwardRuntime = {
      child,
      state: 'starting',
      stderr: '',
      stopping: false
    }
    this.runtimes.set(id, runtime)
    this.onChanged()

    child.stderr?.on('data', (chunk: Buffer) => {
      runtime.stderr = `${runtime.stderr}${chunk.toString('utf8')}`.slice(-8_192)
    })
    child.on('exit', (code) => {
      this.runtimes.delete(id)
      if (!runtime.stopping) {
        const detail = runtime.stderr.trim().split(/\r?\n/).at(-1)
        this.errors.set(
          id,
          detail || `SSH port forward exited with status ${code ?? 'unknown'}.`
        )
      }
      this.onChanged()
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      child.once('error', (error) => {
        if (settled) return
        settled = true
        this.runtimes.delete(id)
        this.errors.set(id, error.message)
        reject(error)
      })
      child.once('exit', (code) => {
        if (settled) return
        settled = true
        const detail = runtime.stderr.trim().split(/\r?\n/).at(-1)
        reject(
          new Error(
            detail || `Could not start the port forward (SSH status ${code ?? 'unknown'}).`
          )
        )
      })
      setTimeout(() => {
        if (settled) return
        settled = true
        runtime.state = 'running'
        this.onChanged()
        resolve()
      }, 500)
    })
  }

  stop(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime) {
      this.errors.delete(id)
      this.onChanged()
      return
    }
    runtime.stopping = true
    this.runtimes.delete(id)
    runtime.child.kill('SIGTERM')
    this.errors.delete(id)
    this.onChanged()
  }

  delete(id: string): void {
    if (this.runtimes.has(id)) throw new Error('Stop the port forward before deleting it.')
    this.errors.delete(id)
    this.store.deletePortForward(id)
    this.onChanged()
  }

  shutdown(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.stopping = true
      runtime.child.kill('SIGTERM')
    }
    this.runtimes.clear()
  }
}
