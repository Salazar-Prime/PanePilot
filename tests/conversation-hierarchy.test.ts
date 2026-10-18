import { describe, expect, it } from 'vitest'
import { conversationForest, conversationsWithDescendants, matchingConversations } from '../src/shared/conversation-hierarchy'
import type { ConversationSummary } from '../src/shared/types'

function chat(id: string, parent: string | null = null, extra: Partial<ConversationSummary> = {}): ConversationSummary {
  return { id, provider: 'codex', providerSessionId: id, parentProviderSessionId: parent, title: id,
    workingDirectory: '/project', updatedAt: '2026-10-18T10:00:00Z', messageCount: 2, snippet: 'Done', matchCount: 0, ...extra }
}

describe('archived subagent hierarchy', () => {
  it('nests children and grandchildren without grouping unrelated same-folder chats', () => {
    const forest = conversationForest([chat('child', 'root'), chat('nested', 'child'), chat('root'), chat('unrelated')])
    expect(forest.map((node) => node.conversation.id)).toEqual(['root', 'unrelated'])
    expect(forest[0].descendantCount).toBe(2)
    expect(forest[0].children[0].conversation.id).toBe('child')
    expect(forest[0].children[0].children[0].conversation.id).toBe('nested')
  })

  it('keeps missing-parent agents visible and scopes identity to the provider', () => {
    const forest = conversationForest([chat('root'), chat('orphan', 'missing'), chat('claude-agent', 'root', { provider: 'claude' })])
    expect(forest).toHaveLength(3)
    expect(forest.every((node) => !node.children.length)).toBe(true)
  })

  it('does not lose chats or loop on corrupt cyclic and self-parent links', () => {
    const forest = conversationForest([chat('a', 'b'), chat('b', 'a'), chat('self', 'self')])
    expect(forest).toHaveLength(2)
    expect(forest.reduce((count, node) => count + 1 + node.descendantCount, 0)).toBe(3)
  })

  it('includes explicit worktree descendants but never unrelated foreign chats', () => {
    const all = [chat('root'), chat('child', 'root', { workingDirectory: '/worktree' }),
      chat('nested', 'child', { workingDirectory: '/nested-worktree' }), chat('foreign', null, { workingDirectory: '/worktree' })]
    expect(conversationsWithDescendants(all, (item) => item.workingDirectory === '/project').map((item) => item.id)).toEqual(['root', 'child', 'nested'])
  })

  it('keeps search-match ancestors without showing unrelated siblings', () => {
    const all = [chat('nested', 'child', { matchCount: 2 }), chat('child', 'root'), chat('root'), chat('sibling', 'root'), chat('unrelated')]
    expect(matchingConversations(all).map((item) => item.id)).toEqual(['nested', 'child', 'root'])
    expect(matchingConversations(all.map((item) => ({ ...item, matchCount: 0 })))).toEqual([])
  })
})
