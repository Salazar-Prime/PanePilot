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
})
