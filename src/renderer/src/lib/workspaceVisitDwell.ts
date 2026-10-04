import type { WorkspaceDestination } from './workspaceHistory'

export const WORKSPACE_HISTORY_DWELL_MS = 5_000

/** One continuous focused visit qualifies once; short visits never alter history. */
export class WorkspaceVisitDwell {
  private destination: WorkspaceDestination | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private record: (destination: WorkspaceDestination) => void) {}

  visit(destination: WorkspaceDestination | null): void {
    if (destination && destination.key === this.destination?.key) {
      // Status/name updates must not restart the five-second clock or promote
      // a destination again after this visit has already qualified.
      this.destination = destination
      return
    }
    this.reset()
    this.destination = destination
    if (!destination) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.destination) this.record({ ...this.destination, visitedAt: Date.now() })
    }, WORKSPACE_HISTORY_DWELL_MS)
  }

  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.destination = null
  }
}
