import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

// Isolated request-count benchmark. Artificial latency replaces Git/SSH reads;
// this measures scheduling behavior, not real SSH latency or power consumption.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = await build({
  entryPoints: [resolve(root, 'src/renderer/src/lib/settledPolling.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false
})
const { startSettledPolling } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const protocol = { intervalMs: 120, requestLatencyMs: 250, foregroundMs: 600, hiddenMs: 1_200, resumedMs: 300 }

async function sample(mode) {
  class Visibility extends EventTarget { hidden = false }
  const visibility = new Visibility()
  const started = performance.now()
  const reads = []
  const pending = new Set()
  let peak = 0
  let foregroundAt = null
  let foregroundDelayMs = null
  const run = () => {
    reads.push({ atMs: performance.now() - started, hidden: visibility.hidden })
    if (foregroundAt !== null && foregroundDelayMs === null) foregroundDelayMs = performance.now() - foregroundAt
    const read = sleep(protocol.requestLatencyMs)
    pending.add(read)
    peak = Math.max(peak, pending.size)
    void read.then(() => pending.delete(read))
    return read
  }
  let stop
  if (mode === 'previous-fixed-interval') {
    void run()
    const timer = setInterval(() => void run(), protocol.intervalMs)
    stop = () => clearInterval(timer)
  } else {
    stop = startSettledPolling({ run, intervalMs: protocol.intervalMs, visibility })
  }
  await sleep(protocol.foregroundMs)
  visibility.hidden = true
  visibility.dispatchEvent(new Event('visibilitychange'))
  await sleep(protocol.hiddenMs)
  foregroundAt = performance.now()
  visibility.hidden = false
  visibility.dispatchEvent(new Event('visibilitychange'))
  await sleep(protocol.resumedMs)
  stop()
  await Promise.all(pending)
  const result = {
    mode, requests: reads.length, hiddenRequests: reads.filter((read) => read.hidden).length,
    peakConcurrentRequests: peak, foregroundDelayMs, elapsedMs: performance.now() - started
  }
  if (mode === 'settlement-and-visibility') {
    assert.equal(result.hiddenRequests, 0)
    assert.equal(result.peakConcurrentRequests, 1)
    assert.ok(foregroundDelayMs !== null && foregroundDelayMs < protocol.intervalMs)
  }
  return result
}

const samples = []
for (let index = 0; index < 3; index++) {
  const previous = await sample('previous-fixed-interval')
  const current = await sample('settlement-and-visibility')
  assert.ok(previous.requests > current.requests)
  samples.push({ previous, current })
}
const result = {
  measuredAt: new Date().toISOString(),
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  protocol,
  limitations: 'Scaled real-timer request-count fixture with artificial latency; no real Git/SSH, battery, watts, or Chromium hidden-window throttling is measured.',
  samples
}
const output = JSON.stringify(result, null, 2) + '\n'
if (process.argv[2]) {
  const destination = resolve(process.argv[2])
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, output)
  process.stdout.write(`Optional polling benchmark results: ${destination}\n`)
} else process.stdout.write(output)
