/** Models are shared by live editors; only clean, unowned models may be evicted. */
export interface RetainedEditorModel {
  getValue(): string
  getValueLength(): number
  setValue(value: string): void
  isDisposed(): boolean
  dispose(): void
  onDidChangeContent(listener: () => void): { dispose(): void }
}

interface Entry<M, V> {
  model: M
  savedValue: string
  owners: number
  ownerTokens: Set<object>
  view: V | null
  subscription: { dispose(): void }
  dirty: boolean
  forgotten?: boolean
}

export class EditorModelPool<M extends RetainedEditorModel, V> {
  private entries = new Map<string, Entry<M, V>>()
  private sweepPending = false

  constructor(private readonly maxCleanModels = 32, private readonly maxCleanBytes = 16 * 1024 * 1024) {}

  acquire(key: string, model: M, savedValue: string, desiredValue?: string, owner?: object): V | null {
    let entry = this.entries.get(key)
    if (entry?.model.isDisposed()) {
      entry.subscription.dispose()
      this.entries.delete(key)
      entry = undefined
    }
    if (entry && !entry.owners && !entry.dirty && desiredValue !== undefined) {
      // A cached clean model may be older than a refreshed filesystem snapshot.
      // Dirty models remain authoritative until explicitly saved/discarded.
      entry.savedValue = savedValue
      if (model.getValue() !== desiredValue) model.setValue(desiredValue)
    }
    if (!entry) {
      const fresh: Entry<M, V> = { model, savedValue, owners: 0, ownerTokens: new Set(), view: null, dirty: model.getValue() !== savedValue, subscription: { dispose() {} } }
      fresh.subscription = model.onDidChangeContent(() => {
        const wasDirty = fresh.dirty
        fresh.dirty = model.getValue() !== fresh.savedValue
        if (wasDirty && !fresh.dirty) this.scheduleSweep()
      })
      entry = fresh
      this.entries.set(key, entry)
    }
    if (model.getValue() === savedValue) {
      entry.savedValue = savedValue
      entry.dirty = false
    }
    entry.owners++
    if (owner) entry.ownerTokens.add(owner)
    entry.forgotten = false
    this.touch(key, entry)
    this.scheduleSweep()
    return entry.view
  }

  saved(key: string, value: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.savedValue = value
    entry.dirty = entry.model.getValue() !== value
    this.scheduleSweep()
  }

  discard(key: string, value: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.savedValue = value
    entry.model.setValue(value)
    entry.dirty = false
    this.scheduleSweep()
  }

  forget(key: string, owner?: object): void {
    const entry = this.entries.get(key)
    // Another pane may still own a draft for the same URI.
    if (!entry || entry.owners > 1 || (entry.owners && (!owner || !entry.ownerTokens.has(owner)))) return
    entry.forgotten = true
    this.scheduleSweep()
  }

  release(key: string, view: V | null, owner?: object): void {
    const entry = this.entries.get(key)
    if (!entry) return
    entry.owners = Math.max(0, entry.owners - 1)
    if (owner) entry.ownerTokens.delete(owner)
    if (view) entry.view = view
    this.touch(key, entry)
    // React must finish detaching every editor before disposing an old model.
    this.scheduleSweep()
  }

  private touch(key: string, entry: Entry<M, V>): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
  }

  private scheduleSweep(): void {
    if (this.sweepPending) return
    this.sweepPending = true
    queueMicrotask(() => { this.sweepPending = false; this.sweep() })
  }

  sweep(): void {
    let count = 0
    let bytes = 0
    const candidates: [string, Entry<M, V>][] = []
    for (const [key, entry] of this.entries) {
      if (!entry.owners && entry.forgotten) {
        entry.subscription.dispose()
        entry.model.dispose()
        this.entries.delete(key)
        continue
      }
      if (entry.owners || entry.dirty) continue
      candidates.push([key, entry])
      count++
      bytes += (entry.model.getValueLength() + entry.savedValue.length) * 2
    }
    for (const [key, entry] of candidates) {
      if (count <= this.maxCleanModels && bytes <= this.maxCleanBytes) break
      bytes -= (entry.model.getValueLength() + entry.savedValue.length) * 2
      count--
      entry.subscription.dispose()
      entry.model.dispose()
      this.entries.delete(key)
    }
  }

  get size(): number { return this.entries.size }
}
