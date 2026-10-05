import type { CodexSubagentOutput } from '@shared/types'

export const SUBAGENTS_PER_PAGE = 8

// Keep SGR colors/styles only. Archive output must never move the cursor, set
// clipboard contents, open links, request device reports, or change terminal modes.
export function safeTerminalText(value: string): string {
  return value
    .replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)([0-?]*)([ -/]*)([@-~])/g, (_all, params: string, intermediate: string, final: string) =>
      final === 'm' && !intermediate && /^[\d;:]*$/.test(params) ? `\x1b[${params}m` : '')
    .replace(/\x1b(?!\[\d*(?:[;:]\d*)*m)[ -/]*[0-~]?/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f-\x9f]/g, '')
}

function readableTool(text: string): string {
  const newline = text.indexOf('\n')
  if (newline < 0) return text
  const name = text.slice(0, newline)
  try {
    const args = JSON.parse(text.slice(newline + 1))
    // Match the command-first presentation in the ordinary Codex terminal.
    if (args && typeof args.cmd === 'string') return `$ ${args.cmd}`
    if (args && typeof args.command === 'string') return `$ ${args.command}`
    return `${name}\n${JSON.stringify(args, null, 2)}`
  } catch { return text }
}

export function subagentTranscript(output: CodexSubagentOutput[], truncated: boolean): string {
  const chunks = truncated ? ['\x1b[90m[Recent output · older/long entries shortened]\x1b[0m\n\n'] : []
  if (!output.length) chunks.push('\x1b[90mWaiting for output…\x1b[0m\n')
  for (const item of output) {
    const body = safeTerminalText(item.kind === 'tool' ? readableTool(item.text) : item.text)
    if (item.kind === 'message') chunks.push(`\x1b[1;36m●\x1b[0m ${body}\x1b[0m\n\n`)
    else if (item.kind === 'tool') chunks.push(`\x1b[33m› ${body}\x1b[0m\n`)
    else chunks.push(`\x1b[90m${body}\x1b[0m\n\n`)
  }
  return chunks.join('')
}
