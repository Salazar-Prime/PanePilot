import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LatexPdfDocument, LatexPdfSnapshot } from '../shared/types'

export const PDF_SNAPSHOT_HOT_BYTES = 16 * 1024 * 1024
const MAX_PDF_BYTES = 32 * 1024 * 1024

type Snapshot = {
  id: string
  key: string
  file: string
  metadata: Omit<LatexPdfDocument, 'dataBase64'>
  references: number
  accepted: boolean
  bytes: number
}
type Owner = {
  disposed: boolean
  directory: Promise<string>
  entries: Map<string, Snapshot>
  latest: Map<string, Snapshot>
  opening: Map<string, Promise<Snapshot>>
  pending: Set<Promise<unknown>>
}

/** Renderer-lifetime immutable PDFs. Hot buffers are bounded; cold copies are never read from the project. */
export class PdfSnapshotStore {
  private owners = new Map<number, Owner>()
  private hot = new Map<Snapshot, Buffer>()
  private hotBytes = 0
  private closedOwners = new Set<number>()
  private closing = new Map<number, Promise<void>>()
  private disposed = false

  constructor(private readonly options: { hotBytes?: number; temporaryRoot?: string } = {}) {}

  private owner(ownerId: number): Owner {
    if (this.disposed || this.closedOwners.has(ownerId)) throw new Error('The PDF preview window has closed.')
    let owner = this.owners.get(ownerId)
    if (!owner) {
      owner = {
        disposed: false,
        directory: mkdtemp(join(this.options.temporaryRoot ?? tmpdir(), 'panepilot-pdf-snapshots-'))
          .then(async (directory) => { await chmod(directory, 0o700); return directory }),
        entries: new Map(), latest: new Map(), opening: new Map(), pending: new Set()
      }
      this.owners.set(ownerId, owner)
    }
    return owner
  }

  private assertActive(owner: Owner): void {
    if (owner.disposed) throw new Error('The PDF preview window has closed.')
  }

  private track<T>(owner: Owner, operation: () => Promise<T>): Promise<T> {
    const promise = operation()
    owner.pending.add(promise)
    const clear = () => { owner.pending.delete(promise) }
    void promise.then(clear, clear)
    return promise
  }

  private warm(snapshot: Snapshot, bytes: Buffer): void {
    this.forgetHot(snapshot)
    const budget = Math.max(0, this.options.hotBytes ?? PDF_SNAPSHOT_HOT_BYTES)
    if (bytes.byteLength > budget) return
    while (this.hotBytes + bytes.byteLength > budget && this.hot.size) {
      this.forgetHot(this.hot.keys().next().value!)
    }
    this.hot.set(snapshot, bytes)
    this.hotBytes += bytes.byteLength
  }

  private forgetHot(snapshot: Snapshot): void {
    const bytes = this.hot.get(snapshot)
    if (!bytes) return
    this.hot.delete(snapshot)
    this.hotBytes -= bytes.byteLength
  }

  private async collect(owner: Owner, snapshot: Snapshot): Promise<void> {
    if (snapshot.references || owner.latest.get(snapshot.key) === snapshot) return
    owner.entries.delete(snapshot.id)
    this.forgetHot(snapshot)
    await rm(snapshot.file, { force: true })
  }

  private async create(owner: Owner, key: string, document: LatexPdfDocument): Promise<Snapshot> {
    this.assertActive(owner)
    if (typeof document.dataBase64 !== 'string' || document.dataBase64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4) {
      throw new Error('PanePilot previews PDFs up to 32 MB.')
    }
    const bytes = Buffer.from(document.dataBase64, 'base64')
    if (bytes.byteLength > MAX_PDF_BYTES || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('The selected document is not a supported PDF file.')
    }
    const directory = await owner.directory
    this.assertActive(owner)
    const id = randomUUID()
    const file = join(directory, `${id}.pdf`)
    await writeFile(file, bytes, { mode: 0o600, flag: 'wx' })
    this.assertActive(owner)
    const snapshot: Snapshot = {
      id, key, file, references: 1, accepted: false, bytes: bytes.byteLength,
      metadata: { path: document.path, size: bytes.byteLength, modifiedAt: document.modifiedAt }
    }
    owner.entries.set(id, snapshot)
    this.warm(snapshot, bytes)
    return snapshot
  }

