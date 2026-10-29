import type { FilePreview } from '@shared/types'
import type { OpenFileTab } from './fileTabs'

export interface CachedFileTab extends OpenFileTab {
  /** The tab remains open; its reloadable image payload must be read on selection. */
  previewEvicted?: boolean
}

export const INACTIVE_FILE_IMAGE_BYTES = 16 * 1024 * 1024

function reloadableImage(file: CachedFileTab): boolean {
  return Boolean(file.preview.imageDataUrl) && !file.editing && file.draft === file.preview.content
}

/**
 * Bound inactive, reloadable image payloads without evicting workspace identity or drafts.
 * Mounted owners are pinned because their React state still references the payloads.
 * The conservative byte charge allows two bytes per data-URL character.
 */
export class FilesWorkspaceCache<T extends { openFiles: CachedFileTab[] }> {
  private readonly snapshots = new Map<string, T>()
  private readonly mountedOwners = new Map<string, number>()
  private readonly imageBytes = new Map<string, number>()
  private inactiveImageBytes = 0

  constructor(private readonly maxInactiveImageBytes = INACTIVE_FILE_IMAGE_BYTES) {}

  get(projectId: string): T | undefined {
    const snapshot = this.snapshots.get(projectId)
    if (snapshot) {
      this.snapshots.delete(projectId)
      this.snapshots.set(projectId, snapshot)
    }
    return snapshot
  }

  set(projectId: string, snapshot: T): void {
    const bytes = snapshot.openFiles.reduce((total, file) => total + (reloadableImage(file) ? file.preview.imageDataUrl!.length * 2 : 0), 0)
    if (!this.mountedOwners.has(projectId)) this.inactiveImageBytes += bytes - (this.imageBytes.get(projectId) ?? 0)
    this.imageBytes.set(projectId, bytes)
    this.snapshots.delete(projectId)
    this.snapshots.set(projectId, snapshot)
    this.trim()
  }

  acquire(projectId: string): () => void {
    if (!this.mountedOwners.has(projectId)) this.inactiveImageBytes -= this.imageBytes.get(projectId) ?? 0
    this.mountedOwners.set(projectId, (this.mountedOwners.get(projectId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const remaining = (this.mountedOwners.get(projectId) ?? 1) - 1
      if (remaining) this.mountedOwners.set(projectId, remaining)
      else {
        this.mountedOwners.delete(projectId)
        this.inactiveImageBytes += this.imageBytes.get(projectId) ?? 0
      }
      this.trim()
    }
  }

  private trim(): void {
    let bytes = this.inactiveImageBytes
    if (bytes <= this.maxInactiveImageBytes) return
    for (const [projectId, snapshot] of this.snapshots) {
      if (this.mountedOwners.has(projectId)) continue
      let changed = false
      let removed = 0
      const openFiles = snapshot.openFiles.map((file) => {
        if (bytes <= this.maxInactiveImageBytes || !reloadableImage(file)) return file
        bytes -= file.preview.imageDataUrl!.length * 2
        removed += file.preview.imageDataUrl!.length * 2
        changed = true
        return { ...file, preview: { ...file.preview, imageDataUrl: null }, previewEvicted: true }
      })
      if (changed) {
        this.snapshots.set(projectId, { ...snapshot, openFiles })
        this.imageBytes.set(projectId, (this.imageBytes.get(projectId) ?? 0) - removed)
      }
      if (bytes <= this.maxInactiveImageBytes) break
    }
    this.inactiveImageBytes = bytes
  }
}

/** Preserve tab choices, and never overwrite a draft that changed during an image read. */
export function restoreEvictedPreview(file: CachedFileTab, preview: FilePreview): CachedFileTab {
  if (!file.previewEvicted || file.preview.path !== preview.path || file.editing || file.draft !== file.preview.content) return file
  return { ...file, preview, draft: preview.content, previewEvicted: false }
}
