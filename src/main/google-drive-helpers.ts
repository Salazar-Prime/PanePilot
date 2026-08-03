const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

export interface RcloneStat {
  ID?: string
  Name?: string
  Path?: string
  IsDir?: boolean
}

export function normalizeRcloneRemoteName(value: string): string {
  const name = value.trim().replace(/:+$/, '')
  if (!name) throw new Error('Choose an rclone remote for this project.')
  if (name.length > 100 || name.includes(':') || CONTROL_CHARACTER_PATTERN.test(name)) {
    throw new Error('The rclone remote name is invalid.')
  }
  return name
}

export function normalizeDriveFolderPath(value: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '.' || trimmed === '/') return ''
  if (trimmed.length > 1024 || CONTROL_CHARACTER_PATTERN.test(trimmed)) {
    throw new Error('The Google Drive folder path is invalid.')
  }
  const segments = trimmed.replace(/^\/+|\/+$/g, '').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('The Google Drive folder path cannot contain empty, . or .. segments.')
  }
  return segments.join('/')
}

export function normalizeProjectFilePath(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed || trimmed.length > 4096 || CONTROL_CHARACTER_PATTERN.test(trimmed)) {
    throw new Error('Choose a valid project file to upload.')
  }
  const segments = trimmed.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Choose a valid project file to upload.')
  }
  return segments.join('/')
}

export function rcloneRemotePath(remoteName: string, path = ''): string {
  const remote = normalizeRcloneRemoteName(remoteName)
  const normalizedPath = path ? normalizeDriveFolderPath(path) : ''
  return `${remote}:${normalizedPath}`
}

export function driveUploadPath(folderPath: string, relativePath: string): string {
  const folder = normalizeDriveFolderPath(folderPath)
  const file = normalizeProjectFilePath(relativePath)
  return folder ? `${folder}/${file}` : file
}

export function parseRcloneStat(raw: string): RcloneStat {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('rclone returned an invalid response for the Google Drive item.')
  }
  const item = Array.isArray(parsed) ? parsed[0] : parsed
  if (!item || typeof item !== 'object') {
    throw new Error('rclone could not find the Google Drive item.')
  }
  return item as RcloneStat
}

export function isGoogleDriveRemoteConfig(raw: string): boolean {
  return /^\s*type\s*=\s*drive\s*$/im.test(raw)
}

export function googleDriveItemUrl(fileId: string): string {
  if (!DRIVE_ID_PATTERN.test(fileId)) {
    throw new Error('rclone returned an invalid Google Drive item ID.')
  }
  return `https://drive.google.com/open?id=${encodeURIComponent(fileId)}`
}

export function googleDriveFolderUrl(folderId: string | null): string {
  if (!folderId) return 'https://drive.google.com/drive/my-drive'
  if (!DRIVE_ID_PATTERN.test(folderId)) {
    throw new Error('rclone returned an invalid Google Drive folder ID.')
  }
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`
}
