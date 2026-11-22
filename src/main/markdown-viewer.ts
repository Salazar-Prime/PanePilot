import { open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { extname } from 'node:path'
import { MARKDOWN_PREVIEW_BYTE_LIMIT } from '../shared/markdownViewer'

/** Called only for a path explicitly chosen in the native Open dialog. */
export async function readMarkdownViewerFile(path: string): Promise<{ content: string; path: string }> {
  const canonical = await realpath(path)
  if (!['.md', '.markdown', '.mdown'].includes(extname(canonical).toLowerCase())) {
    throw new Error('Choose a Markdown file (.md, .markdown, or .mdown).')
  }
  // A FIFO/device renamed .md must not leave the reader waiting indefinitely.
  const file = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Choose a regular Markdown file.')
    if (stat.size > MARKDOWN_PREVIEW_BYTE_LIMIT) throw new Error('Markdown previews support files up to 1 MB.')
    const buffer = Buffer.alloc(MARKDOWN_PREVIEW_BYTE_LIMIT + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MARKDOWN_PREVIEW_BYTE_LIMIT) throw new Error('Markdown previews support files up to 1 MB.')
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)) }
    catch { throw new Error('Choose a UTF-8 Markdown file.') }
    if (content.includes('\0')) throw new Error('This file contains binary data, not Markdown text.')
    return { content, path: canonical }
  } finally { await file.close() }
}