  private async document(owner: Owner, snapshot: Snapshot): Promise<LatexPdfSnapshot> {
    this.assertActive(owner)
    const bytes = this.hot.get(snapshot) ?? await readFile(snapshot.file)
    this.assertActive(owner)
    this.warm(snapshot, bytes)
    return { ...snapshot.metadata, snapshotId: snapshot.id, dataBase64: bytes.toString('base64') }
  }

  acquire(ownerId: number, key: string, load: () => Promise<LatexPdfDocument>, refresh = false): Promise<LatexPdfSnapshot> {
    const owner = this.owner(ownerId)
    return (async () => {
      let ownsCreatedReference = false
      let snapshot = refresh ? undefined : owner.latest.get(key)
      if (!snapshot) {
        let opening = refresh ? undefined : owner.opening.get(key)
        if (!opening) {
          ownsCreatedReference = true
          opening = load().then((document) => {
            this.assertActive(owner)
            return this.track(owner, () => this.create(owner, key, document))
          })
          owner.opening.set(key, opening)
          const clear = () => { if (owner.opening.get(key) === opening) owner.opening.delete(key) }
          void opening.then(clear, clear)
        }
        snapshot = await opening
      }
      this.assertActive(owner)
      if (!ownsCreatedReference) snapshot.references += 1
      try {
        return await this.track(owner, () => this.document(owner, snapshot))
      } catch (error) {
        snapshot.references -= 1
        await this.track(owner, () => this.collect(owner, snapshot))
        throw error
      }
    })()
  }

  accept(ownerId: number, id: string): Promise<void> {
    const owner = this.owners.get(ownerId)
    const snapshot = owner?.entries.get(id)
    if (!owner || !snapshot || !snapshot.references) return Promise.reject(new Error('The PDF snapshot is no longer open.'))
    return this.track(owner, async () => {
      this.assertActive(owner)
      // Opening an older accepted snapshot in another pane must not undo a newer compile.
      if (snapshot.accepted) return
      snapshot.accepted = true
      const previous = owner.latest.get(snapshot.key)
      owner.latest.set(snapshot.key, snapshot)
      if (previous && previous !== snapshot) await this.collect(owner, previous)
    })
  }

  read(ownerId: number, id: string): Promise<LatexPdfSnapshot> {
    const owner = this.owners.get(ownerId)
    const snapshot = owner?.entries.get(id)
    if (!owner || !snapshot || !snapshot.references) return Promise.reject(new Error('The PDF snapshot is no longer open.'))
    // A print request pins its bytes even if the preview concurrently unmounts.
    snapshot.references += 1
    return this.track(owner, async () => {
      try { return await this.document(owner, snapshot) }
      finally { snapshot.references -= 1; await this.collect(owner, snapshot) }
    })
  }

  release(ownerId: number, id: string): Promise<void> {
    const owner = this.owners.get(ownerId)
    const snapshot = owner?.entries.get(id)
    if (!owner || !snapshot) return Promise.resolve()
    return this.track(owner, async () => {
      snapshot.references = Math.max(0, snapshot.references - 1)
      await this.collect(owner, snapshot)
    })
  }

  disposeOwner(ownerId: number): Promise<void> {
    const existing = this.closing.get(ownerId)
    if (existing) return existing
    this.closedOwners.add(ownerId)
    const owner = this.owners.get(ownerId)
    if (!owner) return Promise.resolve()
    this.owners.delete(ownerId)
    owner.disposed = true
    for (const snapshot of owner.entries.values()) this.forgetHot(snapshot)
    const cleanup = (async () => {
      await Promise.allSettled([...owner.pending])
      await rm(await owner.directory, { recursive: true, force: true })
    })()
    this.closing.set(ownerId, cleanup)
    const clear = () => { this.closing.delete(ownerId) }
    void cleanup.then(clear, clear)
    return cleanup
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await Promise.all([
      ...this.closing.values(),
      ...[...this.owners.keys()].map((ownerId) => this.disposeOwner(ownerId))
    ])
  }

  stats(): { hotBytes: number; hotSnapshots: number; snapshots: number; owners: number } {
    return {
      hotBytes: this.hotBytes, hotSnapshots: this.hot.size, owners: this.owners.size,
      snapshots: [...this.owners.values()].reduce((total, owner) => total + owner.entries.size, 0)
    }
  }
}
