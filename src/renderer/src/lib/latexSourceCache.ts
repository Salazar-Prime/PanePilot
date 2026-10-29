export interface LatexSourceSnapshot { savedContent: string; draft: string }

/** Dirty source is user data, not an evictable cache entry. */
export class LatexSourceCache extends Map<string, LatexSourceSnapshot> {
  constructor(private readonly onEvict: (key: string) => void, private readonly maxCleanSources = 32, private readonly maxCleanBytes = 16 * 1024 * 1024) { super() }

  override set(key: string, snapshot: LatexSourceSnapshot): this {
    super.delete(key)
    super.set(key, snapshot)
    let count = 0
    let bytes = 0
    const clean: [string, LatexSourceSnapshot][] = []
    for (const entry of this) {
      if (entry[1].draft !== entry[1].savedContent) continue
      clean.push(entry)
      count++
      bytes += (entry[1].draft.length + entry[1].savedContent.length) * 2
    }
    for (const [oldKey, old] of clean) {
      if (count <= this.maxCleanSources && bytes <= this.maxCleanBytes) break
      count--
      bytes -= (old.draft.length + old.savedContent.length) * 2
      super.delete(oldKey)
      this.onEvict(oldKey)
    }
    return this
  }
}
