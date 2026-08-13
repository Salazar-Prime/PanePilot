import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isMarkdownPath,
  renderMarkdownDocument,
  resolveMarkdownTarget
} from '../src/renderer/src/lib/markdown'

describe('Markdown preview', () => {
  it('renders GitHub-flavored README structures and stable heading links', () => {
    const html = renderMarkdownDocument(`# PanePilot

## Install now

## Install now

| State | Meaning |
| --- | --- |
| Ready | Done |

- [x] Preview Markdown
- [ ] Ship it

~~old~~ https://example.com

> [!NOTE]
> Local images stay inside the project.

\`\`\`ts
const ready: boolean = true
\`\`\`
`)

    expect(html).toContain('id="panepilot"')
    expect(html).toContain('id="install-now"')
    expect(html).toContain('id="install-now-1"')
    expect(html).toContain('<table>')
    expect(html).toMatch(/<input[^>]*checked=""[^>]*type="checkbox">/)
    expect(html).toContain('<del>old</del>')
    expect(html).toContain('class="markdown-alert markdown-alert-note"')
    expect(html).toContain('class="hljs language-ts"')
    expect(html).toContain('<span class="hljs-keyword">const</span>')
  })

  it('marks image and link sources for safe renderer-side handling', () => {
    const html = renderMarkdownDocument(
      '![Diagram](../assets/flow.png "Flow")\n\n[Guide](./guide.md#setup)'
    )

    expect(html).toContain('data-markdown-src="../assets/flow.png"')
    expect(html).toContain('data-markdown-href="./guide.md#setup"')
  })

  it('resolves repository-relative links without allowing project escape', () => {
    expect(resolveMarkdownTarget('docs/README.md', '../assets/flow.png')).toEqual({
      kind: 'project',
      path: 'assets/flow.png',
      fragment: null
    })
    expect(resolveMarkdownTarget('docs/README.md', '/CONTRIBUTING.md#rules')).toEqual({
      kind: 'project',
      path: 'CONTRIBUTING.md',
      fragment: 'rules'
    })
    expect(resolveMarkdownTarget('README.md', '#install')).toEqual({
      kind: 'fragment',
      fragment: 'install'
    })
    expect(resolveMarkdownTarget('docs/README.md', '?plain=1#install')).toEqual({
      kind: 'project',
      path: 'docs/README.md',
      fragment: 'install'
    })
    expect(resolveMarkdownTarget('README.md', 'https://github.com/openai')).toMatchObject({
      kind: 'external'
    })
    expect(resolveMarkdownTarget('README.md', '../outside.txt')).toEqual({
      kind: 'unsupported'
    })
    expect(resolveMarkdownTarget('README.md', 'javascript:alert(1)')).toEqual({
      kind: 'unsupported'
    })
  })

  it('recognizes the Markdown file extensions shown in the Files workspace', () => {
    expect(isMarkdownPath('README.md')).toBe(true)
    expect(isMarkdownPath('docs/guide.MARKDOWN')).toBe(true)
    expect(isMarkdownPath('notes.txt')).toBe(false)
  })

  it('sanitizes raw HTML and removes image URLs before DOM insertion', () => {
    const component = readFileSync(
      join(
        process.cwd(),
        'src/renderer/src/components/MarkdownPreview.tsx'
      ),
      'utf8'
    )

    expect(component).toContain('DOMPurify.sanitize')
    expect(component).toContain("FORBID_ATTR: ['srcset', 'style']")
    expect(component).toContain("'script'")
    expect(component).toContain("image.removeAttribute('src')")
    expect(component).toContain("image.setAttribute('referrerpolicy', 'no-referrer')")
  })
})
