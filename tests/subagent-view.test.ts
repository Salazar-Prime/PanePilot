import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Project, TerminalSession } from '../src/shared/types'
import type { WorkspaceDestination } from '../src/renderer/src/lib/workspaceHistory'
import { visibleCodexSession } from '../src/renderer/src/lib/subagents'

const session = { id: 'chat', projectId: 'p', kind: 'terminal', profile: 'codex', archived: false } as TerminalSession
const project = { id: 'p', sessions: [session], archived: false } as Project
const destination = { key: 'chat', projectId: 'p', sessionId: 'chat', tab: 'terminal' } as WorkspaceDestination

describe('sub-agent view scope', () => {
  it('requires the exact selected, visible Codex terminal', () => {
    expect(visibleCodexSession(project, destination, session.id)).toBe(session)
    expect(visibleCodexSession(project, destination, 'other')).toBeNull()
    expect(visibleCodexSession(project, null, session.id)).toBeNull()
    expect(visibleCodexSession(project, { ...destination, projectId: 'other' }, session.id)).toBeNull()
  })
  it('never falls back to a remembered terminal behind Files, Notes, or other capabilities', () => {
    for (const tab of ['files', 'notes', 'actions', 'activity'] as const) {
      expect(visibleCodexSession(project, { ...destination, tab, sessionId: null }, session.id)).toBeNull()
    }
  })
  it('rejects other providers, archived chats, and hidden runners', () => {
    for (const change of [{ profile: 'claude' }, { archived: true }, { kind: 'temporary-chat' }, { kind: 'latex-chat', latexChat: { purpose: 'inline-edit' } }]) {
      expect(visibleCodexSession({ ...project, sessions: [{ ...session, ...change } as TerminalSession] }, destination, session.id)).toBeNull()
    }
    expect(visibleCodexSession({ ...project, archived: true }, destination, session.id)).toBeNull()
  })
  it('supports visible LaTeX writing chats', () => {
    const chat = { ...session, kind: 'latex-chat', latexChat: { purpose: 'writing' } } as TerminalSession
    expect(visibleCodexSession({ ...project, sessions: [chat] }, destination, session.id)).toBe(chat)
  })
  it('replaces the readability menu while retaining existing scale, and gates the overlay', () => {
    const app = readFileSync('src/renderer/src/components/App.tsx', 'utf8')
    expect(app).not.toContain('AppearanceControl')
    expect(app).toContain('useAppearanceScale()')
    expect(app).toContain('subagentSessionId === subagentSession.id')
    expect(app).toContain('[subagentSession?.id, focusedPane]')
    expect(app).toContain('setVisibleDestinations')
  })
})
