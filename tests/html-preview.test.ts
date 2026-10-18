import { describe, expect, it } from 'vitest'
import { isHtmlPath } from '../src/renderer/src/lib/htmlPreview'

describe('HTML preview file detection', () => {
  it('recognizes HTML variants without treating scripts or Markdown as HTML', () => {
    for (const path of ['index.html', 'mockups/Design.HTML', 'page.htm', 'book.xhtml']) expect(isHtmlPath(path)).toBe(true)
    for (const path of ['README.md', 'index.html.js', 'html', 'page.svg', 'page.html.bak']) expect(isHtmlPath(path)).toBe(false)
  })
})
