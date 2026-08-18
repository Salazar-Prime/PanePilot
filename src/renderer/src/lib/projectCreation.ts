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
