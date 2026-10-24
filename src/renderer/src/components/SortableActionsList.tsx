import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { GripVertical, Play } from 'lucide-react'
import type { ProjectAction, TerminalSession } from '@shared/types'
import { StatusDot } from './StatusDot'
import {
  ACTION_ORDER_CHANGED, ACTION_ORDER_PREFIX, loadActionOrder, moveAction,
  orderProjectActions, saveActionOrder, validActionOrder
} from '../lib/actionOrder'

interface Props {
  projectId: string
  actions: ProjectAction[]
  sessions: TerminalSession[]
  selectedId: string | null
  onSelect(id: string): void
}

interface Drag {
  id: string
  pointerId: number
  element: HTMLButtonElement
  startY: number
  startTop: number
  latestY: number
  latestX: number
  started: boolean
  originalIds: string[]
}

const DURATION = 210
const EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'

/** Keyed by project in ActionsPanel; never owns selection or an action's backend. */
export function SortableActionsList({ projectId, actions, sessions, selectedId, onSelect }: Props) {
  const [savedOrder, setSavedOrder] = useState(() => loadActionOrder(projectId))
  const [draftOrder, setDraftOrder] = useState<string[] | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const ordered = orderProjectActions(actions, draftOrder ?? savedOrder)
  const ids = ordered.map((action) => action.id)
  const membership = JSON.stringify([...ids].sort())
  const containerRef = useRef<HTMLDivElement>(null)
  const idsRef = useRef(ids)
  const actionsRef = useRef(actions)
  const dragRef = useRef<Drag | null>(null)
  const beforeRef = useRef<Map<string, number> | null>(null)
  const animationsRef = useRef(new Map<HTMLElement, Animation>())
  const cleanupRef = useRef<(() => void) | null>(null)
  const finishRef = useRef<((commit: boolean) => void) | null>(null)
  const focusAfterRef = useRef<string | null>(null)
  const suppressClickRef = useRef(false)
  idsRef.current = ids
  actionsRef.current = actions

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const items = () => Array.from(containerRef.current?.querySelectorAll<HTMLButtonElement>('[data-action-id]') ?? [])
  const capturePositions = () => new Map(items().map((item) => [item.dataset.actionId!, item.getBoundingClientRect().top]))

  function cancelAnimations() {
    for (const animation of animationsRef.current.values()) animation.cancel()
    animationsRef.current.clear()
  }

  function prepareLayout() {
    beforeRef.current = capturePositions()
    cancelAnimations()
  }

  function positionDraggedItem() {
    const drag = dragRef.current
    const container = containerRef.current
    if (!drag?.started || !container) return
    const layoutTop = container.getBoundingClientRect().top - container.scrollTop + drag.element.offsetTop
    const pointerTop = drag.startTop + drag.latestY - drag.startY
    drag.element.style.transform = `translate3d(0, ${pointerTop - layoutTop}px, 0)`
  }

  useLayoutEffect(() => {
    const before = beforeRef.current
    beforeRef.current = null
    if (before && !reducedMotion()) {
      for (const item of items()) {
        if (item.dataset.actionId === dragRef.current?.id) continue
        const oldTop = before.get(item.dataset.actionId!)
        if (oldTop == null) continue
        const delta = oldTop - item.getBoundingClientRect().top
        if (Math.abs(delta) < 1) continue
        const animation = item.animate([
          { transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }
        ], { duration: DURATION, easing: EASING })
        animationsRef.current.set(item, animation)
        animation.onfinish = () => {
          if (animationsRef.current.get(item) === animation) animationsRef.current.delete(item)
        }
      }
    }
    positionDraggedItem()
    if (focusAfterRef.current) {
      const focused = items().find((item) => item.dataset.actionId === focusAfterRef.current)
      focusAfterRef.current = null
      focused?.focus({ preventScroll: true })
      focused?.scrollIntoView({ block: 'nearest' })
    }
  }, [JSON.stringify(ids), draftOrder])

  // Status refreshes are harmless. Definition additions/removals invalidate the drag.
  useLayoutEffect(() => { finishRef.current?.(false) }, [membership])

  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; ids: string[] }>).detail
      if (detail?.projectId !== projectId) return
      finishRef.current?.(false)
      setSavedOrder(validActionOrder(detail.ids))
    }
    const storage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== ACTION_ORDER_PREFIX + projectId) return
      finishRef.current?.(false)
      setSavedOrder(loadActionOrder(projectId))
    }
    window.addEventListener(ACTION_ORDER_CHANGED, changed)
    window.addEventListener('storage', storage)
    return () => {
      window.removeEventListener(ACTION_ORDER_CHANGED, changed)
      window.removeEventListener('storage', storage)
      cleanupRef.current?.()
      if (dragRef.current) clearDrag(dragRef.current)
      dragRef.current = null
      finishRef.current = null
      cancelAnimations()
    }
  }, [projectId])

  function persist(next: string[], movedId: string) {
    saveActionOrder(projectId, next)
    setSavedOrder(next)
    window.dispatchEvent(new CustomEvent(ACTION_ORDER_CHANGED, { detail: { projectId, ids: next } }))
    const name = actionsRef.current.find((action) => action.id === movedId)?.name ?? 'Action'
    setAnnouncement(`Moved ${name} to position ${next.indexOf(movedId) + 1} of ${next.length}.`)
  }

  function clearDrag(drag: Drag) {
    drag.element.classList.remove('dragging')
    drag.element.style.transform = ''
    containerRef.current?.classList.remove('is-dragging')
    if (drag.element.hasPointerCapture(drag.pointerId)) drag.element.releasePointerCapture(drag.pointerId)
  }

  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0 || !event.isPrimary || dragRef.current) return
    suppressClickRef.current = false
    const element = event.currentTarget
    const state: Drag = {
      id, element, pointerId: event.pointerId,
      startY: event.clientY, startTop: element.getBoundingClientRect().top,
      latestY: event.clientY, latestX: event.clientX, started: false,
      originalIds: idsRef.current
    }
    dragRef.current = state
    let frame = 0
    let lastFrame = 0

    const update = () => {
      const container = containerRef.current
      if (!container) return
      positionDraggedItem()
      const rect = container.getBoundingClientRect()
      // Use layout centers, not the moving neighbors' animated visual bounds.
      const center = state.startTop + state.latestY - state.startY + element.offsetHeight / 2
      const insertion = items().filter((item) => item !== element &&
        center > rect.top - container.scrollTop + item.offsetTop + item.offsetHeight / 2).length
      const next = moveAction(idsRef.current, id, insertion)
      if (next === idsRef.current) return
      prepareLayout()
      idsRef.current = next
      setDraftOrder(next)
    }

    const autoScroll = (time: number) => {
      const container = containerRef.current
      if (!container || dragRef.current !== state) return
      const rect = container.getBoundingClientRect()
      const elapsed = Math.min(32, lastFrame ? time - lastFrame : 16)
      lastFrame = time
      if (state.latestX >= rect.left - 24 && state.latestX <= rect.right + 24) {
        const edge = Math.min(36, rect.height / 3)
        const velocity = state.latestY < rect.top + edge
          ? -Math.min(1, (rect.top + edge - state.latestY) / edge)
          : state.latestY > rect.bottom - edge
            ? Math.min(1, (state.latestY - rect.bottom + edge) / edge) : 0
        const previous = container.scrollTop
        container.scrollTop += velocity * elapsed * 0.6
        if (container.scrollTop !== previous) update()
      }
      frame = requestAnimationFrame(autoScroll)
    }

    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== state.pointerId) return
      state.latestY = pointer.clientY
      state.latestX = pointer.clientX
      if (!state.started && Math.abs(state.latestY - state.startY) < 5) return
      if (!state.started) {
        state.started = true
        suppressClickRef.current = true
        prepareLayout()
        setDraftOrder(idsRef.current)
        element.classList.add('dragging')
        containerRef.current?.classList.add('is-dragging')
        try { element.setPointerCapture(state.pointerId) } catch { /* Lost pointer is canceled below. */ }
        frame = requestAnimationFrame(autoScroll)
      }
      pointer.preventDefault()
      update()
    }

    const finish = (commit: boolean) => {
      cleanupRef.current?.()
      cleanupRef.current = null
      finishRef.current = null
      if (state.started) prepareLayout()
      dragRef.current = null
      clearDrag(state)
      if (!state.started) return
      if (commit && idsRef.current.some((value, index) => value !== state.originalIds[index])) {
        persist(orderProjectActions(actionsRef.current, idsRef.current).map((action) => action.id), id)
      }
      setDraftOrder(null)
    }
    finishRef.current = finish
    const up = (pointer: PointerEvent) => {
      if (pointer.pointerId !== state.pointerId) return
      const rect = containerRef.current?.getBoundingClientRect()
      finish(!!rect && pointer.clientX >= rect.left && pointer.clientX <= rect.right &&
        pointer.clientY >= rect.top && pointer.clientY <= rect.bottom)
    }
    const cancel = (pointer: PointerEvent) => { if (pointer.pointerId === state.pointerId) finish(false) }
    const blur = () => finish(false)
    const visibility = () => { if (document.hidden) finish(false) }
    const key = (keyboard: KeyboardEvent) => {
      if (keyboard.key !== 'Escape' || !state.started) return
      keyboard.preventDefault()
      keyboard.stopImmediatePropagation()
      finish(false)
    }
    const scroll = () => { if (state.started) update() }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', blur)
    window.addEventListener('keydown', key, true)
    document.addEventListener('visibilitychange', visibility)
    element.addEventListener('lostpointercapture', cancel)
    containerRef.current?.addEventListener('scroll', scroll)
    const container = containerRef.current
    cleanupRef.current = () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', blur)
      window.removeEventListener('keydown', key, true)
      document.removeEventListener('visibilitychange', visibility)
      element.removeEventListener('lostpointercapture', cancel)
      container?.removeEventListener('scroll', scroll)
    }
  }

  return <>
    <div className="actions-list-scroll" ref={containerRef} aria-label="Project actions"
      onClickCapture={(event) => {
        if (!suppressClickRef.current || event.detail === 0) return
        suppressClickRef.current = false
        event.preventDefault()
        event.stopPropagation()
      }}>
      {ordered.map((action) => {
        const session = sessions.find((candidate) => candidate.id === action.lastSessionId)
        return <button key={action.id} type="button" data-action-id={action.id}
          className={selectedId === action.id ? 'active' : ''}
          title={`${action.name} · Drag to reorder · Option/Alt + ↑/↓ to move`}
          aria-pressed={selectedId === action.id}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          onPointerDown={(event) => onPointerDown(event, action.id)}
          onClick={() => onSelect(action.id)}
          onKeyDown={(event) => {
            if (!event.altKey || event.metaKey || event.ctrlKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
            event.preventDefault()
            event.stopPropagation()
            if (dragRef.current) return
            const index = idsRef.current.indexOf(action.id)
            const next = moveAction(idsRef.current, action.id, index + (event.key === 'ArrowUp' ? -1 : 1))
            if (next === idsRef.current) return
            prepareLayout()
            idsRef.current = next
            focusAfterRef.current = action.id
            persist(next, action.id)
          }}>
          <i className="action-sort-icon" aria-hidden="true"><Play size={13} /><GripVertical size={14} /></i>
          <span><strong>{action.name}</strong><small>{action.command}</small></span>
          {session && <StatusDot state={session.state} compact />}
        </button>
      })}
      {actions.length === 0 && <div className="actions-list-empty">
        <Play size={22} /><span>No actions yet</span>
        <small>Save a shell command to run it on demand.</small>
      </div>}
    </div>
    <span className="action-order-announcement" role="status" aria-live="polite">{announcement}</span>
  </>
}
