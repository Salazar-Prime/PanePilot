import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ConversationIndexer,
  parseClaudeConversation,
  parseCodexConversation
} from '../src/main/conversation-indexer'

describe('conversation archive parsing', () => {
  it('keeps explicit Codex parent identity and excludes inherited messages and reasoning', () => {
    const source = [
      { type: 'session_meta', timestamp: '2026-10-18T10:00:00Z', payload: { id: 'child', cwd: '/project', source: { subagent: { thread_spawn: { parent_thread_id: 'root', agent_nickname: 'Reviewer', agent_path: '/root/collage_resources' } } } } },
      { type: 'event_msg', timestamp: '2026-10-18T09:00:00Z', payload: { type: 'user_message', message: 'Inherited parent history' } },
      { type: 'response_item', timestamp: '2026-10-18T10:00:01Z', payload: { type: 'message', role: 'assistant', phase: 'analysis', content: 'Hidden reasoning' } },
      { type: 'response_item', timestamp: '2026-10-18T10:00:02Z', payload: { type: 'message', role: 'user', content: 'Review the tests' } },
      { type: 'response_item', timestamp: '2026-10-18T10:00:03Z', payload: { type: 'message', role: 'assistant', content: 'Tests look good' } }
    ].map((record) => JSON.stringify(record)).join('\n')
    const parsed = parseCodexConversation('/tmp/child.jsonl', source, '2026-10-18T10:00:00Z')!
    expect(parsed.parentProviderSessionId).toBe('root')
    expect(parsed.agentName).toBe('Reviewer')
    expect(parsed.agentPath).toBe('/root/collage_resources')
    expect(parsed.messages.map((message) => message.content)).toEqual(['Review the tests', 'Tests look good'])
  })

  it('gives Claude subagents their own identities instead of reusing the parent session ID', () => {
    const source = JSON.stringify({ type: 'user', cwd: '/project', sessionId: 'root', agentId: 'worker', message: { content: 'Review tests' } })
    const parent = parseClaudeConversation('/tmp/root.jsonl', source, '2026-10-18T10:00:00Z')!
    const child = parseClaudeConversation('/tmp/root/subagents/agent-worker.jsonl', source, '2026-10-18T10:00:00Z')!
    expect(child.id).not.toBe(parent.id)
    expect(child.providerSessionId).toBe('worker')
    expect(child.parentProviderSessionId).toBe('root')
    expect(parent.parentProviderSessionId).toBeNull()
    expect(child.agentPath).toBeNull()
  })

  it('recognizes own-path agent messages without treating other agents as the child', () => {
    const source = [
      { type: 'session_meta', timestamp: '2026-10-18T10:00:00Z', payload: { id: 'child', cwd: '/project', thread_source: 'subagent', parent_thread_id: 'root', agent_path: '/root/reviewer' } },
      { type: 'response_item', timestamp: '2026-10-18T10:00:01Z', payload: { type: 'agent_message', author: '/root', content: 'Parent output' } },
      { type: 'response_item', timestamp: '2026-10-18T10:00:02Z', payload: { type: 'agent_message', author: '/root/reviewer', content: 'Own output' } }
    ].map((record) => JSON.stringify(record)).join('\n')
    expect(parseCodexConversation('/tmp/child.jsonl', source, '')?.messages.map((message) => message.content)).toEqual(['Own output'])
    expect(parseCodexConversation('/tmp/child.jsonl', source, '')?.agentPath).toBe('/root/reviewer')
  })

  it('lists and opens worktree subagents, keeps search ancestry, and enforces project scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-conversation-tree-'))
    try {
      const codex = join(root, 'codex')
      mkdirSync(codex)
      const write = (id: string, cwd: string, parent?: string) => writeFileSync(join(codex, `${id}.jsonl`), [
        JSON.stringify({ type: 'session_meta', timestamp: '2026-10-18T10:00:00Z', payload: { id, cwd, ...(parent ? { thread_source: 'subagent', parent_thread_id: parent } : {}) } }),
        JSON.stringify({ type: 'event_msg', timestamp: '2026-10-18T10:00:01Z', payload: { type: 'user_message', message: id === 'child' ? 'Searchneedle findings' : 'Ordinary task' } })
      ].join('\n'))
      write('root', '/project')
      write('child', '/worktree', 'root')
      write('unrelated', '/worktree')
      const indexer = new ConversationIndexer([{ provider: 'codex', path: codex }])
      const list = indexer.list('/project')
      expect(list.map((item) => item.providerSessionId).sort()).toEqual(['child', 'root'])
      expect(indexer.list('/project', 'searchneedle').map((item) => item.providerSessionId).sort()).toEqual(['child', 'root'])
      const child = list.find((item) => item.providerSessionId === 'child')!
      expect(indexer.get('/project', child.id).messages[0].content).toBe('Searchneedle findings')
      expect(() => indexer.get('/unrelated', child.id)).toThrow('not found')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('normalizes Codex user and assistant messages', () => {
    const source = [
      JSON.stringify({
        timestamp: '2026-07-23T12:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-session', cwd: '/tmp/panepilot-project' }
      }),
      JSON.stringify({
        timestamp: '2026-07-23T12:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Fix the terminal menu' }
      }),
      JSON.stringify({
        timestamp: '2026-07-23T12:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'I moved it into a portal.' }
      })
    ].join('\n')

    const conversation = parseCodexConversation(
      '/tmp/codex.jsonl',
      source,
      '2026-07-23T12:00:00.000Z'
    )

    expect(conversation?.workingDirectory).toBe('/tmp/panepilot-project')
    expect(conversation?.providerSessionId).toBe('codex-session')
    expect(conversation?.title).toBe('Fix the terminal menu')
    expect(conversation?.messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: 'Fix the terminal menu' },
      { role: 'assistant', content: 'I moved it into a portal.' }
    ])
  })

  it('normalizes Claude content blocks and summary titles', () => {
    const source = [
      JSON.stringify({
        type: 'summary',
        summary: 'Remote file editing',
        cwd: '/tmp/panepilot-project',
        sessionId: 'claude-session'
      }),
      JSON.stringify({
        type: 'user',
        cwd: '/tmp/panepilot-project',
        sessionId: 'claude-session',
        timestamp: '2026-07-23T13:00:00.000Z',
        message: { content: [{ type: 'text', text: 'Browse the server.' }] }
      }),
      JSON.stringify({
        type: 'assistant',
        cwd: '/tmp/panepilot-project',
        sessionId: 'claude-session',
        timestamp: '2026-07-23T13:00:01.000Z',
        message: { content: [{ type: 'text', text: 'The browser is ready.' }] }
      })
    ].join('\n')

    const conversation = parseClaudeConversation(
      '/tmp/claude.jsonl',
      source,
      '2026-07-23T13:00:00.000Z'
    )

    expect(conversation?.title).toBe('Remote file editing')
    expect(conversation?.providerSessionId).toBe('claude-session')
    expect(conversation?.messages).toHaveLength(2)
    expect(conversation?.messages[1].content).toBe('The browser is ready.')
  })
})
