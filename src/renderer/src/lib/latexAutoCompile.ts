const STORAGE_KEY = 'panepilot.latex-auto-compile-by-project'

function readPreferences(
  storage: Pick<Storage, 'getItem'>
): Record<string, boolean> {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
      )
    )
  } catch {
    return {}
  }
}

export function loadLatexAutoCompile(
  projectId: string,
  storage: Pick<Storage, 'getItem'> = window.localStorage
): boolean {
  return readPreferences(storage)[projectId] ?? false
}

export function saveLatexAutoCompile(
  projectId: string,
  enabled: boolean,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage
): void {
  try {
    const preferences = readPreferences(storage)
    preferences[projectId] = enabled
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // A local preference failure must never block PDF viewing or compilation.
  }
}
