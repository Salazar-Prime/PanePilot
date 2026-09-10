import { useLayoutEffect, useRef, type RefObject } from 'react'
import type { WorkspaceDestination, WorkspaceSwitcherMode } from './workspaceHistory'

interface RowSnapshot {
  bounds: DOMRect
  glyph: DOMRect | null
  name: DOMRect | null
  node: HTMLElement
}

interface ViewSnapshot {
  view: string
  rows: Map<string, RowSnapshot>
  selectedKey: string | null
  headingGlyph: DOMRect | null
  headingName: DOMRect | null
}

export function useWorkspaceSwitcherMotion(input: {
  overlayRef: RefObject<HTMLDivElement>
  listRef: RefObject<HTMLDivElement>
  contextRef: RefObject<HTMLDivElement>
  motionRef: RefObject<HTMLDivElement>
  mode: WorkspaceSwitcherMode
  projectId?: string
  destinations: WorkspaceDestination[]
  selectedIndex: number
  removingKey: string | null
}): void {
  const previousRef = useRef<ViewSnapshot | null>(null)
  const { overlayRef, listRef, contextRef, motionRef, mode, projectId,
    destinations, selectedIndex, removingKey } = input

  useLayoutEffect(() => {
    const list = listRef.current
    const overlay = overlayRef.current
    const layer = motionRef.current
    if (!list || !overlay || !layer) return
    const selected = list.querySelector<HTMLElement>('[aria-selected="true"]')
    const viewport = list.getBoundingClientRect()
    if (selected) {
      const bounds = selected.getBoundingClientRect()
      if (bounds.top < viewport.top) list.scrollTop += bounds.top - viewport.top
      else if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom
    }

    const previous = previousRef.current
    const view = `${mode}:${projectId ?? ''}`
    const rows = new Map<string, RowSnapshot>()
    const elements = new Map<string, HTMLElement>()
    for (const row of list.querySelectorAll<HTMLElement>('[data-workspace-option-index]')) {
      const destination = destinations[Number(row.dataset.workspaceOptionIndex)]
      if (!destination) continue
      const bounds = row.getBoundingClientRect()
      if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) continue
      const node = row.cloneNode(true) as HTMLElement
      const computed = getComputedStyle(row)
      // Ghosts retain their old row layout when the live view becomes a word list.
      Object.assign(node.style, {
        width: `${bounds.width}px`, height: `${bounds.height}px`,
        gridTemplateColumns: computed.gridTemplateColumns,
        padding: computed.padding, gap: computed.gap,
        fontSize: computed.fontSize, color: computed.color
      })
      node.classList.remove('is-removing')
      rows.set(destination.key, {
        bounds,
        glyph: row.querySelector('.workspace-switcher-project-glyph')?.getBoundingClientRect() ?? null,
        name: row.querySelector('.workspace-switcher-copy small')?.getBoundingClientRect() ?? null,
        node
      })
      elements.set(destination.key, row)
    }
    const headingGlyph = contextRef.current?.querySelector<HTMLElement>('.workspace-switcher-project-glyph')
    const headingName = contextRef.current?.querySelector<HTMLElement>('strong')
    previousRef.current = {
      view, rows, selectedKey: destinations[selectedIndex]?.key ?? null,
      headingGlyph: headingGlyph?.getBoundingClientRect() ?? null,
      headingName: headingName?.getBoundingClientRect() ?? null
    }
    if (!previous || previous.view === view || removingKey ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    const animations: Animation[] = []
    const easing = 'cubic-bezier(0.22, 1, 0.36, 1)'
    const animate = (element: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions = {}) => {
      animations.push(element.animate(frames, { duration: 340, easing, fill: 'backwards', ...options }))
    }
    const overlayBounds = overlay.getBoundingClientRect()
    const source = previous.selectedKey ? previous.rows.get(previous.selectedKey) : null
    const origin = previous.headingGlyph ?? source?.glyph ?? source?.bounds

    // Each exact terminal gets its own moving copy, even when several rows
    // belong to the same project. Copies travel outside the list's scroll clip.
    for (const [key, oldRow] of previous.rows) {
      const target = rows.get(key)
      const ghost = oldRow.node
      ghost.classList.add('workspace-switcher-motion-row')
      ghost.setAttribute('aria-hidden', 'true')
      ghost.removeAttribute('role')
      ghost.inert = true
      Object.assign(ghost.style, {
        position: 'absolute', margin: '0',
        left: `${oldRow.bounds.left - overlayBounds.left}px`,
        top: `${oldRow.bounds.top - overlayBounds.top}px`,
        transformOrigin: '0 0'
      })
      layer.appendChild(ghost)
      if (target) {
        const x = target.bounds.left - oldRow.bounds.left
        const y = target.bounds.top - oldRow.bounds.top
        const transform = `translate(${x}px, ${y}px) scale(${target.bounds.width / oldRow.bounds.width}, ${target.bounds.height / oldRow.bounds.height})`
        animate(ghost, [
          { transform: 'none', opacity: 1 },
          { transform, opacity: 1, offset: 0.85 },
          { transform, opacity: 0 }
        ], { fill: 'forwards' })
        animate(elements.get(key)!, [{ opacity: 0 }, { opacity: 1 }], { delay: 285, duration: 55 })
      } else {
        animate(ghost, [
          { transform: 'none', opacity: 1 },
          { transform: 'translate(-16px, 0) scale(0.97)', opacity: 0 }
        ], { duration: 170, fill: 'forwards' })
      }
    }

    // The selected project's icon and label travel to the shared top heading.
    for (const [element, oldBounds] of [
      [headingGlyph, previous.headingGlyph ?? source?.glyph],
      [headingName, previous.headingName ?? source?.name]
    ] as const) {
      if (!element || !oldBounds) continue
      const bounds = element.getBoundingClientRect()
      animate(element, [
        { transform: `translate(${oldBounds.left - bounds.left}px, ${oldBounds.top - bounds.top}px)`, opacity: 0.8 },
        { transform: 'none', opacity: 1 }
      ])
    }
    let index = 0
    for (const [key, element] of elements) {
      if (previous.rows.has(key)) continue
      const bounds = rows.get(key)!.bounds
      const x = origin ? origin.left - bounds.left : -12
      const y = origin ? origin.top - bounds.top : -12
      animate(element, [
        { transform: `translate(${x}px, ${y}px) scale(0.92, 0.65)`, transformOrigin: '0 0', opacity: 0 },
        { transform: 'none', transformOrigin: '0 0', opacity: 1 }
      ], { delay: 70 + Math.min(index++, 7) * 18 })
    }
    return () => {
      for (const animation of animations) animation.cancel()
      layer.replaceChildren()
    }
  }, [mode, projectId, destinations, selectedIndex, removingKey,
    overlayRef, listRef, contextRef, motionRef])
}
