import { performance } from 'node:perf_hooks'
import { TerminalManager } from '../../src/main/terminal-manager'
import type { TerminalSession } from '../../src/shared/types'

const BUFFER_LIMIT = 512 * 1024
const APPEND_BYTES = 512
const APPEND_COUNT = 2_000
const REPETITIONS = 3

interface OutputHarness {
  shuttingDown: boolean
  volatileOutput: Map<string, { chunks: string[]; byteLength: number }>
  retainTerminalOutput(session: TerminalSession, data: string): void
}

function outputHarness(): OutputHarness {
  // Bypass the constructor: this benchmark must never resolve tmux, start a
  // shell, read a provider archive, open SQLite, or attach to a real session.
  const harness = Object.create(TerminalManager.prototype) as OutputHarness
  harness.shuttingDown = false
  harness.volatileOutput = new Map()
  return harness
}

function chunk(index: number): string {
  const marker = `${index.toString(36).padStart(6, '0')}|`
  return marker.repeat(Math.ceil(APPEND_BYTES / marker.length)).slice(0, APPEND_BYTES)
}

export async function runTerminalBenchmarks() {
  const session = { id: 'synthetic-codex-output', profile: 'codex' } as TerminalSession
  const chunks = Array.from({ length: APPEND_COUNT }, (_, index) => chunk(index))
  const appended = chunks.join('')
  const samples: Array<Record<string, unknown>> = []

  // Warm the method outside timed samples. No constructor or native PTY call.
  const warmup = outputHarness()
  for (const data of chunks.slice(0, 64)) warmup.retainTerminalOutput(session, data)
  warmup.volatileOutput.clear()

  for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
    // Alternate ordering so a consistently warmer second sample does not
    // always favor the same scenario.
    const scenarios = repetition % 2 ? ['empty', 'saturated'] : ['saturated', 'empty']
    for (const scenario of scenarios) {
      const harness = outputHarness()
      const prefix = scenario === 'saturated' ? 's'.repeat(BUFFER_LIMIT) : ''
      if (prefix) harness.retainTerminalOutput(session, prefix)
      const gc = (globalThis as unknown as { gc?: () => void }).gc
      gc?.()
      const memoryBefore = process.memoryUsage()
      const cpuBefore = process.cpuUsage()
      const started = performance.now()
      for (const data of chunks) harness.retainTerminalOutput(session, data)
      const elapsedMs = performance.now() - started
      const cpu = process.cpuUsage(cpuBefore)
      const memoryAfter = process.memoryUsage()
      const output = harness.volatileOutput.get(session.id)!
      const retained = output.chunks.join('')
      const expected = (prefix + appended).slice(-BUFFER_LIMIT)
      if (retained !== expected || output.byteLength !== Buffer.byteLength(retained)) {
        throw new Error(`Volatile terminal replay invariant failed: ${scenario}, repetition ${repetition}`)
      }
      samples.push({
        scenario,
        repetition,
        appendCount: APPEND_COUNT,
        appendBytes: APPEND_BYTES,
        inputBytes: APPEND_COUNT * APPEND_BYTES,
        initialBytes: prefix.length,
        retainedBytes: Buffer.byteLength(retained),
        retainedChunks: output.chunks.length,
        elapsedMs,
        cpuUserMs: cpu.user / 1_000,
        cpuSystemMs: cpu.system / 1_000,
        heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
        rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
        externalDeltaBytes: memoryAfter.external - memoryBefore.external,
        exactTailVerified: true,
        gcBeforeSample: Boolean(gc)
      })
      harness.volatileOutput.clear()
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  return {
    name: 'codex-volatile-terminal-output',
    source: 'src/main/terminal-manager.ts:2351',
    method: 'Actual TerminalManager.prototype.retainTerminalOutput; constructor bypassed; synthetic ASCII only.',
    limitations: [
      'Measures replay-buffer work only, excluding PTY, headless xterm, IPC, renderer, SQLite, and provider CPU.',
      'The empty scenario reaches the 512 KiB cap during its 2,000 appends; saturated starts at that cap.',
      'Heap/RSS deltas are end-of-sample observations and can include GC; they are not peak allocation or leak measurements.',
      'Elapsed and CPU measurements are energy proxies, not measured watts or battery drain.'
    ],
    samples
  }
}
