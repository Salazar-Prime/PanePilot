import { describe, expect, it } from 'vitest'
import {
  loadLatexManuscriptView,
  loadLatexPdfView,
  saveLatexManuscriptView,
  saveLatexPdfView
} from '../src/renderer/src/lib/latexViewMemory'

describe('LaTeX project view memory', () => {
  it('keeps manuscript file, selection, and scroll position per project', () => {
    saveLatexManuscriptView('paper-a', {
      path: 'chapters/results.tex',
      selection: {
        startLineNumber: 42,
        startColumn: 7,
        endLineNumber: 42,
        endColumn: 7
      },
      scrollTop: 860,
      scrollLeft: 24
    })

    expect(loadLatexManuscriptView('paper-a')).toEqual({
      path: 'chapters/results.tex',
      selection: {
        startLineNumber: 42,
        startColumn: 7,
        endLineNumber: 42,
        endColumn: 7
      },
      scrollTop: 860,
      scrollLeft: 24
    })
    expect(loadLatexManuscriptView('paper-b')).toBeNull()
  })

  it('keeps PDF page, continuous-scroll offset, and zoom per project', () => {
    saveLatexPdfView('paper-a', {
      pageNumber: 18,
      scrollTop: 14_240,
      zoom: 1.25
    })

    expect(loadLatexPdfView('paper-a')).toEqual({
      pageNumber: 18,
      scrollTop: 14_240,
      zoom: 1.25
    })
    expect(loadLatexPdfView('paper-b')).toBeNull()
  })
})
