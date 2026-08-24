export interface LatexChatLayout {
  hidden: boolean
  width: number
}

export const DEFAULT_LATEX_CHAT_WIDTH = 352
export const MIN_LATEX_CHAT_WIDTH = 280
export const MAX_LATEX_CHAT_WIDTH = 640

const STORAGE_KEY = 'panepilot.latex-chat-layout-by-project'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function clampLatexChatWidth(
  width: number,
  workspaceWidth?: number
): number {
  const availableMaximum =
    workspaceWidth == null
      ? MAX_LATEX_CHAT_WIDTH
      : Math.max(
          MIN_LATEX_CHAT_WIDTH,
          Math.min(MAX_LATEX_CHAT_WIDTH, Math.round(workspaceWidth * 0.58))
        )
  const normalized = Number.isFinite(width)
    ? Math.round(width)
    : DEFAULT_LATEX_CHAT_WIDTH
  return Math.min(
    availableMaximum,
    Math.max(MIN_LATEX_CHAT_WIDTH, normalized)
  )
}

function parseLayouts(raw: string | null): Record<string, LatexChatLayout> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([projectId, value]) => {
        if (!isRecord(value)) return []
        return [
          [
            projectId,
            {
              hidden: value.hidden === true,
              width: clampLatexChatWidth(
                typeof value.width === 'number'
                  ? value.width
                  : DEFAULT_LATEX_CHAT_WIDTH
              )
            }
          ] as const
        ]
      })
    )
  } catch {
    return {}
  }
}

export function loadLatexChatLayout(
  projectId: string,
  storage: Pick<Storage, 'getItem'> = window.localStorage
): LatexChatLayout {
  try {
    return (
      parseLayouts(storage.getItem(STORAGE_KEY))[projectId] ?? {
        hidden: false,
        width: DEFAULT_LATEX_CHAT_WIDTH
      }
    )
  } catch {
    return { hidden: false, width: DEFAULT_LATEX_CHAT_WIDTH }
  }
}

export function saveLatexChatLayout(
  projectId: string,
  layout: LatexChatLayout,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage
): void {
  try {
    const layouts = parseLayouts(storage.getItem(STORAGE_KEY))
    layouts[projectId] = {
      hidden: layout.hidden,
      width: clampLatexChatWidth(layout.width)
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(layouts))
  } catch {
    // Layout preferences must never block the writing workspace.
  }
}
