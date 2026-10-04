import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexSubagentReader, descendantHeaders, parseSubagent, REMOTE_SUBAGENT_SCRIPT, subagentHeader } from '../src/main/codex-subagents'

const start = '2026-10-04T10:00:00.000Z'
const now = '2026-10-04T10:01:00.000Z'
const record = (type: string, payload: object, timestamp = now) => JSON.stringify({ type, payload, timestamp })
function meta(id: string, parent?: string, extra = {}) {
  return record('session_meta', {
    id, cwd: '/project', timestamp: start,
    ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_path: `/root/${id}`, agent_nickname: id } } } } : {}),
    ...extra
  }, start)
}
const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'panepilot-subagents-'))
  roots.push(root)
  const sessions = join(root, 'sessions')
  mkdirSync(sessions)
  const write = (id: string, lines: string[]) => writeFileSync(join(sessions, `${id}.jsonl`), lines.join('\n') + '\n')
  write('root', [meta('root')])
  write('first', [meta('first', 'root'), record('event_msg', { type: 'task_started' }), record('event_msg', { type: 'agent_message', message: 'Own output' })])
  write('nested', [meta('nested', 'first'), record('event_msg', { type: 'task_complete', last_agent_message: 'Nested result' })])
  write('other', [meta('other', 'unrelated'), record('event_msg', { type: 'agent_message', message: 'Unrelated output' })])
  write('fork', [meta('fork', undefined, { forked_from_id: 'root' })])
  return { root, sessions, write }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('exact Codex sub-agent relationships', () => {
  it('accepts nested and top-level metadata without confusing session_id with the child id', () => {
    expect(subagentHeader(meta('child', 'root', { session_id: 'root' }))?.id).toBe('child')
    expect(subagentHeader(meta('child', undefined, { thread_source: 'subagent', parent_thread_id: 'root' }))?.parentId).toBe('root')
    expect(subagentHeader(meta('fork', undefined, { forked_from_id: 'root' }))?.parentId).toBeNull()
    expect(subagentHeader('{partial')).toBeNull()
  })
  it('includes nested descendants but not same-folder siblings or ordinary forks', () => {
    const headers = [meta('nested', 'child'), meta('child', 'root'), meta('root'), meta('other', 'unrelated'), meta('fork', undefined, { forked_from_id: 'root' })].map((m) => subagentHeader(m)!)
    expect(descendantHeaders(headers, 'root').map((h) => h.id).sort()).toEqual(['child', 'nested'])
  })
  it('terminates even for corrupt cyclic parent links', () => {
    expect(descendantHeaders([subagentHeader(meta('root', 'child'))!, subagentHeader(meta('child', 'root'))!], 'root')).toHaveLength(1)
  })
})

describe('public output parsing', () => {
  const parse = (lines: string[]) => parseSubagent({ header: subagentHeader(meta('child', 'root'))!, tail: lines.join('\n'), updatedAt: now, truncated: false })
  it('shows messages and tool I/O, excludes reasoning, inputs, and inherited history', () => {
    const result = parse([
      record('response_item', { type: 'message', role: 'assistant', content: 'Inherited' }, '2026-10-04T09:00:00Z'),
      record('response_item', { type: 'reasoning', summary: 'Hidden reasoning', encrypted_content: 'secret' }),
      record('response_item', { type: 'message', role: 'assistant', phase: 'analysis', content: 'Hidden analysis' }),
      record('response_item', { type: 'message', role: 'user', content: 'Private context' }),
      record('event_msg', { type: 'task_started' }),
      record('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Progress' }, { type: 'encrypted_content', text: 'secret' }] }),
      record('event_msg', { type: 'agent_message', message: 'Progress' }),
      record('response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}' }),
      record('response_item', { type: 'function_call_output', output: 'Tests passed' }),
      record('response_item', { type: 'agent_message', author: '/root/child', content: 'Reported result' }),
      record('response_item', { type: 'agent_message', author: '/root', content: 'Not this agent' }),
      '{partial', 'null', '42', '[]'
    ])
    expect(result.state).toBe('working')
    expect(result.output.map((o) => o.text)).toEqual(['Progress', 'exec_command\n{"cmd":"npm test"}', 'Tests passed', 'Reported result'])
  })
  it('uses explicit lifecycle events, including resumed agents', () => {
    expect(parse([record('event_msg', { type: 'task_complete', last_agent_message: 'Done' })]).state).toBe('finished')
    expect(parse([record('event_msg', { type: 'turn_aborted' })]).state).toBe('stopped')
    expect(parse([record('event_msg', { type: 'task_complete' }), record('event_msg', { type: 'task_started' })]).state).toBe('working')
    expect(parse([]).state).toBe('unknown')
  })
  it('bounds message sizes and card history', () => {
    const result = parse(Array.from({ length: 80 }, (_, i) => record('event_msg', { type: 'agent_message', message: `${i} ${'x'.repeat(10_000)}` })))
    expect(result.output).toHaveLength(60)
    expect(result.output[0].text.startsWith('20 ')).toBe(true)
    expect(result.output[0].text.length).toBeLessThan(8100)
    expect(result.truncated).toBe(true)
  })
})

