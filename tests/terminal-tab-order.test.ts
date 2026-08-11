import { describe, expect, it } from 'vitest'
import type { TerminalSession } from '../src/shared/types'
import {
  clampTerminalTabDrop,
  moveTerminalTab,
  orderTerminalTabs
} from '../src/renderer/src/lib/terminalTabOrder'

function session(id: string, pinned = false): TerminalSession {
  return {
    id,
    projectId: 'project',
    kind: 'terminal',
    name: id,
    profile: 'shell',
    providerSessionId: null,
    providerSessionName: null,
    customCommand: null,
    backend: 'tmux',
    tmuxName: id,
    state: 'idle',
    dangerousMode: false,
    archived: false,
    pinned,
    flagged: false,
    output: '',
    latexChat: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('terminal tab drag ordering', () => {
  it('restores manual order while keeping pinned tabs at the left', () => {
    const sessions = [session('alpha'), session('bravo', true), session('charlie')]
    expect(
      orderTerminalTabs(sessions, ['charlie', 'alpha', 'bravo']).map(
        (item) => item.id
      )
    ).toEqual(['bravo', 'charlie', 'alpha'])
  })

  it('moves tabs at the requested edge and clamps them to their pin group', () => {
    expect(
      moveTerminalTab(
        ['pin', 'alpha', 'bravo'],
        'bravo',
        'alpha',
        'before',
        new Set(['pin'])
      )
    ).toEqual(['pin', 'bravo', 'alpha'])
    expect(
      moveTerminalTab(
        ['pin', 'alpha', 'bravo'],
        'bravo',
        'pin',
        'before',
        new Set(['pin'])
      )
    ).toEqual(['pin', 'bravo', 'alpha'])
    expect(
      clampTerminalTabDrop(
        ['pin', 'alpha', 'bravo'],
        'bravo',
        'pin',
        'before',
        new Set(['pin'])
      )
    ).toEqual({ targetId: 'alpha', edge: 'before' })
  })
})
