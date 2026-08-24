import type { LatexSection } from '@shared/types'

const SECTION_KIND_LABELS = [
  'Part',
  'Chapter',
  'Section',
  'Subsection',
  'Sub-subsection',
  'Paragraph',
  'Subparagraph'
] as const

export function latexSectionKindLabel(level: number): string {
  return SECTION_KIND_LABELS[level] ?? `Outline level ${level}`
}

export function latexSectionOptionLabel(
  section: Pick<LatexSection, 'title' | 'level'>,
  baseLevel: number
): string {
  const depth = Math.max(0, Math.min(5, section.level - baseLevel))
  const branch = depth > 0 ? `${'\u00a0\u00a0\u00a0'.repeat(depth)}↳ ` : ''
  return `${branch}${latexSectionKindLabel(section.level).toLocaleUpperCase()} — ${section.title}`
}
