import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { statusSessions, statusSessionTab, statusSessionFilters } from '../src/renderer/src/lib/statusSessions'
import type { Project, TerminalSession } from '../src/shared/types'

const session = (id: string, state: TerminalSession['state'], overrides = {}) =>
  ({ id, state, kind: 'terminal', archived: false, ...overrides }) as TerminalSession
const project = (id: string, sessions: TerminalSession[], archived = false) => ({ id, sessions, archived }) as Project

describe('status-bar terminal jump lists', () => {
  it('returns exact terminal/project identities across local and remote projects', () => {
    const projects = [project('local', [session('one', 'running')]), project('remote', [session('two', 'running'), session('three', 'idle')])]
    expect(statusSessions(projects, 'working').map(({ project, session }) => [project.id, session.id])).toEqual([['local', 'one'], ['remote', 'two']])
  })
  it('separates needs-input, blocked, and unread responses without double-counting', () => {
    const projects = [project('p', [session('input', 'needs-input'), session('blocked', 'needs-attention'), session('ready', 'response-ready')])]
    expect(statusSessions(projects, 'attention').map(({ session }) => session.id)).toEqual(['ready'])
    expect(statusSessions(projects, 'needs-input').map(({ session }) => session.id)).toEqual(['input'])
    expect(statusSessions(projects, 'blocked').map(({ session }) => session.id)).toEqual(['blocked'])
  })
  it('hides empty input/blocked indicators and excludes archived rows', () => {
    for (const id of ['needs-input', 'blocked'] as const) {
      expect(statusSessionFilters.find((filter) => filter.id === id)?.hideEmpty).toBe(true)
      const state = id === 'blocked' ? 'needs-attention' : 'needs-input'
      expect(statusSessions([project('p', [session('archived', state, { archived: true })]), project('old', [session('active', state)], true)], id)).toEqual([])
    }
  })
  it('omits archived projects/sessions and retains capability runners in existing counts', () => {
    const projects = [project('archived', [session('old', 'running')], true), project('p', [
      session('archived', 'running', { archived: true }),
      session('action', 'running', { kind: 'action' }),
      session('inline', 'running', { kind: 'latex-chat', latexChat: { purpose: 'inline-edit' } }),
      session('writing', 'running', { kind: 'latex-chat', latexChat: { purpose: 'writing' } })
    ])]
    expect(statusSessions(projects, 'working').map(({ session }) => session.id)).toEqual(['action', 'inline', 'writing'])
  })
  it('routes capability runners to their own UI, never to ordinary terminal tabs', () => {
    expect(statusSessionTab(session('a', 'running', { kind: 'action' }))).toBe('actions')
    expect(statusSessionTab(session('q', 'running', { kind: 'project-qna' }))).toBe('qna')
    expect(statusSessionTab(session('i', 'running', { kind: 'latex-chat', latexChat: { purpose: 'inline-edit' } }))).toBe('manuscript')
    expect(statusSessionTab(session('normal', 'running'))).toBeNull()
  })
  it('passes one-shot exact-session requests through both workspaces and never acknowledges another terminal', () => {
    const app = readFileSync('src/renderer/src/components/App.tsx', 'utf8')
    const route = app.slice(app.indexOf('  function openStatusSession('), app.indexOf('  const typeDefinition'))
    expect(route).toContain('selectSession(projectId, sessionId)')
    expect(route).toContain('initialSessionId: sessionId')
    expect(route).toContain('nextWorkspaceTabRequest(projectId, pane, tab), sessionId')
    expect(route).not.toContain('selectProject(')
    expect(route).not.toContain('acknowledgeSession(')
    for (const workspace of ['TerminalProjectWorkspace', 'LatexProjectWorkspace']) {
      const source = readFileSync(`src/renderer/src/components/${workspace}.tsx`, 'utf8')
      expect(source).toContain('sessionRequest={actionSessionRequest}')
      expect(source).toContain('sessionId: workspaceTabRequest.sessionId')
      expect(source).toContain('onWorkspaceTabRequestHandled(workspaceTabRequest.id)')
    }
  })
})
