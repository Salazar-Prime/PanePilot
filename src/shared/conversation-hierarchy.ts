import type { ConversationSummary } from './types'

type Identity = Pick<ConversationSummary, 'provider' | 'providerSessionId' | 'parentProviderSessionId'>

function providerKey(conversation: Identity, sessionId = conversation.providerSessionId): string {
  return JSON.stringify([conversation.provider, sessionId])
}

/** Only explicit provider-scoped parent IDs establish subagent ownership. */
export function conversationsWithDescendants<T extends Identity>(
  conversations: T[],
  belongsToProject: (conversation: T) => boolean
): T[] {
  const children = new Map<string, T[]>()
  for (const conversation of conversations) {
    if (!conversation.parentProviderSessionId) continue
    const key = providerKey(conversation, conversation.parentProviderSessionId)
    const siblings = children.get(key) ?? []
    siblings.push(conversation)
    children.set(key, siblings)
  }
  const included = new Set<T>()
  const pending = conversations.filter(belongsToProject)
  while (pending.length) {
    const conversation = pending.pop()!
    if (included.has(conversation)) continue
    included.add(conversation)
    if (conversation.providerSessionId) pending.push(...(children.get(providerKey(conversation)) ?? []))
  }
  return conversations.filter((conversation) => included.has(conversation))
}

export interface ConversationNode {
  conversation: ConversationSummary
  children: ConversationNode[]
  descendantCount: number
}

/** Missing parents remain visible; malformed cycles are broken, never hidden. */
export function conversationForest(conversations: ConversationSummary[]): ConversationNode[] {
  const nodes = new Map<string, ConversationNode>()
  const sessions = new Map<string, ConversationNode>()
  for (const conversation of conversations) {
    if (nodes.has(conversation.id)) continue
    const node = { conversation, children: [], descendantCount: 0 }
    nodes.set(conversation.id, node)
    if (conversation.providerSessionId) sessions.set(providerKey(conversation), node)
  }
  const parents = new Map<ConversationNode, ConversationNode>()
  for (const node of nodes.values()) {
    const id = node.conversation.parentProviderSessionId
    const parent = id ? sessions.get(providerKey(node.conversation, id)) : undefined
    if (parent && parent !== node) parents.set(node, parent)
  }
  const checked = new Set<ConversationNode>()
  for (const node of nodes.values()) {
    const path = new Set<ConversationNode>()
    let current: ConversationNode | undefined = node
    while (current && !checked.has(current)) {
      if (path.has(current)) { parents.delete(current); break }
      path.add(current)
      current = parents.get(current)
    }
    for (const entry of path) checked.add(entry)
  }
  const roots: ConversationNode[] = []
  for (const node of nodes.values()) {
    const parent = parents.get(node)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const ordered: ConversationNode[] = []
  const pending = [...roots]
  while (pending.length) {
    const node = pending.pop()!
    ordered.push(node)
    pending.push(...node.children)
  }
  for (const node of ordered.reverse()) {
    node.descendantCount = node.children.reduce((count, child) => count + 1 + child.descendantCount, 0)
  }
  return roots
}

/** Search retains the ancestor chain so matching subagents never lose context. */
export function matchingConversations(conversations: ConversationSummary[]): ConversationSummary[] {
  const retained = new Set<string>()
  const pending = conversationForest(conversations).map((node) => ({ node, ancestors: [] as string[] }))
  while (pending.length) {
    const { node, ancestors } = pending.pop()!
    if (node.conversation.matchCount > 0) {
      retained.add(node.conversation.id)
      for (const id of ancestors) retained.add(id)
    }
    for (const child of node.children) pending.push({ node: child, ancestors: [...ancestors, node.conversation.id] })
  }
  return conversations.filter((conversation) => retained.has(conversation.id))
}
