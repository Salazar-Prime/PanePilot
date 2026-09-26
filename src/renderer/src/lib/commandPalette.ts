import type { Project, TerminalSession } from '@shared/types'
import type { WorkspaceDestination } from './workspaceHistory'

/** Resolve only the visible destination, not a terminal remembered behind Files/Notes. */
export function commandPaletteSession(
  project: Project | null,
  destination: Pick<WorkspaceDestination, 'projectId' | 'sessionId'> | null,
  fallback: TerminalSession | null
): TerminalSession | null {
  if (!project || project.archived) return null
  const id = destination?.projectId === project.id ? destination.sessionId : fallback?.id
  return project.sessions.find((session) => session.id === id && !session.archived &&
    (session.kind === 'terminal' ||
      (session.kind === 'latex-chat' && session.latexChat?.purpose === 'writing'))) ?? null
}

interface MenuCommand {
  id: string
  label: string
  disabled?: boolean
  action(): void | Promise<void>
}

/** Preserve the menu's handlers, availability checks, and confirmation paths. */
export function contextualCommands<T extends MenuCommand>(
  items: T[],
  context: { id: string; section: string; detail: string; project?: boolean }
) {
  return items.filter((item) => !item.disabled).map((item) => ({
    ...item,
    id: `${context.id}:${item.id}`,
    label: context.project && item.id === 'rename' ? 'Rename project' : item.label,
    section: context.section,
    detail: context.detail,
    keywords: item.id === 'force-reload-agent' ? ['restart', 'reload', 'reconnect'] : []
  }))
}

export async function runPaletteCommand(
  command: Pick<MenuCommand, 'action'>,
  onError: (error: unknown) => void
): Promise<void> {
  try {
    await command.action()
  } catch (error) {
    onError(error)
  }
}

export interface SearchableCommand {
  id: string
  label: string
  detail?: string
  keywords?: string[]
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

export function filterCommands<T extends SearchableCommand>(
  commands: T[],
  rawQuery: string
): T[] {
  const query = normalized(rawQuery)
  if (!query) return commands
  const terms = query.split(' ')
  return commands
    .flatMap((command) => {
      const label = normalized(command.label)
      const detail = normalized(command.detail ?? '')
      const keywords = normalized(command.keywords?.join(' ') ?? '')
      const haystack = `${label} ${detail} ${keywords}`
      if (!terms.every((term) => haystack.includes(term))) return []
      let score = 0
      if (label === query) score += 100
      if (label.startsWith(query)) score += 50
      if (label.includes(query)) score += 25
      for (const term of terms) {
        if (label.split(' ').some((word) => word.startsWith(term))) score += 8
        else if (detail.includes(term)) score += 3
        else score += 1
      }
      return [{ command, score }]
    })
    .sort((left, right) => right.score - left.score)
    .map(({ command }) => command)
}
