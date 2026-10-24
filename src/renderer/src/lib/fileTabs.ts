import type { FilePreview } from '@shared/types'

export interface OpenFileTab {
  preview: FilePreview
  draft: string
  editing: boolean
  viewMode: 'preview' | 'source'
  temporary: boolean
}

/** Editing is a commitment: replacing a preview must never displace a live draft. */
export function protectFileTab(file: OpenFileTab): OpenFileTab {
  return file.temporary && (file.editing || file.draft !== file.preview.content)
    ? { ...file, temporary: false } : file
}

export function keepFileTab(files: OpenFileTab[], path: string): OpenFileTab[] {
  return files.map((file) => file.preview.path === path && file.temporary
    ? { ...file, temporary: false } : file)
}

export function openPreviewTab(
  files: OpenFileTab[], incoming: OpenFileTab, requestedViewMode?: OpenFileTab['viewMode']
): OpenFileTab[] {
  const safe = files.map(protectFileTab)
  if (safe.some((file) => file.preview.path === incoming.preview.path)) {
    return safe.map((file) => file.preview.path === incoming.preview.path
      ? { ...file, temporary: file.temporary && incoming.temporary, viewMode: requestedViewMode ?? file.viewMode }
      : file)
  }
  const slot = safe.findIndex((file) => file.temporary)
  if (slot === -1) return [...safe, incoming]
  return safe.map((file, index) => index === slot ? incoming : file)
}
