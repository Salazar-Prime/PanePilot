import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir, cpus, totalmem, release } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Store } from '../../src/main/store'
import { ConversationIndexer } from '../../src/main/conversation-indexer'
import { runTerminalBenchmarks } from './desktop-terminal'
import { runSshBenchmarks } from './desktop-ssh'
import { runMetadataConcurrencyProbe } from './desktop-metadata'

const root = mkdtempSync(join(tmpdir(), 'panepilot-core-fixtures-'))
const round = (n: number) => Number(n.toFixed(3))
const gc = () => (globalThis as unknown as { gc?: () => void }).gc?.()
async function measure(action: () => unknown) {
  const before = process.cpuUsage()
  const started = performance.now()
  const timer = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - started), 0))
  const value = action()
  const wallMs = performance.now() - started
  const cpu = process.cpuUsage(before)
  const timerDelayMs = await timer
  return { wallMs: round(wallMs), cpuMs: round((cpu.user + cpu.system) / 1000),
    timerDelayMs: round(timerDelayMs), value }
}
const summary = (samples: Array<{ wallMs: number; cpuMs: number; timerDelayMs: number }>) => {
  const median = (key: 'wallMs' | 'cpuMs' | 'timerDelayMs') => samples.map(s => s[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)]
  return { samples, medianWallMs: median('wallMs'), medianCpuMs: median('cpuMs'), medianTimerDelayMs: median('timerDelayMs') }
}
function createProject(store: Store, folder: string, name: string) {
  mkdirSync(folder, { recursive: true })
  return store.createProject({ type: 'terminal', name, folder, connectionId: 'local', repositoryUrl: null })
}
function createSession(store: Store, projectId: string, name: string) {
  return store.createSession({ projectId, name, profile: 'shell', providerSessionName: null,
    customCommand: null, backend: 'pty', tmuxName: null, dangerousMode: false })
}
async function storage() {
  const results = []
  for (const appendBytes of [512, 4096, 16384]) {
    const samples = []
    for (let trial = 0; trial < 3; trial++) {
      const path = join(root, `wal-${appendBytes}-${trial}`); mkdirSync(path)
      const store = new Store(path)
      try {
        store.syncConnections([])
        const project = createProject(store, join(path, 'project'), 'Fixture')
        const session = createSession(store, project.id, 'Output')
        store.replaceOutput(session.id, 'x'.repeat(512 * 1024))
        const db = (store as any).db
        db.exec('PRAGMA wal_autocheckpoint = 0'); db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        const appendCount = 1024 * 1024 / appendBytes
        const chunk = 'y'.repeat(appendBytes)
        const { value: _, ...timing } = await measure(() => {
          for (let i = 0; i < appendCount; i++) store.appendOutput(session.id, chunk)
        })
        const walPath = join(path, 'project-console.sqlite-wal')
        const walBytes = existsSync(walPath) ? statSync(walPath).size : 0
        const retainedBytes = Buffer.byteLength(store.getSession(session.id)!.output)
        assert.ok(retainedBytes <= 512 * 1024 && retainedBytes >= 508 * 1024)
        samples.push({ ...timing, walBytes, retainedBytes, walToInputRatio: round(walBytes / (1024 * 1024)) })
      } finally { store.close() }
    }
    results.push({ appendBytes, appendCount: 1024 * 1024 / appendBytes, inputBytes: 1024 * 1024, ...summary(samples) })
  }
  return { note: 'Saturated 512 KiB shell output; WAL autocheckpoint disabled to measure cumulative logical WAL traffic, not disk residency or physical SSD writes. Different append sizes hold total input at 1 MiB. Current runtime batches for 250 ms; this is a Store-level stress scenario.', results }
}
async function hydration() {
  const results = []
  for (const projectCount of [25, 100]) {
    const path = join(root, `hydration-${projectCount}`); mkdirSync(path)
    const store = new Store(path)
    try {
      store.syncConnections([])
      for (let p = 0; p < projectCount; p++) {
        const project = createProject(store, join(path, `project-${p}`), `Project ${p}`)
        for (let s = 0; s < 4; s++) {
          const session = createSession(store, project.id, `Session ${s}`)
          store.replaceOutput(session.id, 'x'.repeat(512 * 1024))
        }
      }
      const measurements = []
      for (const [name, read] of [
        ['renderer', () => store.listProjectsForRenderer()],
        ['runtime', () => store.listProjectsForRuntime()],
        ['legacy-output-included', () => store.listProjects()]
      ] as const) {
        read(); gc()
        const samples = []
        let jsonBytes = 0
        for (let t = 0; t < 5; t++) {
          const { value, ...timing } = await measure(read)
          jsonBytes = Buffer.byteLength(JSON.stringify(value))
          samples.push(timing)
        }
        measurements.push({ name, jsonBytes, ...summary(samples) })
      }
      results.push({ projectCount, sessionsPerProject: 4, storedBytesPerSession: 512 * 1024, measurements })
    } finally { store.close() }
  }
  return { note: 'Actual Store queries. Serialization excluded from timings; payload sizes reported separately. Legacy API is comparison only: current renderer/runtime paths omit replay.', results }
}
async function archives() {
  const results = []
  for (const fileCount of [100, 1000]) {
    const path = join(root, `archives-${fileCount}`); mkdirSync(path)
    const project = join(path, 'project')
    let sourceBytes = 0
    for (let f = 0; f < fileCount; f++) {
      const cwd = f % 10 === 0 ? project : join(path, `other-${f % 10}`)
      const lines = [JSON.stringify({ type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: `thread-${f}`, cwd } })]
      for (let m = 0; m < 100; m++) lines.push(JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T00:00:01Z',
        payload: { type: m % 2 ? 'agent_message' : 'user_message', message: `${f}:${m} benchmark needle ${'a'.repeat(480)}` } }))
      const source = lines.join('\n') + '\n'; sourceBytes += Buffer.byteLength(source)
      writeFileSync(join(path, `archive-${f}.jsonl`), source)
    }
    const cold = []
    const coldSample = async () => {
      const baseline = process.memoryUsage().heapUsed
      const indexer = new ConversationIndexer([{ provider: 'codex', path }])
      const { value, ...timing } = await measure(() => indexer.list(project))
      assert.equal((value as unknown[]).length, fileCount / 10)
      gc(); return { ...timing, retainedHeapDeltaBytes: process.memoryUsage().heapUsed - baseline,
        cachedFileCount: (indexer as any).cache.size }
    }
    for (let t = 0; t < 3; t++) {
      // Finish the previous invocation before GC so its indexer cannot remain
      // the loop's live lexical binding and distort the retained-heap baseline.
      gc(); cold.push(await coldSample())
    }
    const indexer = new ConversationIndexer([{ provider: 'codex', path }]); indexer.list(project)
    const warm = [], search = []
    for (let t = 0; t < 7; t++) {
      const { value: _, ...timing } = await measure(() => indexer.list(project)); warm.push(timing)
      const { value: __, ...searchTiming } = await measure(() => indexer.list(project, 'needle')); search.push(searchTiming)
    }
    appendFileSync(join(path, 'archive-0.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'new reply' } }) + '\n')
    const { value: _, ...changedFileTiming } = await measure(() => indexer.list(project))
    results.push({ fileCount, sourceBytes, messagesPerFile: 100, matchingProjectFraction: 0.1,
      cold: summary(cold), warm: summary(warm), search: summary(search), changedFileTiming })
  }
  return { note: 'Cold means new indexer; OS filesystem caches are warm from fixture generation. 90% of archives belong to other projects. Heap delta is diagnostic, GC/runtime-sensitive. Timer delay is a scheduled zero-delay callback, not a UI frame or watt measurement.', results }
}
async function main() {
  try {
    const report = {
      generatedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      environment: { platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model,
        logicalCpus: cpus().length, memoryBytes: totalmem(), versions: process.versions },
      limitations: ['Synthetic service benchmarks in Electron Node runtime, not end-to-end interactive app.',
        'CPU time and IO volume are energy proxies. No calibrated watts, battery drain, or kernel wakeups measured.',
        'Fixture setup excluded. Trials serial; other host applications were not stopped. No live user files, archives, or SSH contacted.'],
      storage: await storage(), hydration: await hydration(), archives: await archives(), terminals: await runTerminalBenchmarks(), ssh: await runSshBenchmarks(),
      metadataConcurrency: await runMetadataConcurrencyProbe()
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } finally { rmSync(root, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
