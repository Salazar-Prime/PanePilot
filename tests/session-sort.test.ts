import { describe, expect, it } from 'vitest'
import type { TerminalSession } from '../src/shared/types'
import { sortSessions } from '../src/renderer/src/lib/sessionSort'

function session(
  name: string,
  createdAt: string,
  pinned = false,
  state: TerminalSession['state'] = 'idle'
): TerminalSession {
  return {
    id: name,
    projectId: 'project',
    kind: 'terminal',
    name,
    profile: 'codex',
    providerSessionId: null,
    providerSessionName: null,
    customCommand: null,
    backend: 'tmux',
    tmuxName: name,
    state,
    dangerousMode: false,
    archived: false,
    pinned,
    flagged: false,
    output: '',
    latexChat: null,
    createdAt,
    updatedAt: createdAt
  }
}

describe('session sorting', () => {
  const older = session('Alpha', '2026-01-01T00:00:00.000Z')
  const newer = session('Zulu', '2026-02-01T00:00:00.000Z')

  it('keeps pinned sessions first and otherwise sorts newest first', () => {
    const pinned = session('Pinned', '2025-01-01T00:00:00.000Z', true)
    expect(sortSessions([older, pinned, newer], 'recent').map((item) => item.name)).toEqual([
      'Pinned',
      'Zulu',
      'Alpha'
    ])
  })

  it('supports name, oldest, and attention ordering', () => {
    expect(sortSessions([newer, older], 'name').map((item) => item.name)).toEqual([
      'Alpha',
      'Zulu'
    ])
    expect(sortSessions([newer, older], 'oldest').map((item) => item.name)).toEqual([
      'Alpha',
      'Zulu'
    ])
    const attention = session(
      'Question',
      '2025-01-01T00:00:00.000Z',
      false,
      'needs-input'
    )
    expect(
      sortSessions([newer, attention], 'attention').map((item) => item.name)
    ).toEqual(['Question', 'Zulu'])
  })
})
