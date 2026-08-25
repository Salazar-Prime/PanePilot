import type { languages } from 'monaco-editor'

export const LATEX_ROOT_TOKEN_RULES: Array<[RegExp, string]> = [
  [/\\(?:part|chapter|section|subsection|subsubsection)\*?/, 'keyword'],
  [/\\[A-Za-z@]+/, 'type.identifier'],
  // In TeX, a backslash followed by a non-letter is one control symbol. Match
  // it before comments so \% remains literal text. Consecutive backslashes are
  // consumed in pairs, which correctly leaves the percent in \\% unescaped.
  [/\\./, 'type.identifier'],
  [/%.*$/, 'comment'],
  [/\$+/, 'delimiter'],
  [/[{}[\]]/, 'delimiter.bracket'],
  [/[&_^]/, 'operator']
]

export const latexMonarchLanguage: languages.IMonarchLanguage = {
  tokenizer: {
    root: LATEX_ROOT_TOKEN_RULES
  }
}
