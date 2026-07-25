import { describe, expect, it } from 'vitest'
import type { Project, TerminalSession } from '../src/shared/types'
import { shouldOfferTmuxReconnect } from '../src/renderer/src/lib/terminalTransport'

const session: TerminalSession = {
  id: 'session',
  projectId: 'project',
  kind: 'terminal',
  name: 'Main',
  profile: 'shell',
  providerSessionId: null,
  providerSessionName: null,
  customCommand: null,
  backend: 'tmux',
  tmuxName: 'Main',
  state: 'idle',
  dangerousMode: false,
  archived: false,
  pinned: false,
  flagged: false,
  output: '',
  latexChat: null,
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z'
}

const project: Project = {
  id: 'project',
  type: 'terminal',
  name: 'Project',
  connectionId: 'ssh:remote',
  folder: '/project',
  repositoryUrl: null,
  latex: null,
  state: 'idle',
  archived: false,
  createdAt: '2026-07-25T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
  sessions: [session],
  actions: [],
  activities: []
}

describe('tmux reconnect visibility', () => {
  it('shows only for disconnected transport states', () => {
    expect(shouldOfferTmuxReconnect(project, session, 'attached')).toBe(false)
    expect(shouldOfferTmuxReconnect(project, session, 'reconnecting')).toBe(false)
    expect(shouldOfferTmuxReconnect(project, session, 'detached')).toBe(true)
    expect(shouldOfferTmuxReconnect(project, session, 'offline')).toBe(true)
  })

  it('recovers legacy sessions that were completed after tmux disappeared', () => {
    const completed = { ...session, state: 'completed' as const }
    const missingProject = {
      ...project,
      sessions: [completed],
      activities: [
        {
          id: 'activity',
          projectId: project.id,
          sessionId: completed.id,
          kind: 'state-changed',
          message: 'Main is no longer running in tmux.',
          createdAt: '2026-07-25T01:00:00.000Z'
        }
      ]
    }

    expect(shouldOfferTmuxReconnect(missingProject, completed)).toBe(true)
    expect(
      shouldOfferTmuxReconnect(
        {
          ...missingProject,
          activities: [
            {
              ...missingProject.activities[0],
              message: 'Main was stopped.'
            }
          ]
        },
        completed
      )
    ).toBe(false)
  })
})
