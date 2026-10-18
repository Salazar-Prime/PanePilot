import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  decodeRemoteScan,
  REMOTE_SCAN_SCRIPT,
  RemoteConversationIndexer
} from '../src/main/remote-conversation-indexer'
import { ConversationIndexer } from '../src/main/conversation-indexer'

describe('remote conversation archive payloads', () => {
  it('matches local subagent identities and project/search scoping using the real host scanner', async () => {
    const remoteHome = mkdtempSync(join(tmpdir(), 'panepilot-remote-subagent-chats-'))
    try {
      const codex = join(remoteHome, '.codex', 'sessions')
      const claude = join(remoteHome, '.claude', 'projects', 'project')
      mkdirSync(codex, { recursive: true })
      mkdirSync(join(claude, 'claude-root', 'subagents'), { recursive: true })
      const codexChat = (id: string, cwd: string, parent?: string) => [
        { type: 'session_meta', timestamp: '2026-10-18T10:00:00Z', payload: { id, cwd, ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_nickname: 'Reviewer' } } } } : {}) } },
        { type: 'event_msg', timestamp: '2026-10-18T09:00:00Z', payload: { type: 'user_message', message: parent ? 'Inherited history' : 'Root task' } },
        { type: 'event_msg', timestamp: '2026-10-18T10:00:01Z', payload: { type: 'user_message', message: parent ? 'Searchneedle review' : 'Normal request' } },
        { type: 'event_msg', timestamp: '2026-10-18T10:00:02Z', payload: { type: 'agent_message', message: 'Result' } }
      ].map((record) => JSON.stringify(record)).join('\n')
      writeFileSync(join(codex, 'root.jsonl'), codexChat('root', '/srv/project'))
      writeFileSync(join(codex, 'child.jsonl'), codexChat('child', '/worktree', 'root'))
      writeFileSync(join(codex, 'nested.jsonl'), codexChat('nested', '/worktree', 'child'))
      writeFileSync(join(codex, 'foreign.jsonl'), codexChat('foreign', '/worktree'))
      const claudeChat = (agentId?: string) => JSON.stringify({ type: 'user', cwd: '/srv/project', sessionId: 'claude-root', agentId, timestamp: '2026-10-18T10:00:00Z', message: { content: agentId ? 'Claude child task' : 'Claude main task' } })
      writeFileSync(join(claude, 'claude-root.jsonl'), claudeChat())
      writeFileSync(join(claude, 'claude-root', 'subagents', 'agent-worker.jsonl'), claudeChat('worker'))
      const encoded = execFileSync('python3', ['-c', REMOTE_SCAN_SCRIPT, Buffer.from(JSON.stringify({ folder: '/srv/project' })).toString('base64')], {
        encoding: 'utf8', env: { ...process.env, HOME: remoteHome }
      }).trim()
      const result = decodeRemoteScan(encoded)
      const remote = new RemoteConversationIndexer()
      const harness = remote as unknown as { scan: () => Promise<typeof result> }
      harness.scan = async () => result
      const local = new ConversationIndexer([{ provider: 'codex', path: codex }, { provider: 'claude', path: claude }])
      const localList = local.list('/srv/project')
      const remoteList = await remote.list('fixture', '/srv/project')
      expect(remoteList.map((chat) => chat.providerSessionId).sort()).toEqual(['child', 'claude-root', 'nested', 'root', 'worker'])
      expect(remoteList.map((chat) => [chat.id, chat.parentProviderSessionId]).sort()).toEqual(localList.map((chat) => [chat.id, chat.parentProviderSessionId]).sort())
      expect((await remote.list('fixture', '/srv/project', 'searchneedle')).map((chat) => chat.providerSessionId).sort()).toEqual(['child', 'nested', 'root'])
      expect((await remote.list('fixture', '/srv/project', 'reviewer')).map((chat) => chat.providerSessionId).sort()).toEqual(['child', 'nested', 'root'])
      expect(local.list('/srv/project', 'reviewer').map((chat) => chat.providerSessionId).sort()).toEqual(['child', 'nested', 'root'])
      const trimmedRemote = await remote.list('fixture', '/srv/project', '', 1)
      const trimmedLocal = local.list('/srv/project', '', 1)
      expect(trimmedRemote.map((chat) => [chat.id, chat.title, chat.snippet]).sort()).toEqual(trimmedLocal.map((chat) => [chat.id, chat.title, chat.snippet]).sort())
      expect(trimmedRemote.find((chat) => chat.providerSessionId === 'child')?.title).toBe('Result')
      expect(remoteList.find((chat) => chat.providerSessionId === 'child')?.snippet).toBe('Searchneedle review')
      expect(localList.find((chat) => chat.providerSessionId === 'child')?.snippet).toBe('Searchneedle review')
      expect(trimmedRemote.find((chat) => chat.providerSessionId === 'child')?.snippet).toBe('Result')
      expect(trimmedLocal.find((chat) => chat.providerSessionId === 'child')?.snippet).toBe('Result')
      expect((await remote.list('fixture', '/srv/project', '', 2)).find((chat) => chat.providerSessionId === 'child')?.snippet).toBe('')
      expect(local.list('/srv/project', '', 2).find((chat) => chat.providerSessionId === 'child')?.snippet).toBe('')
      expect(trimmedRemote.find((chat) => chat.providerSessionId === 'child')?.messageCount).toBe(2)
      expect((await remote.list('fixture', '/srv/project', 'searchneedle', 1)).some((chat) => chat.providerSessionId === 'child')).toBe(true)
      expect((await remote.list('fixture', '/srv/project', '', 100)).every((chat) => chat.snippet === '' && chat.title === 'All messages hidden')).toBe(true)
      const child = remoteList.find((chat) => chat.providerSessionId === 'child')!
      expect((await remote.get('fixture', '/srv/project', child.id)).messages.map((message) => message.content)).toEqual(['Searchneedle review', 'Result'])
      expect(result.codexSessions.map((session) => session.id)).toEqual(['root'])
    } finally { rmSync(remoteHome, { recursive: true, force: true }) }
  })

  it('decodes normalized remote Codex and Claude metadata', () => {
    const payload = {
      conversations: [
        {
          provider: 'codex',
          providerSessionId: 'remote-codex-session',
          title: 'Remote task',
          workingDirectory: '/srv/project',
          updatedAt: '2026-07-23T12:00:00.000Z',
          messages: [
            {
              role: 'user',
              content: 'Inspect the remote service.',
              timestamp: '2026-07-23T12:00:00.000Z'
            }
          ]
        }
      ],
      codexSessions: [
        {
          id: 'remote-codex-session',
          workingDirectory: '/srv/project',
          startedAt: '2026-07-23T12:00:00.000Z'
        }
      ]
    }
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')

    expect(decodeRemoteScan(encoded)).toEqual(payload)
  })

  it('normalizes archives on the remote host before transferring them', () => {
    const remoteHome = mkdtempSync(join(tmpdir(), 'panepilot-remote-home-'))
    try {
      const sessionsDirectory = join(remoteHome, '.codex', 'sessions', '2026', '07')
      mkdirSync(sessionsDirectory, { recursive: true })
      writeFileSync(
        join(sessionsDirectory, 'rollout.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-07-23T12:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'remote-codex-session',
              cwd: '/srv/project',
              timestamp: '2026-07-23T12:00:00.000Z'
            }
          }),
          JSON.stringify({
            timestamp: '2026-07-23T12:00:01.000Z',
            type: 'event_msg',
            payload: { type: 'user_message', message: 'Inspect the remote service.' }
          })
        ].join('\n')
      )
      const params = Buffer.from(
        JSON.stringify({ folder: '/srv/project' }),
        'utf8'
      ).toString('base64')
      const encoded = execFileSync('python3', ['-c', REMOTE_SCAN_SCRIPT, params], {
        encoding: 'utf8',
        env: { ...process.env, HOME: remoteHome }
      }).trim()

      const result = decodeRemoteScan(encoded)
      expect(result.codexSessions[0]?.id).toBe('remote-codex-session')
      expect(result.conversations[0]?.messages[0]?.content).toBe(
        'Inspect the remote service.'
      )
    } finally {
      rmSync(remoteHome, { recursive: true, force: true })
    }
  })

  it.skipIf(
    !process.env.PANEPILOT_TEST_SSH_ALIAS ||
      !process.env.PANEPILOT_TEST_REMOTE_PROJECT
  )('reads normalized conversations from an SSH project', async () => {
    const indexer = new RemoteConversationIndexer()
    const conversations = await indexer.list(
      process.env.PANEPILOT_TEST_SSH_ALIAS!,
      process.env.PANEPILOT_TEST_REMOTE_PROJECT!
    )

    expect(Array.isArray(conversations)).toBe(true)
    expect(
      conversations.every((conversation) =>
        ['codex', 'claude'].includes(conversation.provider)
      )
    ).toBe(true)
  })
})