describe('bounded local and SSH-host reads', () => {
  it('reads only exact descendants, and rejects a root in another project', async () => {
    const f = fixture()
    const reader = new CodexSubagentReader(f.sessions)
    const result = await reader.read('root', '/project')
    expect(result.rootFound).toBe(true)
    expect(result.agents.map((a) => a.id).sort()).toEqual(['first', 'nested'])
    expect(result.agents.find((a) => a.id === 'first')?.output[0].text).toBe('Own output')
    expect((await reader.read('root', '/other-project')).rootFound).toBe(false)
    expect((await reader.read('missing-root', '/project')).agents).toEqual([])
  })
  it('coalesces reads and caches without a background watcher', async () => {
    const f = fixture()
    const reader = new CodexSubagentReader(f.sessions)
    const [a, b] = await Promise.all([reader.read('root', '/project'), reader.read('root', '/project')])
    expect(a).toBe(b)
    expect(await reader.read('root', '/project')).toBe(a)
  })
  it('handles partial writes and reads new output on a later read', async () => {
    const f = fixture()
    appendFileSync(join(f.sessions, 'first.jsonl'), '{partial')
    expect((await new CodexSubagentReader(f.sessions).read('root', '/project')).agents).toHaveLength(2)
    f.write('first', [meta('first', 'root'), record('event_msg', { type: 'task_complete', last_agent_message: 'New result' })])
    expect((await new CodexSubagentReader(f.sessions).read('root', '/project')).agents.find((a) => a.id === 'first')?.state).toBe('finished')
  })
  it('caps the agent count with an explicit limited flag', async () => {
    const f = fixture()
    for (let i = 0; i < 30; i++) f.write(`extra-${i}`, [meta(`extra-${i}`, 'root')])
    const result = await new CodexSubagentReader(f.sessions).read('root', '/project')
    expect(result.agents).toHaveLength(24)
    expect(result.total).toBe(32)
    expect(result.limited).toBe(true)
  })
  it('runs the real SSH Python scanner against isolated archives and matches local output', async () => {
    const f = fixture()
    const params = Buffer.from(JSON.stringify({ rootId: 'root', folder: '/project' })).toString('base64')
    const encoded = execFileSync('python3', ['-c', REMOTE_SUBAGENT_SCRIPT, params], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: f.root } })
    const remote = JSON.parse(Buffer.from(encoded.trim(), 'base64').toString('utf8'))
    const local = await new CodexSubagentReader(f.sessions).read('root', '/project')
    expect(remote.rootFound).toBe(true)
    expect(remote.entries.map(parseSubagent).map((a: { id: string }) => a.id).sort()).toEqual(local.agents.map((a) => a.id).sort())
    expect(remote.entries.map(parseSubagent).find((a: { id: string }) => a.id === 'nested').output[0].text).toBe('Nested result')
  })
  it('includes worktree descendants through explicit parent links, not cwd matching', async () => {
    const f = fixture()
    f.write('worktree', [meta('worktree', 'root', { cwd: '/another/worktree' })])
    expect((await new CodexSubagentReader(f.sessions).read('root', '/project')).agents.map((a) => a.id)).toContain('worktree')
  })
  it('marks bounded tails and keeps the latest output', async () => {
    const f = fixture()
    f.write('first', [meta('first', 'root'), record('response_item', { type: 'reasoning', encrypted_content: 'x'.repeat(300_000) }), record('event_msg', { type: 'task_complete', last_agent_message: 'Final output' })])
    const agent = (await new CodexSubagentReader(f.sessions).read('root', '/project')).agents.find((a) => a.id === 'first')!
    expect(agent.truncated).toBe(true)
    expect(agent.output[0].text).toBe('Final output')
  })
})
