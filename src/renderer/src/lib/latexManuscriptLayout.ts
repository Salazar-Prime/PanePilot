export interface LatexManuscriptLayout {
  mapHidden: boolean
  commentsHidden: boolean
  autoSave: boolean
}

const STORAGE_KEY = 'panepilot.latex-manuscript-layout-by-project'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseLayouts(raw: string | null): Record<string, LatexManuscriptLayout> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([projectId, value]) =>
        isRecord(value)
          ? [[projectId, {
              mapHidden: value.mapHidden === true,
              commentsHidden: value.commentsHidden !== false,
              autoSave: value.autoSave !== false
            }] as const]
          : []
      )
    )
  } catch {
    return {}
  }
}

export function loadLatexManuscriptLayout(
  projectId: string,
  storage: Pick<Storage, 'getItem'> = window.localStorage
): LatexManuscriptLayout {
  try {
    return parseLayouts(storage.getItem(STORAGE_KEY))[projectId] ?? {
      mapHidden: false,
      commentsHidden: true,
      autoSave: true
    }
  } catch {
    return { mapHidden: false, commentsHidden: true, autoSave: true }
  }
}

export function saveLatexManuscriptLayout(
  projectId: string,
  layout: LatexManuscriptLayout,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage
): void {
  try {
    const layouts = parseLayouts(storage.getItem(STORAGE_KEY))
    layouts[projectId] = layout
    storage.setItem(STORAGE_KEY, JSON.stringify(layouts))
  } catch {
    // Layout preferences must never block the source editor.
  }
}
