import type { languages } from 'monaco-editor'

export const LATEX_ROOT_TOKEN_RULES: Array<[RegExp, string]> = [
  // Only percent escaping needs to precede the comment rule. An even run of
  // backslashes leaves % unescaped; an odd run consumes it as literal text.
  [/(?:\\\\)+(?=%)/, ''],
  [/(?:\\\\)*\\%/, ''],
  [/%.*$/, 'comment'],
  [/\\(?:part|chapter|section|subsection|subsubsection)\*?/, 'keyword'],
  [/\\[A-Za-z@]+/, 'type.identifier'],
  [/\$+/, 'delimiter'],
  [/[{}[\]]/, 'delimiter.bracket'],
  [/[&_^]/, 'operator']
]

export const latexMonarchLanguage: languages.IMonarchLanguage = {
  tokenizer: {
    root: LATEX_ROOT_TOKEN_RULES
  }
}
