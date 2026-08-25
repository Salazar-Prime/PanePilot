import type {
  LatexSection,
  LatexSourceSelection,
  TerminalSession
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

export function latexChatCoversSelection(
  session: TerminalSession,
  sections: LatexSection[],
  selection: LatexSourceSelection
): boolean {
  const chat = session.latexChat
  if (!chat || session.kind !== 'latex-chat' || session.archived) return false
  if (['completed', 'error'].includes(session.state)) return false
  if (chat.scope === 'project') return true
  const section = sections.find((candidate) => candidate.id === chat.sectionId)
  return Boolean(section && latexSectionContainsSelection(section, selection))
}
