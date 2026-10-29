import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LatexPdfDocument } from '../src/shared/types'
import { PdfSnapshotStore } from '../src/main/pdf-snapshot-store'

function document(marker: string, size = 128): LatexPdfDocument {
  const bytes = Buffer.alloc(size, marker.charCodeAt(0))
  bytes.write('%PDF-1.7\n')
  return { path: 'main.pdf', size, modifiedAt: marker, dataBase64: bytes.toString('base64') }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('immutable PDF snapshots', () => {
  let root: string
  let store: PdfSnapshotStore
  let open: PdfSnapshotStore['acquire']
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'panepilot-snapshot-test-'))
    store = new PdfSnapshotStore({ hotBytes: 256, temporaryRoot: root })
    open = async (...arguments_) => {
      const snapshot = await store.acquire(...arguments_)
      await store.accept(arguments_[0], snapshot.snapshotId)
      return snapshot
    }
  })
  afterEach(async () => {
    await store.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('bounds hot bytes and restores a cold snapshot without reading a newer project PDF', async () => {
    for (let index = 0; index < 12; index++) {
      const opened = await open(1, `project-${index}`, async () => document(String(index)))
      await store.release(1, opened.snapshotId)
      expect(store.stats().hotBytes).toBeLessThanOrEqual(256)
    }
    expect(store.stats()).toEqual({ hotBytes: 256, hotSnapshots: 2, snapshots: 12, owners: 1 })
    const newerProjectPdf = vi.fn(async () => document('NEW'))
    const revisited = await open(1, 'project-0', newerProjectPdf)
    expect(revisited.dataBase64).toBe(document('0').dataBase64)
    expect(newerProjectPdf).not.toHaveBeenCalled()
    expect(store.stats().hotBytes).toBe(256)
  })

  it('preserves two panes’ exact displayed snapshots through another pane’s recompile', async () => {
    const left = await open(1, 'project', async () => document('A'))
    const right = await open(1, 'project', async () => document('unused'))
    expect(right.snapshotId).toBe(left.snapshotId)
    const compiled = await open(1, 'project', async () => document('B'), true)
    expect(compiled.snapshotId).not.toBe(left.snapshotId)
    await store.accept(1, left.snapshotId) // A slow second viewer finishes parsing the old snapshot.
    expect((await open(1, 'project', async () => document('unused'))).snapshotId).toBe(compiled.snapshotId)
    await store.release(1, left.snapshotId)
    expect((await store.read(1, right.snapshotId)).dataBase64).toBe(document('A').dataBase64)
    expect((await store.read(1, compiled.snapshotId)).dataBase64).toBe(document('B').dataBase64)
    expect(store.stats().snapshots).toBe(2)
    await store.release(1, right.snapshotId)
    await expect(store.read(1, right.snapshotId)).rejects.toThrow('no longer open')
    expect(store.stats().snapshots).toBe(1)
    await store.release(1, compiled.snapshotId)
    expect((await open(1, 'project', async () => document('C'))).snapshotId).toBe(compiled.snapshotId)
  })

  it('coalesces simultaneous initial opens and grants one independent lease to each pane', async () => {
    const pending = deferred<LatexPdfDocument>()
    const load = vi.fn(() => pending.promise)
    const left = open(1, 'project', load)
    const right = open(1, 'project', load)
    pending.resolve(document('A'))
    const [a, b] = await Promise.all([left, right])
    expect(load).toHaveBeenCalledTimes(1)
    expect(a.snapshotId).toBe(b.snapshotId)
    await open(1, 'project', async () => document('B'), true)
    await store.release(1, a.snapshotId)
    expect((await store.read(1, b.snapshotId)).modifiedAt).toBe('A')
    await store.release(1, b.snapshotId)
    expect(store.stats().snapshots).toBe(1)
  })

  it('retains in-flight refresh snapshots until each caller releases its lease', async () => {
    const snapshots = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      open(1, 'project', async () => document(String(index)), true)))
    for (const snapshot of snapshots) expect(await store.read(1, snapshot.snapshotId)).toEqual(snapshot)
    expect(store.stats().snapshots).toBe(8)
    for (const snapshot of snapshots) await store.release(1, snapshot.snapshotId)
    expect(store.stats().snapshots).toBe(1)
  })

  it('scopes capabilities to their owner and uses private temporary files', async () => {
    const snapshot = await open(1, 'project', async () => document('A'))
    await expect(store.read(2, snapshot.snapshotId)).rejects.toThrow('no longer open')
    const [directory] = await readdir(root)
    const path = join(root, directory)
    expect((await stat(path)).mode & 0o777).toBe(0o700)
    const [file] = await readdir(path)
    expect((await stat(join(path, file))).mode & 0o777).toBe(0o600)
    expect((await readFile(join(path, file))).toString('base64')).toBe(snapshot.dataBase64)
    await store.disposeOwner(1)
    expect(await readdir(root)).toEqual([])
    expect(store.stats().hotBytes).toBe(0)
    await expect(open(1, 'new', async () => document('B'))).rejects.toThrow('window has closed')
  })

  it('does not cache an individual PDF larger than the hot byte budget', async () => {
    const snapshot = await open(1, 'large', async () => document('A', 1024))
    expect(store.stats().hotBytes).toBe(0)
    expect((await store.read(1, snapshot.snapshotId)).dataBase64).toBe(snapshot.dataBase64)
    expect(store.stats().hotBytes).toBe(0)
  })

  it('preserves the last accepted snapshot after a failed refresh', async () => {
    const original = await open(1, 'project', async () => document('A'))
    await expect(open(1, 'project', async () => { throw new Error('compile failed') }, true)).rejects.toThrow('compile failed')
    await expect(open(1, 'project', async () => ({ ...document('B'), dataBase64: 'invalid' }), true)).rejects.toThrow('supported PDF')
    expect((await open(1, 'project', async () => document('C'))).snapshotId).toBe(original.snapshotId)
    expect(store.stats().snapshots).toBe(1)
  })


  it('discards a PDF.js-rejected candidate without replacing the last accepted snapshot', async () => {
    const accepted = await open(1, 'project', async () => document('A'))
    const candidate = await store.acquire(1, 'project', async () => ({
      ...document('bad'), dataBase64: Buffer.from('%PDF-invalid-body').toString('base64')
    }), true)
    await store.release(1, candidate.snapshotId)
    expect((await open(1, 'project', async () => document('C'))).snapshotId).toBe(accepted.snapshotId)
    expect(store.stats().snapshots).toBe(1)
    const firstInvalid = await store.acquire(1, 'new-project', async () => document('invalid'))
    await store.release(1, firstInvalid.snapshotId)
    const repaired = vi.fn(async () => document('repaired'))
    await open(1, 'new-project', repaired)
    expect(repaired).toHaveBeenCalledOnce()
  })

  it('does not wait for a compiler or source read when closing and rejects its late result', async () => {
    const pending = deferred<LatexPdfDocument>()
    const opening = open(1, 'project', () => pending.promise)
    const result = expect(opening).rejects.toThrow('window has closed')
    let disposed = false
    const closing = store.disposeOwner(1).then(() => { disposed = true })
    await closing
    expect(disposed).toBe(true)
    pending.resolve(document('A'))
    await result
    await closing
    expect(await readdir(root)).toEqual([])
  })

  it('global disposal finishes during an unresolved source load and removes its temporary directory', async () => {
    const pending = deferred<LatexPdfDocument>()
    const opening = open(1, 'project', () => pending.promise)
    const result = expect(opening).rejects.toThrow('window has closed')
    void store.disposeOwner(1)
    let disposed = false
    const shutdown = store.dispose().then(() => { disposed = true })
    await shutdown
    expect(disposed).toBe(true)
    pending.resolve(document('A'))
    await result
    await shutdown
    expect(await readdir(root)).toEqual([])
    await expect(open(2, 'new', async () => document('B'))).rejects.toThrow('window has closed')
  })
})
