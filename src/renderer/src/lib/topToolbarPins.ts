export const TOP_TOOLBAR_ACTION_IDS = [
  'quick-notes',
  'app-updates',
  'quick-chats',
  'sub-agents',
  'google-drive',
  'overleaf',
  'project-settings',
  'new-project'
] as const

export type TopToolbarActionId = (typeof TOP_TOOLBAR_ACTION_IDS)[number]

const STORAGE_KEY = 'panepilot.top-toolbar-pins.v1'
const validIds = new Set<string>(TOP_TOOLBAR_ACTION_IDS)

export function loadTopToolbarPins(
  storage: Pick<Storage, 'getItem'> = window.localStorage
): TopToolbarActionId[] {
  try {
    const stored: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(stored)) return []
    return stored.filter((id, index): id is TopToolbarActionId =>
      typeof id === 'string' && validIds.has(id) && stored.indexOf(id) === index)
  } catch {
    return []
  }
}

export function saveTopToolbarPins(
  ids: TopToolbarActionId[],
  storage: Pick<Storage, 'setItem'> = window.localStorage
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // A local toolbar preference must not interrupt the workspace.
  }
}

export function toggleTopToolbarPin(
  ids: TopToolbarActionId[],
  id: TopToolbarActionId
): TopToolbarActionId[] {
  return ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]
}

export function moveTopToolbarPin(
  ids: TopToolbarActionId[],
  id: TopToolbarActionId,
  insertionIndex: number
): TopToolbarActionId[] {
  const currentIndex = ids.indexOf(id)
  if (currentIndex < 0) return ids
  const others = ids.filter((item) => item !== id)
  const nextIndex = Math.max(0, Math.min(others.length, Math.trunc(insertionIndex)))
  if (nextIndex === currentIndex) return ids
  return [...others.slice(0, nextIndex), id, ...others.slice(nextIndex)]
}
