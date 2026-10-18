import type { ConversationMessage } from './types'

export const MAX_HIDDEN_MESSAGES = 1_000_000

export function normalizedHiddenMessageCount(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_HIDDEN_MESSAGES, Math.max(0, Math.floor(value))) : 0
}

/** Hide only rendered cards; retain the authoritative archive and message order. */
export function conversationMessageWindow<T>(messages: readonly T[], requested: number) {
  const hiddenCount = Math.min(messages.length, normalizedHiddenMessageCount(requested))
  return { hiddenCount, messages: messages.slice(hiddenCount) }
}

/** Sidebar copy must come from the same retained messages as the transcript. */
export function conversationDisplayWindow(
  conversation: { title: string; messages: readonly Pick<ConversationMessage, 'role' | 'content'>[] },
  requested: number
) {
  const window = conversationMessageWindow(conversation.messages, requested)
  const first = window.messages.find((message) => message.role === 'user') ?? window.messages[0]
  const title = window.hiddenCount
    ? first?.content.replace(/\s+/g, ' ').trim() || 'All messages hidden'
    : conversation.title
  return { ...window, title: title.length > 78 ? `${title.slice(0, 77)}…` : title }
}
