export function droppedPathsText(paths: string[]): string {
  return paths.map((path) => {
    if (/[\x00-\x1f\x7f]/.test(path)) throw new Error('File paths containing control characters cannot be pasted.')
    return `'${path.replaceAll("'", "'\\''")}'`
  }).join(' ') + (paths.length ? ' ' : '')
}

export interface TerminalDropProgress {
  id: string
  sessionId: string
  projectId: string
  target: string
  fileName: string
  completedFiles: number
  totalFiles: number
  transferredBytes: number
  totalBytes: number
  state: 'uploading' | 'completed' | 'failed'
  paths: string[]
  error?: string
  updatedAt: number
}

export interface TerminalDropResult {
  transferId?: string
  paths: string[]
  error?: string
}
