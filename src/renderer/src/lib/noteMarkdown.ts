const PROJECT_NOTES_PREFIX = '.panepilot/notes/'

export function noteProjectPath(notePath: string): string {
  return `${PROJECT_NOTES_PREFIX}${notePath}`
}

export function projectNotePathFromLink(
  projectPath: string,
  availableNotePaths: readonly string[]
): string | null {
  if (!projectPath.startsWith(PROJECT_NOTES_PREFIX)) return null
  const notePath = projectPath.slice(PROJECT_NOTES_PREFIX.length)
  return availableNotePaths.includes(notePath) ? notePath : null
}
