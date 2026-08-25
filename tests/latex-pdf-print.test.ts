import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('LaTeX PDF print layout', () => {
  it('sends the original PDF through one native print operation', () => {
    const printer = readFileSync(
      join(process.cwd(), 'src', 'main', 'pdf-printer.ts'),
      'utf8'
    )

    expect(printer).toContain('plugins: true')
    expect(printer).toContain("pdfEvents.once('-pdf-ready-to-print'")
    expect(printer).toContain('await printWindow.loadFile(temporaryPdf)')
    expect(printer).toContain('window.webContents.print(')
    expect(printer).not.toContain('pageRanges:')
  })

  it('prints the displayed snapshot without constructing print canvases', () => {
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
    expect(source).toContain('window.projectConsole.latex.printPdf({')
    expect(source).not.toContain('latex-pdf-print-root')
    expect(source).not.toContain('printCurrentWindow')
  })
})
