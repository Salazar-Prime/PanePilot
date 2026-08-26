import { describe, expect, it } from 'vitest'
import { latexGraphicAtColumn } from '../src/renderer/src/lib/latexGraphics'

describe('LaTeX includegraphics references', () => {
  it('finds the image path under the pointer and expands extensionless paths', () => {
    const line = String.raw`\includegraphics[width=.8\linewidth]{figures/result}`
    const reference = latexGraphicAtColumn(line, 'sections/method.tex', 48)

    expect(reference).toMatchObject({
      source: 'figures/result',
      startColumn: 38,
      endColumn: 52
    })
    expect(reference?.candidates).toContain('figures/result.png')
    expect(reference?.candidates).toContain('sections/figures/result.jpg')
  })

  it('ignores includegraphics commands after an unescaped LaTeX comment', () => {
    expect(
      latexGraphicAtColumn(
        String.raw`% \includegraphics{figures/old.png}`,
        'main.tex',
        25
      )
    ).toBeNull()
    expect(
      latexGraphicAtColumn(
        String.raw`Caption \% \includegraphics{figures/current.png}`,
        'main.tex',
        38
      )?.source
    ).toBe('figures/current.png')
  })
})
