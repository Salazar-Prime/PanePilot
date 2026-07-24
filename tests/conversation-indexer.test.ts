import { describe, expect, it } from 'vitest'
import {
  parseClaudeConversation,
  parseCodexConversation
} from '../src/main/conversation-indexer'

describe('conversation archive parsing', () => {
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
