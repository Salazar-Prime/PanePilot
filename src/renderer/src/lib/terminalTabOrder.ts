import { useEffect, useMemo, useState } from 'react'
import type { TerminalSession } from '@shared/types'

export type TabDropEdge = 'before' | 'after'
export interface TerminalTabDropTarget {
  targetId: string
  edge: TabDropEdge
}

const STORAGE_KEY = 'panepilot.terminal-tab-order-by-project'
const CHANGE_EVENT = 'panepilot-terminal-tab-order-changed'

function storedOrders(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}'
    ) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([projectId, value]) =>
        Array.isArray(value)
          ? [
              [
                projectId,
                [...new Set(value.filter((id): id is string => typeof id === 'string'))]
              ] as [string, string[]]
            ]
          : []
      )
    )
  } catch {
    return {}
  }
}

export function orderTerminalTabs(
  sessions: TerminalSession[],
  storedIds: string[]
): TerminalSession[] {
  const storedIndex = new Map(storedIds.map((id, index) => [id, index]))
  const inputIndex = new Map(sessions.map((session, index) => [session.id, index]))
  const ordered = [...sessions].sort((left, right) => {
    const leftIndex = storedIndex.get(left.id)
    const rightIndex = storedIndex.get(right.id)
    if (leftIndex != null && rightIndex != null) return leftIndex - rightIndex
    if (leftIndex != null) return -1
    if (rightIndex != null) return 1
    return (inputIndex.get(left.id) ?? 0) - (inputIndex.get(right.id) ?? 0)
  })
  return [
    ...ordered.filter((session) => session.pinned),
    ...ordered.filter((session) => !session.pinned)
  ]
}

export function moveTerminalTab(
  orderedIds: string[],
  draggedId: string,
  targetId: string,
  edge: TabDropEdge,
  pinnedIds: Set<string>
): string[] {
  if (
    draggedId === targetId ||
    !orderedIds.includes(draggedId) ||
    !orderedIds.includes(targetId)
  ) {
    return orderedIds
  }
  const withoutDragged = orderedIds.filter((id) => id !== draggedId)
  const targetIndex = withoutDragged.indexOf(targetId)
  withoutDragged.splice(targetIndex + (edge === 'after' ? 1 : 0), 0, draggedId)
  return [
    ...withoutDragged.filter((id) => pinnedIds.has(id)),
    ...withoutDragged.filter((id) => !pinnedIds.has(id))
  ]
}

export function clampTerminalTabDrop(
  orderedIds: string[],
  draggedId: string,
  hoveredId: string,
  edge: TabDropEdge,
  pinnedIds: Set<string>
): TerminalTabDropTarget {
  if (pinnedIds.has(draggedId) === pinnedIds.has(hoveredId)) {
    return { targetId: hoveredId, edge }
  }
  if (pinnedIds.has(draggedId)) {
    const lastPinned = orderedIds
      .filter((id) => id !== draggedId && pinnedIds.has(id))
      .at(-1)
    return lastPinned
      ? { targetId: lastPinned, edge: 'after' }
      : { targetId: hoveredId, edge: 'before' }
  }
  const firstUnpinned = orderedIds.find(
    (id) => id !== draggedId && !pinnedIds.has(id)
  )
  return firstUnpinned
    ? { targetId: firstUnpinned, edge: 'before' }
    : { targetId: hoveredId, edge: 'after' }
}

export function useTerminalTabOrder(
  projectId: string,
  sessions: TerminalSession[]
): {
  orderedSessions: TerminalSession[]
  moveTab(draggedId: string, targetId: string, edge: TabDropEdge): void
} {
  const [orders, setOrders] = useState<Record<string, string[]>>(storedOrders)

  useEffect(() => {
    function sync() {
      setOrders(storedOrders())
    }
    window.addEventListener(CHANGE_EVENT, sync)
    return () => window.removeEventListener(CHANGE_EVENT, sync)
  }, [])

  const orderedSessions = useMemo(
    () => orderTerminalTabs(sessions, orders[projectId] ?? []),
    [orders, projectId, sessions]
  )

  function moveTab(draggedId: string, targetId: string, edge: TabDropEdge) {
    const nextOrder = moveTerminalTab(
      orderedSessions.map((session) => session.id),
      draggedId,
      targetId,
      edge,
      new Set(
        orderedSessions
          .filter((session) => session.pinned)
          .map((session) => session.id)
      )
    )
    const next = { ...storedOrders(), [projectId]: nextOrder }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }

  return { orderedSessions, moveTab }
}
