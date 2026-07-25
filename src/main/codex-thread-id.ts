const CODEX_THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function normalizeCodexThreadId(value?: string): string | null {
  const threadId = value?.trim() ?? ''
  if (!threadId) return null
  if (!CODEX_THREAD_ID_PATTERN.test(threadId)) {
    throw new Error('Enter a valid Codex thread ID (UUID).')
  }
  return threadId.toLowerCase()
}
