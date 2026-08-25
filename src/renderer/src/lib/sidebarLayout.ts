export const DEFAULT_SIDEBAR_WIDTH = 264
export const COMPACT_SIDEBAR_WIDTH = 225
export const MIN_SIDEBAR_WIDTH = 210
export const MAX_SIDEBAR_WIDTH = 440

const STORAGE_KEY = 'panepilot.sidebar-width'

export function clampSidebarWidth(width: number): number {
  const normalized = Number.isFinite(width)
    ? Math.round(width)
    : DEFAULT_SIDEBAR_WIDTH
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, normalized))
}

export function loadSidebarWidth(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
  fallback = DEFAULT_SIDEBAR_WIDTH
): number {
  try {
    const stored = storage.getItem(STORAGE_KEY)
    return clampSidebarWidth(stored == null ? fallback : Number(stored))
  } catch {
    return clampSidebarWidth(fallback)
  }
}

export function saveSidebarWidth(
  width: number,
  storage: Pick<Storage, 'setItem'> = window.localStorage
): void {
  try {
    storage.setItem(STORAGE_KEY, String(clampSidebarWidth(width)))
  } catch {
    // A layout preference must never block the project workspace.
  }
}
