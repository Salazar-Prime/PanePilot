import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('LaTeX PDF print layout', () => {
  it('removes the full-window clipping that would truncate later PDF pages', () => {
    const css = readFileSync(
      join(process.cwd(), 'src', 'renderer', 'src', 'latex-pdf.css'),
      'utf8'
    )
    const printRules = css.slice(css.indexOf('@media print'))

    expect(printRules).toContain('height: auto !important;')
    expect(printRules).toContain('overflow: visible !important;')
    expect(printRules).toContain('body > #root')
    expect(printRules).toContain('display: none !important;')
    expect(printRules).toContain('break-after: page;')
    expect(printRules).toContain('break-inside: avoid;')
    expect(printRules).toContain('width: 100% !important;')
  })

  it('keeps a continuous page stack instead of replacing one canvas at a time', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'src',
        'renderer',
        'src',
        'components',
        'LatexPdfPreview.tsx'
      ),
      'utf8'
    )

    expect(source).toContain('className="latex-pdf-pages"')
    expect(source).toContain('data-pdf-page={pageNumber}')
    expect(source).toContain('window.projectConsole.latex.compile(projectId)')
    expect(source).not.toContain('setPageNumber(1)')
  })
})
