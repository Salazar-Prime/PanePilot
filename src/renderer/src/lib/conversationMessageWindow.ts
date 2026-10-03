/** Hide only rendered cards; retain the authoritative archive and message order. */
export function conversationMessageWindow<T>(messages: readonly T[], requested: number) {
  const hiddenCount = Number.isFinite(requested)
    ? Math.min(messages.length, Math.max(0, Math.floor(requested)))
    : 0
  return { hiddenCount, messages: messages.slice(hiddenCount) }
}
