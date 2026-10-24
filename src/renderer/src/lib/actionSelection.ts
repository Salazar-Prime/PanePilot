const PREFIX = 'panepilot.action-selection.v1:'
type SelectionStorage = Pick<Storage, 'getItem' | 'setItem'>

export function loadActionSelection(projectId: string, storage?: SelectionStorage): string | null {
  try { return (storage ?? window.localStorage).getItem(PREFIX + projectId) || null }
  catch { return null }
}

export function saveActionSelection(projectId: string, actionId: string, storage?: SelectionStorage): void {
  try { (storage ?? window.localStorage).setItem(PREFIX + projectId, actionId) }
  catch { /* Selection still works when local preference storage is unavailable. */ }
}

export function resolveActionSelection(actions: { id: string }[], preferred: string | null): string | null {
  return actions.find((action) => action.id === preferred)?.id ?? actions[0]?.id ?? null
}
