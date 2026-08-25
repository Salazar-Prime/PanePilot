import type {
  LatexSection,
  LatexSourceSelection
} from './types'

export function latexSelectionLastLine(
  selection: Pick<
    LatexSourceSelection,
    'startLine' | 'endLine' | 'endColumn'
  >
): number {
  return selection.endColumn === 1 && selection.endLine > selection.startLine
    ? selection.endLine - 1
    : selection.endLine
}

export function latexSectionContainsSelection(
  section: LatexSection,
  selection: LatexSourceSelection
): boolean {
  return (
    section.sourceFile === selection.path &&
    selection.startLine >= section.startLine &&
    latexSelectionLastLine(selection) <= section.endLine
  )
}

export function latexSectionForSelection(
  sections: LatexSection[],
  selection: LatexSourceSelection
): LatexSection | null {
  return (
    sections.find((section) =>
      latexSectionContainsSelection(section, selection)
    ) ?? null
  )
}
