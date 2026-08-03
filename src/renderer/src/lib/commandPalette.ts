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
