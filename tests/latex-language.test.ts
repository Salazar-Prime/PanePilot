import { describe, expect, it } from 'vitest'
import { LATEX_ROOT_TOKEN_RULES } from '../src/renderer/src/lib/latexLanguage'

interface Token {
  text: string
  type: string
}

function tokenizeLine(line: string): Token[] {
  const tokens: Token[] = []
  let offset = 0

  while (offset < line.length) {
    const remaining = line.slice(offset)
    const rule = LATEX_ROOT_TOKEN_RULES.find(([pattern]) => {
      pattern.lastIndex = 0
      return pattern.exec(remaining)?.index === 0
    })
    if (!rule) {
      offset += 1
      continue
    }

    rule[0].lastIndex = 0
    const match = rule[0].exec(remaining)
    if (!match?.[0]) {
      offset += 1
      continue
    }
    tokens.push({ text: match[0], type: rule[1] })
    offset += match[0].length
  }

  return tokens
}

describe('LaTeX Monaco language', () => {
  it('does not treat an escaped percent sign as the start of a comment', () => {
    const tokens = tokenizeLine(String.raw`Accuracy improved by 12\% in one run.`)

    expect(tokens).toContainEqual({ text: String.raw`\%`, type: '' })
    expect(tokens.some((token) => token.type === 'comment')).toBe(false)
  })

  it('still highlights an unescaped percent sign and the remainder as a comment', () => {
    const tokens = tokenizeLine('Accuracy improved. % Explain the result')

    expect(tokens).toContainEqual({
      text: '% Explain the result',
      type: 'comment'
    })
  })

  it('uses TeX backslash parity when a percent follows consecutive slashes', () => {
    const evenTokens = tokenizeLine(String.raw`Line break \\% comment`)
    const oddTokens = tokenizeLine(String.raw`Literal slash and percent \\\% text`)

    expect(evenTokens).toContainEqual({ text: '% comment', type: 'comment' })
    expect(oddTokens.some((token) => token.type === 'comment')).toBe(false)
  })

  it('retains the previous formatting for every other LaTeX token', () => {
    const tokens = tokenizeLine(String.raw`\section{Result} \& \_ $x$`)

    expect(tokens).toEqual([
      { text: String.raw`\section`, type: 'keyword' },
      { text: '{', type: 'delimiter.bracket' },
      { text: '}', type: 'delimiter.bracket' },
      { text: '&', type: 'operator' },
      { text: '_', type: 'operator' },
      { text: '$', type: 'delimiter' },
      { text: '$', type: 'delimiter' }
    ])
  })
})
