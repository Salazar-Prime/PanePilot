import { afterEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationIndexer } from '../src/main/conversation-indexer'

const fixtures: string[] = []
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture(options = { maxDetailBytes: 8 * 1024, maxDetailEntries: 2 }) {
  const root = mkdtempSync(join(tmpdir(), 'panepilot-archive-cache-')); fixtures.push(root)
  const archive = join(root, 'sessions'); mkdirSync(archive)
  const write = (id: string, content: string, cwd = '/project', parent?: string) => {
    const path = join(archive, `${id}.jsonl`)
    writeFileSync(path, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-10-18T10:00:00Z', payload: { id, cwd,
        ...(parent ? { thread_source: 'subagent', parent_thread_id: parent } : {}) } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-10-18T10:00:01Z', payload: { type: 'user_message', message: content } })
    ].join('\n') + '\n')
    return path
  }
  return { root, archive, write, indexer: new ConversationIndexer([{ provider: 'codex', path: archive }], options) }
}

describe('bounded conversation catalog', () => {
  it('keeps complete search and lazy detail while bounding retained transcripts across projects', () => {
    const { indexer, write } = fixture()
    for (let i = 0; i < 30; i++) write(`thread-${i}`, `${i} exactneedle ${'x'.repeat(900)}`, i % 2 ? '/other' : '/project')
    const list = indexer.list('/project')
    expect(list).toHaveLength(15)
    expect(indexer.list('/project', 'exactneedle')).toHaveLength(15)
    for (const item of list) expect(indexer.get('/project', item.id).messages[0].content).toContain('exactneedle')
    const stats = indexer.diagnostics()
    expect(stats.catalogFiles).toBe(30)
    expect(stats.detailEntries).toBeLessThanOrEqual(2)
    expect(stats.detailBytes).toBeLessThanOrEqual(8 * 1024)
  })

  it('returns oversized transcripts without retaining them or truncating search', () => {
    const { indexer, write } = fixture({ maxDetailBytes: 1024, maxDetailEntries: 2 })
    const content = `${'x'.repeat(64 * 1024)} final-search-needle`
    write('large', content)
    const [item] = indexer.list('/project', 'final-search-needle')
    expect(indexer.get('/project', item.id).messages[0].content).toBe(content)
    expect(indexer.diagnostics().detailEntries).toBe(0)
    expect(indexer.diagnostics().detailBytes).toBe(0)
  })

  it('invalidates append, truncation, same-size replacement and deletion', async () => {
    const { indexer, write } = fixture()
    const path = write('thread', 'first text')
    const [item] = indexer.list('/project')
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'second reply' } }) + '\n')
    expect(indexer.get('/project', item.id).messages).toHaveLength(2)
    write('thread', 'third text')
    expect(indexer.get('/project', item.id).messages.map(m => m.content)).toEqual(['third text'])
    const previous = statSync(path)
    await new Promise(resolve => setTimeout(resolve, 5))
    write('thread', 'final text')
    utimesSync(path, previous.atime, previous.mtime)
    expect(statSync(path).size).toBe(previous.size)
    expect(indexer.get('/project', item.id).messages[0].content).toBe('final text')
    const replacement = write('replacement', 'replaced')
    renameSync(replacement, path)
    expect(indexer.list('/project')[0].providerSessionId).toBe('replacement')
    expect(() => indexer.get('/project', item.id)).toThrow('not found')
    rmSync(path)
    expect(indexer.list('/project')).toEqual([])
    expect(indexer.diagnostics().catalogFiles).toBe(0)
    expect(indexer.diagnostics().detailBytes).toBe(0)
  })

  it('keeps descendant scope, hidden-message presentation, and complete hidden-text search', () => {
    const { indexer, write } = fixture()
    write('parent', 'parent task')
    const childPath = write('child', 'hidden needle', '/worktree', 'parent')
    appendFileSync(childPath, JSON.stringify({ type: 'event_msg', timestamp: '2026-10-18T10:00:02Z',
      payload: { type: 'agent_message', message: 'retained text' } }) + '\n')
    write('unrelated', 'hidden needle', '/worktree')
    const list = indexer.list('/project', 'needle', 1)
    expect(list.map(item => item.providerSessionId).sort()).toEqual(['child', 'parent'])
    const child = list.find(item => item.providerSessionId === 'child')!
    expect(child.title).toBe('retained text')
    expect(child.snippet).toBe('retained text')
    expect(child.messageCount).toBe(2)
    expect(indexer.get('/project', child.id).messages).toHaveLength(2)
    expect(() => indexer.get('/unrelated', child.id)).toThrow('not found')
  })

  it('resolves exact provider identities using configured archives only', () => {
    const { indexer, write, root } = fixture()
    write('exact-thread', 'message')
    writeFileSync(join(root, 'session_index.jsonl'), JSON.stringify({ id: 'exact-thread', thread_name: 'named-session' }))
    expect(indexer.findProviderSessionId('codex', '/project', '2026-10-18T10:00:00Z', new Set(), 'exact-thread')).toBe('exact-thread')
    expect(indexer.findProviderSessionId('codex', '/project', '2026-10-18T10:00:00Z', new Set(), 'named-session')).toBe('exact-thread')
    expect(indexer.findProviderSessionId('codex', '/project', '2026-10-18T10:00:00Z', new Set(['exact-thread']), 'exact-thread')).toBeNull()
    expect(indexer.findProviderSessionId('codex', '/another', '2026-10-18T10:00:00Z', new Set(), 'exact-thread')).toBeNull()
  })

  it('does not import another folder archive merely because a provider ID was copied', () => {
    const { indexer, write, archive } = fixture()
    write('duplicated-id', 'project transcript')
    writeFileSync(join(archive, 'copied.jsonl'), [
      JSON.stringify({ type: 'session_meta', payload: { id: 'duplicated-id', cwd: '/other' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'unrelated copy' } })
    ].join('\n'))
    const list = indexer.list('/project')
    expect(list).toHaveLength(1)
    expect(indexer.get('/project', list[0].id).messages[0].content).toBe('project transcript')
  })
})
