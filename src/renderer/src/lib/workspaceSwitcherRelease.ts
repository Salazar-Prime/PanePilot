export const WORKSPACE_SWITCHER_RELEASE_DELAY_MS = 120

type Modifier = 'Meta' | 'Control'
type ReleaseEvent = Pick<KeyboardEvent,
  'type' | 'key' | 'metaKey' | 'ctrlKey' | 'repeat' | 'isTrusted'>

/** Confirms a modifier release; never times out a held navigation gesture. */
export class WorkspaceSwitcherReleaseGuard {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly canCommit: () => boolean) {}

  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  observe(event: ReleaseEvent, modifier: Modifier | null, release?: () => void): void {
    if (!event.isTrusted) return
    if (!modifier) {
      this.reset()
      return
    }
    const held = modifier === 'Meta' ? event.metaKey : event.ctrlKey
    // A second Command key, a flags-change event, or a quick re-press must
    // not commit the currently highlighted destination.
    if (held || (event.type === 'keydown' && event.key === modifier)) {
      this.reset()
      return
    }
    if (event.type !== 'keyup' || event.key !== modifier || event.repeat || !release) return
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.canCommit()) release()
    }, WORKSPACE_SWITCHER_RELEASE_DELAY_MS)
  }
}
