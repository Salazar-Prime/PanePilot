import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { moveTopToolbarPin, type TopToolbarActionId } from '../lib/topToolbarPins'

export interface PinnedToolbarAction {
  id: TopToolbarActionId
  label: string
  icon: ReactNode
  available: boolean
  unavailableReason?: string
  run: () => void
}

interface DragState {
  id: TopToolbarActionId
  pointerId: number
  element: HTMLElement
  startX: number
  startLeft: number
  latestX: number
  started: boolean
}

const MOVE_THRESHOLD = 5
const MOVE_DURATION = 210
const MOVE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

export function PinnedToolbarActions({ ids, actions, onReorder }: {
  ids: TopToolbarActionId[]
  actions: PinnedToolbarAction[]
  onReorder: (ids: TopToolbarActionId[]) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const idsRef = useRef(ids)
  const onReorderRef = useRef(onReorder)
  const dragRef = useRef<DragState | null>(null)
  const beforeRef = useRef<Map<string, number> | null>(null)
  const animationsRef = useRef(new Map<HTMLElement, Animation>())
  const cleanupRef = useRef<(() => void) | null>(null)
  const suppressClickRef = useRef(false)
  idsRef.current = ids
  onReorderRef.current = onReorder

  function items(): HTMLElement[] {
    return Array.from(containerRef.current?.querySelectorAll<HTMLElement>('[data-pinned-action]') ?? [])
  }

  function cancelAnimations(): void {
    for (const animation of animationsRef.current.values()) animation.cancel()
    animationsRef.current.clear()
  }

  function capturePositions(): Map<string, number> {
    return new Map(items().map((item) => [item.dataset.pinnedAction!, item.getBoundingClientRect().left]))
  }

  function requestOrder(next: TopToolbarActionId[]): void {
    if (next === idsRef.current) return
    beforeRef.current = capturePositions()
    cancelAnimations()
    idsRef.current = next
    onReorderRef.current(next)
  }

  function positionDraggedItem(): void {
    const drag = dragRef.current
    const container = containerRef.current
    if (!drag?.started || !container) return
    const layoutLeft = container.getBoundingClientRect().left + drag.element.offsetLeft
    const pointerLeft = drag.startLeft + drag.latestX - drag.startX
    drag.element.style.transform = `translate3d(${pointerLeft - layoutLeft}px, 0, 0)`
  }

  useLayoutEffect(() => {
    const before = beforeRef.current
    beforeRef.current = null
    if (before && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const item of items()) {
        if (item.dataset.pinnedAction === dragRef.current?.id) continue
        const oldLeft = before.get(item.dataset.pinnedAction!)
        if (oldLeft == null) continue
        const delta = oldLeft - item.getBoundingClientRect().left
        if (Math.abs(delta) < 1 || typeof item.animate !== 'function') continue
        const animation = item.animate([
          { transform: `translateX(${delta}px)` },
          { transform: 'translateX(0)' }
        ], { duration: MOVE_DURATION, easing: MOVE_EASING })
        animationsRef.current.set(item, animation)
        animation.onfinish = () => animationsRef.current.delete(item)
      }
    }
    positionDraggedItem()
  }, [ids])

  useEffect(() => () => {
    cleanupRef.current?.()
    cancelAnimations()
    if (dragRef.current) dragRef.current.element.style.transform = ''
  }, [])

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>, id: TopToolbarActionId): void {
    if (event.button !== 0 || dragRef.current) return
    const element = event.currentTarget
    const state: DragState = {
      id, pointerId: event.pointerId, element,
      startX: event.clientX, startLeft: element.getBoundingClientRect().left,
      latestX: event.clientX, started: false
    }
    dragRef.current = state

    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== state.pointerId) return
      state.latestX = pointer.clientX
      if (!state.started && Math.abs(pointer.clientX - state.startX) < MOVE_THRESHOLD) return
      if (!state.started) {
        state.started = true
        cancelAnimations()
        element.classList.add('dragging')
        containerRef.current?.classList.add('is-dragging')
        try { element.setPointerCapture(state.pointerId) } catch { /* The window may have lost the pointer. */ }
      }
      pointer.preventDefault()
      positionDraggedItem()
      const container = containerRef.current
      if (!container) return
      const containerLeft = container.getBoundingClientRect().left
      const insertionIndex = items().filter((item) => item !== element &&
        pointer.clientX > containerLeft + item.offsetLeft + item.offsetWidth / 2).length
      requestOrder(moveTopToolbarPin(idsRef.current, id, insertionIndex))
    }

    const finish = (settle: boolean) => {
      cleanupRef.current?.()
      cleanupRef.current = null
      dragRef.current = null
      if (!state.started) return
      if (element.hasPointerCapture(state.pointerId)) element.releasePointerCapture(state.pointerId)
      suppressClickRef.current = true
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
      element.classList.remove('dragging')
      containerRef.current?.classList.remove('is-dragging')
      const from = element.style.transform
      element.style.transform = ''
      if (settle && from && !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
          typeof element.animate === 'function') {
        const animation = element.animate([
          { transform: from }, { transform: 'translateX(0)' }
        ], { duration: MOVE_DURATION, easing: MOVE_EASING })
        animationsRef.current.set(element, animation)
        animation.onfinish = () => animationsRef.current.delete(element)
      }
    }
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId === state.pointerId) finish(true)
    }
    const cancel = (pointer: PointerEvent) => {
      if (pointer.pointerId === state.pointerId) finish(false)
    }
    const blur = () => finish(false)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', blur)
    cleanupRef.current = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', blur)
    }
  }

  return <div className="top-pinned-actions" ref={containerRef} aria-label="Pinned toolbar actions"
    onClickCapture={(event) => {
      if (!suppressClickRef.current) return
      suppressClickRef.current = false
      event.preventDefault()
      event.stopPropagation()
    }}>
    {ids.map((id) => {
      const action = actions.find((candidate) => candidate.id === id)
      if (!action) return null
      return <div key={id} className="top-pinned-item" data-pinned-action={id}
        onPointerDown={(event) => onPointerDown(event, id)}>
        <button className="icon-button top-pinned-action"
          aria-label={action.label}
          title={`${action.available ? action.label : action.unavailableReason} · Drag to reorder`}
          disabled={!action.available}
          onClick={action.run}
          onKeyDown={(event) => {
            if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return
            event.preventDefault()
            const index = idsRef.current.indexOf(id)
            requestOrder(moveTopToolbarPin(idsRef.current, id,
              index + (event.key === 'ArrowLeft' ? -1 : 1)))
          }}>
          {action.icon}
        </button>
      </div>
    })}
  </div>
}
