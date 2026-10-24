export const ACTION_ORDER_PREFIX = 'panepilot.action-order.v1:'
export const ACTION_ORDER_CHANGED = 'panepilot-action-order-changed'

type OrderStorage = Pick<Storage, 'getItem' | 'setItem'>

export function validActionOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))]
}

export function loadActionOrder(projectId: string, storage?: OrderStorage): string[] {
  try {
    return validActionOrder(JSON.parse((storage ?? window.localStorage).getItem(ACTION_ORDER_PREFIX + projectId) ?? 'null'))
  } catch { return [] }
}

export function saveActionOrder(projectId: string, ids: string[], storage?: OrderStorage): void {
  try {
    (storage ?? window.localStorage).setItem(ACTION_ORDER_PREFIX + projectId, JSON.stringify(validActionOrder(ids)))
  } catch { /* Keep this renderer's order usable if preference storage is unavailable. */ }
}

/** Definitions stay shared and untouched; only their client-local presentation changes. */
export function orderProjectActions<T extends { id: string }>(actions: T[], ids: string[]): T[] {
  const byId = new Map(actions.map((action) => [action.id, action]))
  const ordered: T[] = []
  for (const id of ids) {
    const action = byId.get(id)
    if (!action) continue
    ordered.push(action)
    byId.delete(id)
  }
  return [...ordered, ...byId.values()]
}

/** insertionIndex is measured in the list with the moving item removed. */
export function moveAction(ids: string[], id: string, insertionIndex: number): string[] {
  if (!ids.includes(id) || !Number.isFinite(insertionIndex)) return ids
  const next = ids.filter((candidate) => candidate !== id)
  next.splice(Math.max(0, Math.min(next.length, Math.trunc(insertionIndex))), 0, id)
  return next.every((candidate, index) => candidate === ids[index]) ? ids : next
}
