export const MARKDOWN_HISTORY_LIMIT = 50
export const MARKDOWN_PREVIEW_BYTE_LIMIT = 1024 * 1024

export interface MarkdownViewerEntry {
  id: string
  title: string
  source: 'clipboard' | 'file'
  sourcePath: string | null
  openedAt: string
  content: string
}

export type MarkdownViewerSummary = Omit<MarkdownViewerEntry, 'content'>

export interface MarkdownViewerApi {
  list(): Promise<MarkdownViewerSummary[]>
  get(id: string): Promise<MarkdownViewerEntry>
  fromClipboard(): Promise<MarkdownViewerEntry>
  openFile(): Promise<MarkdownViewerEntry | null>
  remove(id: string): Promise<void>
}
