// Queue-pressure comparison with a deterministic slow consumer. No PTY, network,
// provider, application profile, or user terminal is opened.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname ?? dirname(new URL(import.meta.url).pathname), '..')
const source = resolve(root, 'src/main/terminal-output-flow.ts')
const bundle = await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'esm', write: false })
const { TerminalOutputFlow } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const chunk = '\x1b[32m' + 'x'.repeat(1009) + '🙂\x1b[0m\r\n'
const chunkBytes = Buffer.byteLength(chunk)
const deliveries = 8192
const totalBytes = chunkBytes * deliveries
const consumerDelayMs = 2
const samples = []

async function sample(mode) {
  const started = performance.now()
  const cpuStart = process.cpuUsage()
  const outputHash = createHash('sha256')
  let pendingBytes = 0, peakBytes = 0, delivered = 0, parsed = 0, paused = false, pauses = 0, writes = 0
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const consume = (text, callback) => {
    writes++
    setTimeout(() => {
      outputHash.update(text)
      parsed += Buffer.byteLength(text)
      callback()
      if (parsed === totalBytes) resolveDone()
    }, consumerDelayMs)
  }
  let flow
  const pump = () => {
    while (!paused && delivered < deliveries) {
      delivered++
      if (flow) {
        flow.enqueue(chunk)
        peakBytes = Math.max(peakBytes, flow.pendingBytes)
      } else {
        pendingBytes += chunkBytes
        peakBytes = Math.max(peakBytes, pendingBytes)
        consume(chunk, () => { pendingBytes -= chunkBytes })
      }
    }
  }
  if (mode === 'bounded-settlement-flow') {
    flow = new TerminalOutputFlow({
      pause() { paused = true; pauses++ },
      resume() { paused = false; setImmediate(pump) },
      write: consume
    })
  }
  pump()
  await done
  const cpu = process.cpuUsage(cpuStart)
  const hash = outputHash.digest('hex')
  assert.equal(parsed, totalBytes)
  if (flow) {
    assert.equal(flow.pendingBytes, 0)
    assert.ok(peakBytes < 256 * 1024 + chunkBytes)
    flow.dispose()
  }
  return { mode, elapsedMs: performance.now() - started, cpuMs: (cpu.user + cpu.system) / 1000,
    maximumQueuedBytes: peakBytes, consumerWrites: writes, pauses, parsedBytes: parsed, sha256: hash }
}
for (let trial = 1; trial <= 3; trial++) {
  const previous = await sample('previous-unconditional-writes')
  const current = await sample('bounded-settlement-flow')
  assert.equal(previous.sha256, current.sha256, 'Flow control preserves every byte and its order.')
  samples.push({ trial, previous, current })
}
const result = {
  measuredAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceSha256: createHash('sha256').update(await readFile(source)).digest('hex'),
  protocol: { deliveries, chunkBytes, totalBytes, consumerDelayMs, highWaterMark: 256 * 1024, maxBatchBytes: 64 * 1024 },
  method: 'Actual TerminalOutputFlow versus prior unconditional delivery pattern, with an artificial delayed ordered consumer and producer honoring pause/resume. Three paired trials; exact SHA-256 equality.',
  limits: ['Queue counts describe this synthetic producer/consumer, not total Electron/PTY/xterm memory.',
    'The old pattern schedules all fake callbacks concurrently; elapsed times are not an app throughput comparison.',
    'Real native PTY buffers are outside this helper; production may overshoot the threshold by a delivered chunk.',
    'No watts, battery, real parser CPU, real SSH or full-application frame time measured.'],
  samples
}
const output = JSON.stringify(result, null, 2) + '\n'
if (process.argv[2]) {
  const destination = resolve(process.argv[2]); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, output)
  process.stdout.write(`Terminal flow benchmark: ${destination}\n`)
} else process.stdout.write(output)
