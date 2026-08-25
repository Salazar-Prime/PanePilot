import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('LaTeX PDF print layout', () => {
  it('sends the original PDF through one native PDFKit print operation', () => {
    const printer = readFileSync(
      join(process.cwd(), 'src', 'main', 'pdf-printer.ts'),
      'utf8'
    )

    expect(printer).toContain("ObjC.import('PDFKit')")
    expect(printer).toContain('document.printOperationForPrintInfoScalingModeAutoRotate(')
    expect(printer).toContain('operation.showsPrintPanel = true')
    expect(printer).toContain('operation.runOperation')
    expect(printer).not.toContain('BrowserWindow')
    expect(printer).not.toContain('webContents.print(')
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
