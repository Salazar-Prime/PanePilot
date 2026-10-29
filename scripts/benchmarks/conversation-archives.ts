import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { AsyncConversationIndexer } from '../../src/main/conversation-indexer-client'
import type { ConversationRoot } from '../../src/main/conversation-indexer'
import type { ConversationDetail, ConversationSummary } from '../../src/shared/types'

interface Indexer {
  list(folder: string, query?: string): ConversationSummary[] | Promise<ConversationSummary[]>
  get(folder: string, id: string): ConversationDetail | Promise<ConversationDetail>
}
interface LegacyIndexer extends Indexer {
  cache: Map<string, { conversation: { messages: Array<{ content: string }> } | null }>
}
interface Diagnostics {
  catalogFiles: number
  detailEntries: number
  detailBytes: number
  maxDetailBytes: number | null
  maxDetailEntries: number | null
  heapUsed: number
}
interface Timing {
  wallMs: number
  processCpuMs: number
  zeroDelayTimerMs: number
  maxHeartbeatGapMs: number
  heartbeatCallbacksDuringOperation: number
}
const { ConversationIndexer: BaselineIndexer } = require(process.argv[2]) as {
  ConversationIndexer: new (roots: ConversationRoot[]) => LegacyIndexer
}
const workerPath = process.argv[3]
const smoke = process.argv[4] === 'smoke'
const fixtureRoot = mkdtempSync(join(tmpdir(), 'panepilot-archive-fixtures-'))
const round = (value: number) => Number(value.toFixed(3))
const gc = () => (globalThis as unknown as { gc: () => void }).gc()
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
function summary<T extends Timing>(samples: T[]) {
  return { samples, medianWallMs: median(samples.map(s => s.wallMs)),
    medianProcessCpuMs: median(samples.map(s => s.processCpuMs)),
    medianZeroDelayTimerMs: median(samples.map(s => s.zeroDelayTimerMs)),
    medianMaxHeartbeatGapMs: median(samples.map(s => s.maxHeartbeatGapMs)) }
}
async function measure<T>(action: () => T | Promise<T>): Promise<{ value: T; timing: Timing }> {
  let finished = false
  let lastHeartbeat = performance.now()
  let maxGap = 0
  let heartbeats = 0
  const heartbeat = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - lastHeartbeat)
    lastHeartbeat = now
    if (!finished) heartbeats++
  }, 5)
  const cpuBefore = process.cpuUsage()
  const started = performance.now()
  const timer = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - started), 0))
  try {
    const value = await action()
    const wallMs = performance.now() - started
    const cpu = process.cpuUsage(cpuBefore)
    finished = true
    // Let a heartbeat blocked by synchronous work fire before collecting it.
    const [zeroDelayTimerMs] = await Promise.all([timer, new Promise(resolve => setTimeout(resolve, 10))])
    return { value, timing: { wallMs: round(wallMs), processCpuMs: round((cpu.user + cpu.system) / 1000),
      zeroDelayTimerMs: round(zeroDelayTimerMs), maxHeartbeatGapMs: round(maxGap),
      heartbeatCallbacksDuringOperation: heartbeats } }
  } finally { clearInterval(heartbeat) }
}
function fixture(fileCount: number) {
  const path = join(fixtureRoot, `archives-${fileCount}`)
  mkdirSync(path)
  const project = join(path, 'project')
  let sourceBytes = 0
  let originalFirst = ''
  for (let file = 0; file < fileCount; file++) {
    const cwd = file % 10 === 0 ? project : join(path, `other-${file % 10}`)
    const lines = [JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z',
      payload: { id: `thread-${file}`, cwd } })]
    for (let message = 0; message < 100; message++) lines.push(JSON.stringify({
      type: 'event_msg', timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, message + 1)).toISOString(),
      payload: { type: message % 2 ? 'agent_message' : 'user_message',
        message: `${file}:${message} benchmark needle `.padEnd(480, 'a') }
    }))
    const source = lines.join('\n') + '\n'
    sourceBytes += Buffer.byteLength(source)
    writeFileSync(join(path, `archive-${file}.jsonl`), source)
    if (file === 0) originalFirst = source
  }
  return { path, project, fileCount, sourceBytes, originalFirst }
}
type Fixture = ReturnType<typeof fixture>
type Mode = 'baseline-main-thread-unbounded' | 'worker-bounded-details'
async function create(mode: Mode, data: Fixture) {
  const roots: ConversationRoot[] = [{ provider: 'codex', path: data.path }]
  let worker: Worker | undefined
  const indexer = mode === 'baseline-main-thread-unbounded'
    ? new BaselineIndexer(roots)
    : new AsyncConversationIndexer(options => {
      worker = new Worker(workerPath, { workerData: options })
      return worker
    }, { roots })
  const diagnostics = async (): Promise<Diagnostics> => {
    if (indexer instanceof AsyncConversationIndexer) return indexer.diagnostics()
    gc()
    const conversations = [...indexer.cache.values()].flatMap(entry => entry.conversation ? [entry.conversation] : [])
    // Lower-bound content payload only: old implementation has no byte budget.
    return { catalogFiles: indexer.cache.size, detailEntries: conversations.length,
      detailBytes: conversations.reduce((bytes, value) => bytes + value.messages.reduce((n, message) => n + 2 * message.content.length, 0), 0),
      maxDetailBytes: null, maxDetailEntries: null, heapUsed: process.memoryUsage().heapUsed }
  }
  const started = performance.now()
  const initial = await diagnostics()
  const startupWallMs = round(performance.now() - started)
  gc()
  const mainHeapBefore = process.memoryUsage().heapUsed
  return { indexer, diagnostics, initial, mainHeapBefore, startupWallMs,
    close: async () => {
      if (indexer instanceof AsyncConversationIndexer) {
        indexer.dispose()
        if (worker) await worker.terminate()
      }
    }
  }
}
async function coldSample(mode: Mode, data: Fixture) {
  const session = await create(mode, data)
  try {
    const { value, timing } = await measure(() => session.indexer.list(data.project))
    assert.equal(value.length, data.fileCount / 10)
    const diagnostics = await session.diagnostics()
    gc()
    const mainRetainedHeapDeltaBytes = process.memoryUsage().heapUsed - session.mainHeapBefore
    const workerRetainedHeapDeltaBytes = mode === 'worker-bounded-details'
      ? diagnostics.heapUsed - session.initial.heapUsed : 0
    if (mode === 'worker-bounded-details') {
      assert.ok(diagnostics.detailEntries <= 8)
      assert.ok(diagnostics.detailBytes <= 16 * 1024 * 1024)
    }
    return { ...timing, startupWallMs: session.startupWallMs, mainRetainedHeapDeltaBytes,
      workerRetainedHeapDeltaBytes,
      combinedRetainedHeapDeltaBytes: mainRetainedHeapDeltaBytes + workerRetainedHeapDeltaBytes, diagnostics }
  } finally { await session.close() }
}
async function runMode(mode: Mode, data: Fixture) {
  writeFileSync(join(data.path, 'archive-0.jsonl'), data.originalFirst)
  const cold = []
  for (let sample = 0; sample < (smoke ? 1 : 3); sample++) {
    gc()
    cold.push(await coldSample(mode, data))
  }
  gc()
  const session = await create(mode, data)
  try {
    assert.equal((await session.indexer.list(data.project)).length, data.fileCount / 10)
    const warm = [], search = []
    for (let sample = 0; sample < (smoke ? 1 : 7); sample++) {
      const listed = await measure(() => session.indexer.list(data.project))
      assert.equal(listed.value.length, data.fileCount / 10)
      warm.push(listed.timing)
      const searched = await measure(() => session.indexer.list(data.project, 'needle'))
      assert.equal(searched.value.length, data.fileCount / 10)
      assert.ok(searched.value.every(item => item.matchCount >= 100))
      search.push(searched.timing)
    }
    appendFileSync(join(data.path, 'archive-0.jsonl'), JSON.stringify({ type: 'event_msg', timestamp: '2026-01-02T00:00:00Z',
      payload: { type: 'agent_message', message: 'changed-file-unique-reply' } }) + '\n')
    const changed = await measure(() => session.indexer.list(data.project))
    const changedSummary = changed.value.find(item => item.providerSessionId === 'thread-0')!
    assert.equal(changedSummary.messageCount, 101)
    const changedSearch = await session.indexer.list(data.project, 'changed-file-unique-reply')
    assert.equal(changedSearch.length, 1)
    assert.equal(changedSearch[0].providerSessionId, 'thread-0')
    const detail = await session.indexer.get(data.project, changedSummary.id)
    assert.equal(detail.messages.length, 101)
    assert.equal(detail.messages.at(-1)?.content, 'changed-file-unique-reply')
    const diagnostics = await session.diagnostics()
    if (mode === 'worker-bounded-details') {
      assert.ok(diagnostics.detailEntries <= 8)
      assert.ok(diagnostics.detailBytes <= 16 * 1024 * 1024)
    }
    return { mode, cold: summary(cold), warm: summary(warm), search: summary(search),
      changedFile: { ...changed.timing, appendVisibleInListSearchAndDetail: true }, diagnostics }
  } finally { await session.close() }
}
async function main() {
  try {
    const results = []
    for (const fileCount of smoke ? [10] : [100, 1000]) {
      const data = fixture(fileCount)
      const modes = []
      for (const mode of ['baseline-main-thread-unbounded', 'worker-bounded-details'] as const) {
        modes.push(await runMode(mode, data))
        gc()
      }
      results.push({ fileCount, sourceBytes: data.sourceBytes, messagesPerFile: 100,
        charactersPerMessage: 480, matchingProjectFraction: 0.1, modes })
    }
    process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), smoke,
      provenance: JSON.parse(process.env.PANEPILOT_ARCHIVE_BENCHMARK_PROVENANCE!),
      environment: { platform: process.platform, arch: process.arch, osRelease: release(),
        cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), versions: process.versions },
      methodology: [
        'Actual legacy synchronous indexer and current AsyncConversationIndexer with the production worker; temporary synthetic Codex archives only.',
        'Cold means a new catalog with the worker already started; startupWallMs reports initialization and its diagnostic GC separately. OS filesystem caches are warm after fixture generation.',
        'Cold has three samples, warm and full-text search each have seven; smoke mode is a setup check with one sample and ten archives.',
        'Wall and process CPU exclude fixture setup and diagnostic GC. Process CPU includes worker threads. Reads are sequential; host applications are not stopped.',
        'Zero-delay timer and 5 ms heartbeat run on the calling/main thread. Heartbeat max gap includes the first callback after a blocking operation. Neither is an animation-frame metric.',
        'Retained-heap deltas use explicit GC before and after the cold list, in each heap separately. Worker GC is injected only before untimed diagnostics. GC/runtime-sensitive estimates include returned summaries.',
        'Legacy detailBytes is a lower bound from UTF-16 message content; worker detailBytes is the production conservative cache charge including message and metadata overhead. These counters are not directly equivalent.',
        'The catalog retains summaries proportional to archive count. Only full-transcript detail caching is bounded to eight entries and 16 MiB; individual archive parsing still needs transient memory.',
        'Append correctness verifies list count, full-text search and full detail. No real provider archives, SSH hosts, app profile or network are used.',
        'CPU is an energy proxy; no watts, battery discharge or kernel wakeups are measured.'
      ], results }, null, 2) + '\n')
  } finally { rmSync(fixtureRoot, { recursive: true, force: true }) }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
