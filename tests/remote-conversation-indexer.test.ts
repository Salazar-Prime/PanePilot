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

describe('remote conversation archive payloads', () => {
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
