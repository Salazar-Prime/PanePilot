import { normalizedHiddenMessageCount } from '../../../shared/conversation-messages'

const KEY = 'panepilot:chat-hidden-messages:session'
const listeners = new Set<() => void>()
let hiddenCount = readSessionCount()

function readSessionCount(): number {
  try { return normalizedHiddenMessageCount(Number(window.sessionStorage.getItem(KEY))) }
  catch { return 0 }
}

export function getConversationHiddenCount(): number { return hiddenCount }

export function setConversationHiddenCount(value: number): void {
  const next = normalizedHiddenMessageCount(value)
  if (next === hiddenCount) return
  hiddenCount = next
  try { window.sessionStorage.setItem(KEY, String(next)) } catch { /* Memory still survives workspace remounts. */ }
  for (const listener of listeners) listener()
}

export function subscribeConversationHiddenCount(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
