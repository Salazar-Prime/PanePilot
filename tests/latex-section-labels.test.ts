import { describe, expect, it } from 'vitest'
import {
  latexSectionKindLabel,
  latexSectionOptionLabel
} from '../src/renderer/src/lib/latexSectionLabels'

describe('LaTeX section labels', () => {
  it('names the manuscript hierarchy in reader-facing language', () => {
    expect(latexSectionKindLabel(0)).toBe('Part')
    expect(latexSectionKindLabel(1)).toBe('Chapter')
    expect(latexSectionKindLabel(2)).toBe('Section')
    expect(latexSectionKindLabel(3)).toBe('Subsection')
    expect(latexSectionKindLabel(4)).toBe('Sub-subsection')
  })

  it('preserves manuscript order while visibly indenting nested options', () => {
    expect(
      latexSectionOptionLabel(
        { title: 'Materials and Methods', level: 2 },
        2
      )
    ).toBe('SECTION — Materials and Methods')
    expect(
      latexSectionOptionLabel(
        { title: 'Architecture Overview', level: 3 },
        2
      )
    ).toBe('\u00a0\u00a0\u00a0↳ SUBSECTION — Architecture Overview')
    expect(
      latexSectionOptionLabel(
        { title: 'Experimental Setup', level: 4 },
        2
      )
    ).toBe(
      '\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0↳ SUB-SUBSECTION — Experimental Setup'
    )
  })
})
