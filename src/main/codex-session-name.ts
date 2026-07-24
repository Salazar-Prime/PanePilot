const PROVIDER_NAME_PREFIX = 'panepilot'
const PROVIDER_NAME_BASE_LIMIT = 40
const PROVIDER_NAME_TOKEN_LIMIT = 12

export function createCodexSessionName(terminalName: string, uniquenessToken: string): string {
  const base =
    terminalName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, PROVIDER_NAME_BASE_LIMIT)
      .replace(/-+$/g, '') || 'codex'
  const token =
    uniquenessToken
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, PROVIDER_NAME_TOKEN_LIMIT) || 'session'
  return `${PROVIDER_NAME_PREFIX}-${base}-${token}`
}

export function codexComposerIsReady(lines: string[]): boolean {
  return lines.some((line) => /^\s*›(?:\s|$)/.test(line))
}

export function codexRenameInput(providerSessionName: string): string {
  return `/rename ${providerSessionName}\r`
}
