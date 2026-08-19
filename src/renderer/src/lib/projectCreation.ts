export type ProjectFolderMode = 'existing' | 'new'

export function suggestedProjectName(
  mode: ProjectFolderMode,
  folder: string,
  newFolderName: string
): string {
  if (mode === 'new') return newFolderName.trim()
  const normalized = folder.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  return normalized.split('/').at(-1) ?? ''
}

export function newProjectFolderDestination(
  parentFolder: string,
  newFolderName: string
): string {
  const rawParent = parentFolder.trim()
  const name = newFolderName.trim()
  if (!rawParent || !name) return ''
  if (/^\/+$/u.test(rawParent)) return `/${name}`
  if (/^[A-Za-z]:[\\/]*$/u.test(rawParent)) {
    return `${rawParent.slice(0, 2)}\\${name}`
  }
  const parent = rawParent.replace(/[\\/]+$/, '')
  const separator = parent.includes('\\') && !parent.includes('/') ? '\\' : '/'
  return `${parent}${separator}${name}`
}

function normalizedRemotePath(path: string): string {
  const trimmed = path.trim()
  return trimmed === '/' ? '/' : trimmed.replace(/\/+$/u, '')
}

export function remoteFolderInputValue(
  currentPath: string,
  previousValue: string,
  nextValue: string
): string {
  const current = normalizedRemotePath(currentPath)
  if (
    current !== '/' &&
    previousValue === current &&
    nextValue.startsWith(current) &&
    nextValue.length > current.length &&
    nextValue[current.length] !== '/'
  ) {
    return `${current}/${nextValue.slice(current.length)}`
  }
  return nextValue
}

export function remoteFolderFilterQuery(
  currentPath: string,
  typedPath: string
): string {
  const current = normalizedRemotePath(currentPath)
  const typed = typedPath.trim()
  if (!typed || typed === current) return ''

  let remainder = ''
  if (current === '/' && typed.startsWith('/')) {
    remainder = typed.slice(1)
  } else if (typed.startsWith(`${current}/`)) {
    remainder = typed.slice(current.length + 1)
  } else if (typed.startsWith(current)) {
    remainder = typed.slice(current.length)
  } else {
    remainder = typed.split('/').at(-1) ?? ''
  }
  return remainder.split('/')[0]?.trim() ?? ''
}

function fuzzyNameScore(name: string, rawQuery: string): number | null {
  const candidate = name.toLocaleLowerCase()
  const query = rawQuery.trim().toLocaleLowerCase()
  if (!query) return 0
  if (candidate === query) return 10_000
  if (candidate.startsWith(query)) return 7_500 - candidate.length
  const containedAt = candidate.indexOf(query)
  if (containedAt >= 0) return 5_000 - containedAt * 10 - candidate.length

  let queryIndex = 0
  let previousMatch = -2
  let score = 1_000
  for (let index = 0; index < candidate.length && queryIndex < query.length; index += 1) {
    if (candidate[index] !== query[queryIndex]) continue
    const adjacent = index === previousMatch + 1
    const boundary = index === 0 || /[\s._-]/u.test(candidate[index - 1])
    score += adjacent ? 30 : 8
    if (boundary) score += 20
    score -= index
    previousMatch = index
    queryIndex += 1
  }
  if (queryIndex !== query.length) return null
  return score - (candidate.length - query.length)
}

export function fuzzyFilterFolderEntries<T extends { name: string }>(
  entries: T[],
  query: string
): T[] {
  if (!query.trim()) return entries
  return entries
    .flatMap((entry, index) => {
      const score = fuzzyNameScore(entry.name, query)
      return score == null ? [] : [{ entry, index, score }]
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ entry }) => entry)
}

export function rankedRemoteBrowserEntries<
  T extends { name: string; kind: 'directory' | 'file' }
>(entries: T[], query: string): T[] {
  const matches = fuzzyFilterFolderEntries(entries, query)
  return [
    ...matches.filter((entry) => entry.kind === 'directory'),
    ...matches.filter((entry) => entry.kind === 'file')
  ]
}

export function remoteFolderSlashTarget<
  T extends { name: string; path: string; kind: 'directory' | 'file' }
>(currentPath: string, typedPath: string, entries: T[]): string | null {
  const typed = typedPath.trim()
  if (!typed.endsWith('/')) return null

  const current = normalizedRemotePath(currentPath)
  const typedTarget = typed.replace(/\/+$/u, '') || '/'
  if (typedTarget === current) return null

  const query = remoteFolderFilterQuery(current, typedTarget)
  const insideCurrent =
    current === '/' || typedTarget.startsWith(`${current}/`)
  const matchingFolder = rankedRemoteBrowserEntries(entries, query).find(
    (entry) => entry.kind === 'directory'
  )
  return insideCurrent && query && matchingFolder
    ? matchingFolder.path
    : typedTarget
}
