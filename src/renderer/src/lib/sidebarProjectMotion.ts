interface ProjectPosition {
  id: string
  element: HTMLElement
  top: number
  height: number
  width: number
  translation: number
}

export function sidebarProjectTranslation(element: HTMLElement | null): number {
  if (!element) return 0
  const transform = getComputedStyle(element).transform
  return transform === 'none' || !transform ? 0 : new DOMMatrixReadOnly(transform).m42
}

function reordered(before: ProjectPosition[], after: ProjectPosition[]): boolean {
  const oldIds = new Set(before.map((row) => row.id))
  const newIds = new Set(after.map((row) => row.id))
  const commonBefore = before.filter((row) => newIds.has(row.id))
  const commonAfter = after.filter((row) => oldIds.has(row.id))
  return commonBefore.some((row, index) => row.id !== commonAfter[index]?.id)
}

/** FLIP motion on the real project subtrees: no clones, remounts or sorting changes. */
export class SidebarProjectMotion {
  private previous = new Map<string, ProjectPosition[]>()
  private animations = new Map<HTMLElement, Animation>()

  constructor(private translation = sidebarProjectTranslation) {}

  update(container: HTMLElement, enabled: boolean): void {
    if (!enabled || !container.getClientRects().length) {
      this.reset()
      return
    }
    const viewport = container.getBoundingClientRect()
    // Read every layout before starting/cancelling animations. offsetTop is
    // relative to its connection, unaffected by scrolling or our transforms.
    const groups = Array.from(container.querySelectorAll<HTMLElement>('[data-sidebar-connection-id]')).map((group) => ({
      id: group.dataset.sidebarConnectionId!,
      top: group.getBoundingClientRect().top,
      rows: Array.from(group.querySelectorAll<HTMLElement>('[data-sidebar-project-id]')).map((element) => ({
        id: element.dataset.sidebarProjectId!, element,
        top: element.offsetTop, height: element.offsetHeight, width: element.offsetWidth,
        translation: this.animations.has(element) ? this.translation(element) : 0
      }))
    }))
    const live = new Set(groups.flatMap((group) => group.rows.map((row) => row.element)))
    for (const element of this.animations.keys()) {
      if (!live.has(element)) this.cancel(element)
    }
    const next = new Map<string, ProjectPosition[]>()
    for (const group of groups) {
      const before = this.previous.get(group.id)
      next.set(group.id, group.rows)
      if (!before) continue // No animation on initial load or expanding the sidebar.
      const changedOrder = reordered(before, group.rows)
      const oldRows = new Map(before.map((row) => [row.id, row]))
      const changedLayout = before.length !== group.rows.length || group.rows.some((row) => {
        const old = oldRows.get(row.id)
        return !old || old.element !== row.element || old.top !== row.top || old.height !== row.height || old.width !== row.width
      })
      if (!changedOrder && !changedLayout) continue // Status updates do not restart motion.
      // Selecting a previously collapsed project can expand its terminals in
      // the next commit. Keep the sort moving through that height change.
      const continuing = group.rows.some((row) => this.animations.has(row.element)) &&
        group.rows.every((row) => !oldRows.has(row.id) || oldRows.get(row.id)!.width === row.width)
      for (const row of group.rows) this.cancel(row.element)
      if (!changedOrder && !continuing) continue // Ordinary resize/collapse is not sorting.

      for (const row of group.rows) {
        const old = oldRows.get(row.id)
        if (!old || old.element !== row.element) continue
        const delta = old.top + row.translation - row.top
        if (Math.abs(delta) < 1 || typeof row.element.animate !== 'function') continue
        const from = group.top + row.top + delta
        const to = group.top + row.top
        if (Math.max(from, to) + row.height < viewport.top || Math.min(from, to) > viewport.bottom) continue
        const element = row.element
        element.classList.add('sidebar-project-moving')
        if (delta > 0) element.classList.add('sidebar-project-promoted')
        const animation = element.animate([
          { transform: `translateY(${delta}px)` },
          { transform: 'translateY(0)' }
        ], { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
        this.animations.set(element, animation)
        animation.onfinish = () => {
          if (this.animations.get(element) === animation) this.cancel(element)
        }
      }
    }
    this.previous = next
  }

  private cancel(element: HTMLElement): void {
    const animation = this.animations.get(element)
    if (animation) {
      animation.onfinish = null
      animation.cancel()
      this.animations.delete(element)
    }
    element.classList.remove('sidebar-project-moving', 'sidebar-project-promoted')
  }

  reset(): void {
    for (const element of this.animations.keys()) this.cancel(element)
    this.previous.clear()
  }
}
