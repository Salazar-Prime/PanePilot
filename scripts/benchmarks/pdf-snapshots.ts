import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { arch, cpus, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LatexPdfDocument } from '../../src/shared/types'
import { PdfSnapshotStore, PDF_SNAPSHOT_HOT_BYTES } from '../../src/main/pdf-snapshot-store'

const fixtureBytes = 2 * 1024 * 1024
function document(index: number): LatexPdfDocument {
  const bytes = Buffer.alloc(fixtureBytes)
  let seed = index + 1
  for (let offset = 0; offset < bytes.length; offset++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
    bytes[offset] = seed & 255
  }
  bytes.write('%PDF-1.7\n')
  return { path: 'main.pdf', size: bytes.length, modifiedAt: `fixture-${index}`, dataBase64: bytes.toString('base64') }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
async function timed<T>(action: () => Promise<T>) {
  const cpu = process.cpuUsage()
  const start = performance.now()
  const value = await action()
  const used = process.cpuUsage(cpu)
  return { wallMs: performance.now() - start, cpuMs: (used.user + used.system) / 1000, value }
}
async function diskBytes(directory: string): Promise<number> {
  let bytes = 0
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name)
    bytes += item.isDirectory() ? await diskBytes(path) : (await stat(path)).size
  }
  return bytes
}
async function run(projects: number) {
  const root = await mkdtemp(join(tmpdir(), 'panepilot-pdf-benchmark-'))
  const store = new PdfSnapshotStore({ temporaryRoot: root })
  try {
    const originals = Array.from({ length: projects }, (_, index) => document(index))
    // The control is the former renderer Map: all base64 strings retained per project.
    const legacy = new Map<string, LatexPdfDocument>()
    for (let index = 0; index < projects; index++) legacy.set(String(index), originals[index])
    const controlBase64Characters = [...legacy.values()].reduce((sum, pdf) => sum + pdf.dataBase64.length, 0)
    const load = await timed(async () => {
      for (let index = 0; index < projects; index++) {
        const snapshot = await store.acquire(1, String(index), async () => originals[index])
        await store.accept(1, snapshot.snapshotId)
        await store.release(1, snapshot.snapshotId)
      }
      return store.stats()
    })
    const files = await diskBytes(root)
    let projectRereads = 0
    const revisit = await timed(async () => {
      const snapshot = await store.acquire(1, '0', async () => { projectRereads++; return document(999) })
      assert.equal(hash(snapshot.dataBase64), hash(originals[0].dataBase64))
      await store.release(1, snapshot.snapshotId)
      return store.stats()
    })
    assert.equal(projectRereads, 0)
    assert.ok(store.stats().hotBytes <= PDF_SNAPSHOT_HOT_BYTES)
    const cleanup = await timed(async () => { await store.dispose(); return await diskBytes(root) })
    assert.equal(cleanup.value, 0)
    return { projects, pdfBytesEach: fixtureBytes, legacy: { retainedBase64Characters: controlBase64Characters },
      snapshotStore: { hotBudgetBytes: PDF_SNAPSHOT_HOT_BYTES, load, immutableTemporaryFileBytes: files, revisit,
        projectRereads, snapshotHashPreserved: true, cleanup } }
  } finally { await store.dispose(); await rm(root, { recursive: true, force: true }) }
}
async function main() {
  const cases = []
  for (const projects of [8, 24]) {
    const samples = []
    for (let repeat = 0; repeat < 3; repeat++) samples.push(await run(projects))
    cases.push({ projects, samples })
  }
  process.stdout.write(JSON.stringify({ capturedAt: new Date().toISOString(),
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    environment: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, node: process.versions.node, electron: process.versions.electron },
    method: 'Production PdfSnapshotStore, synthetic valid-signature 2 MiB buffers, isolated permission-restricted temporary directory, 3 samples. Former renderer Map control counts exact retained base64 characters. Each preview is released before the next project; project 0 is revisited after exceeding the hot budget. SHA-256 verifies immutable bytes and a sentinel loader detects accidental rereads of newer project data.',
    limitations: ['Hot bytes are actual store Buffer accounting, not full process RSS. Transient IPC/base64/decoder/PDF.js allocations are excluded.', 'Temporary snapshot files deliberately trade application-lifetime disk space for bounded retained memory; they are removed on owner disposal.', 'Cold refers to the application LRU; filesystem caches are not flushed. Wall/CPU measurements include snapshot writes/readback/base64 conversion, not actual PDF parsing, real project IO or printing.', 'No energy, watt or battery measurements are inferred.'], cases }, null, 2) + '\n')
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
