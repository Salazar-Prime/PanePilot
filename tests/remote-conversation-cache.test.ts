import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_SCAN_SCRIPT,
  RemoteConversationIndexer
} from '../src/main/remote-conversation-indexer'

const NOW = '2026-10-29T12:00:00.000Z'
const EXACT_ID = '4b1986fe-1e49-4e30-8000-a936e7d7ac6a'

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

function scanPayload(folder: string, content = 'Complete remote transcript', id = EXACT_ID) {
  return {
    conversations: [{
      provider: 'claude',
      providerSessionId: id,
      title: 'Remote task',
      workingDirectory: folder,
      updatedAt: NOW,
      messages: [
        { role: 'user', content: 'Review this project.', timestamp: NOW },
        { role: 'assistant', content, timestamp: NOW }
      ]
    }],
    codexSessions: []
  }
}

function codexPayload(folder: string) {
  return [{ id: EXACT_ID, workingDirectory: folder, startedAt: NOW }]
}

function conversationId(id = EXACT_ID): string {
  return createHash('sha256').update(`claude:${id}`).digest('hex').slice(0, 24)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function cacheState(indexer: RemoteConversationIndexer) {
  return indexer as unknown as { cache: Map<string, unknown>; retainedCacheBytes: number }
}

function fixtureExecutor() {
  return vi.fn(async (_alias: string, script: string, folder: string) =>
    encode(script === REMOTE_SCAN_SCRIPT ? scanPayload(folder) : codexPayload(folder))
  )
}

describe('bounded remote conversation cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
  })

  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('returns complete oversized transcripts and exact provider IDs without retaining them', async () => {
    const content = 'Remote text with Unicode 🧪 and a final exact marker.\n'.repeat(2_000)
    const executeRemoteScript = vi.fn(async (_alias: string, _script: string, folder: string) =>
      encode(scanPayload(folder, content))
    )
    const indexer = new RemoteConversationIndexer({ executeRemoteScript, cacheMaxBytes: 128 })
    const [summary] = await indexer.list('fixture', '/srv/project')
    expect(summary.providerSessionId).toBe(EXACT_ID)
    const detail = await indexer.get('fixture', '/srv/project', summary.id)
    expect(detail.messages.map((message) => message.content)).toEqual(['Review this project.', content])
    expect(await indexer.findProviderSessionId('claude', 'fixture', '/srv/project', NOW, new Set())).toBe(EXACT_ID)
    expect(executeRemoteScript).toHaveBeenCalledTimes(3)
    expect(cacheState(indexer).cache.size).toBe(0)
    expect(cacheState(indexer).retainedCacheBytes).toBe(0)
  })

  it('shares one LRU entry limit between transcript scans and Codex identity lookups', async () => {
    const executeRemoteScript = fixtureExecutor()
    const indexer = new RemoteConversationIndexer({ executeRemoteScript, cacheMaxEntries: 2 })
    await indexer.list('fixture', '/srv/a')
    expect(await indexer.findCodexSessionId('fixture', '/srv/a', NOW, new Set(), EXACT_ID.slice(0, 12))).toBe(EXACT_ID)
    expect(cacheState(indexer).cache.size).toBe(2)
    await indexer.list('fixture', '/srv/a') // Touch the scan, leaving the Codex entry oldest.
    await indexer.list('fixture', '/srv/b')
    await indexer.list('fixture', '/srv/a')
    expect(executeRemoteScript).toHaveBeenCalledTimes(3)
    await indexer.findCodexSessionId('fixture', '/srv/a', NOW, new Set(), EXACT_ID)
    expect(executeRemoteScript).toHaveBeenCalledTimes(4)
    expect(executeRemoteScript.mock.calls.map((call) => call[1] === REMOTE_SCAN_SCRIPT ? 'scan' : 'sessions')).toEqual([
      'scan', 'sessions', 'scan', 'sessions'
    ])
    expect(cacheState(indexer).cache.size).toBe(2)
  })

  it('evicts retained payloads by their estimated byte cost before reaching the entry limit', async () => {
    const executeRemoteScript = fixtureExecutor()
    const probe = new RemoteConversationIndexer({ executeRemoteScript })
    await probe.list('fixture', '/srv/a')
    const oneEntryBytes = cacheState(probe).retainedCacheBytes
    expect(oneEntryBytes).toBeGreaterThan(0)
    const indexer = new RemoteConversationIndexer({
      executeRemoteScript,
      cacheMaxEntries: 10,
      cacheMaxBytes: oneEntryBytes + 1
    })
    await indexer.list('fixture', '/srv/a')
    await indexer.list('fixture', '/srv/b')
    expect(cacheState(indexer).cache.size).toBe(1)
    expect(cacheState(indexer).retainedCacheBytes).toBeLessThanOrEqual(oneEntryBytes + 1)
    const callsBeforeHit = executeRemoteScript.mock.calls.length
    await indexer.list('fixture', '/srv/b')
    expect(executeRemoteScript).toHaveBeenCalledTimes(callsBeforeHit)
    await indexer.list('fixture', '/srv/a')
    expect(executeRemoteScript).toHaveBeenCalledTimes(callsBeforeHit + 1)
  })

  it('physically releases Codex and transcript cache references at their different TTLs without another request', async () => {
    const executeRemoteScript = fixtureExecutor()
    const indexer = new RemoteConversationIndexer({ executeRemoteScript })
    await indexer.list('fixture', '/srv/a')
    await indexer.findCodexSessionId('fixture', '/srv/a', NOW, new Set(), EXACT_ID)
    const bothBytes = cacheState(indexer).retainedCacheBytes
    expect(cacheState(indexer).cache.size).toBe(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(cacheState(indexer).cache.size).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(cacheState(indexer).cache.size).toBe(1)
    expect(cacheState(indexer).retainedCacheBytes).toBeGreaterThan(0)
    expect(cacheState(indexer).retainedCacheBytes).toBeLessThan(bothBytes)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(cacheState(indexer).cache.size).toBe(0)
    expect(cacheState(indexer).retainedCacheBytes).toBe(0)
    expect(executeRemoteScript).toHaveBeenCalledTimes(2)
  })

  it('charges Codex identities and transcript scans against the same retained byte allowance', async () => {
    const executeRemoteScript = fixtureExecutor()
    const probe = new RemoteConversationIndexer({ executeRemoteScript })
    await probe.list('fixture', '/srv/a')
    await probe.findCodexSessionId('fixture', '/srv/a', NOW, new Set(), EXACT_ID)
    const combinedBytes = cacheState(probe).retainedCacheBytes
    const indexer = new RemoteConversationIndexer({ executeRemoteScript, cacheMaxBytes: combinedBytes - 1 })
    await indexer.list('fixture', '/srv/a')
    await indexer.findCodexSessionId('fixture', '/srv/a', NOW, new Set(), EXACT_ID)
    expect(cacheState(indexer).cache.size).toBe(1)
    expect(cacheState(indexer).retainedCacheBytes).toBeLessThan(combinedBytes)
    const callsBeforeHit = executeRemoteScript.mock.calls.length
    await indexer.findCodexSessionId('fixture', '/srv/a', NOW, new Set(), EXACT_ID)
    expect(executeRemoteScript).toHaveBeenCalledTimes(callsBeforeHit)
    await indexer.list('fixture', '/srv/a')
    expect(executeRemoteScript).toHaveBeenCalledTimes(callsBeforeHit + 1)
    expect(cacheState(indexer).cache.size).toBe(1)
    expect(cacheState(indexer).retainedCacheBytes).toBeLessThan(combinedBytes)
  })

  it('does not let a replaced entry expire at the old scan deadline', async () => {
    const executeRemoteScript = fixtureExecutor()
    const indexer = new RemoteConversationIndexer({ executeRemoteScript })
    await indexer.list('fixture', '/srv/a')
    await vi.advanceTimersByTimeAsync(1_000)
    await indexer.findProviderSessionId('claude', 'fixture', '/srv/a', NOW, new Set())
    await vi.advanceTimersByTimeAsync(4_000)
    expect(cacheState(indexer).cache.size).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cacheState(indexer).cache.size).toBe(0)
    expect(cacheState(indexer).retainedCacheBytes).toBe(0)
  })
})

describe('remote conversation in-flight work', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)) })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('joins concurrent list, detail, and forced identity scans, then refreshes a completed cache on force', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const executeRemoteScript = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const indexer = new RemoteConversationIndexer({ executeRemoteScript })
    const list = indexer.list('fixture', '/srv/a')
    const detail = indexer.get('fixture', '/srv/a', conversationId())
    const provider = indexer.findProviderSessionId('claude', 'fixture', '/srv/a', NOW, new Set())
    expect(executeRemoteScript).toHaveBeenCalledTimes(1)
    first.resolve(encode(scanPayload('/srv/a')))
    expect((await list)[0].providerSessionId).toBe(EXACT_ID)
    expect((await detail).messages[1].content).toBe('Complete remote transcript')
    expect(await provider).toBe(EXACT_ID)

    const forced = indexer.findProviderSessionId('claude', 'fixture', '/srv/a', NOW, new Set())
    const concurrentForce = indexer.findProviderSessionId('claude', 'fixture', '/srv/a', NOW, new Set())
    const concurrentDetail = indexer.get('fixture', '/srv/a', conversationId())
    expect(executeRemoteScript).toHaveBeenCalledTimes(2)
    second.resolve(encode(scanPayload('/srv/a', 'Fresh complete transcript')))
    expect(await forced).toBe(EXACT_ID)
    expect(await concurrentForce).toBe(EXACT_ID)
    expect((await concurrentDetail).messages[1].content).toBe('Fresh complete transcript')
    expect((await indexer.get('fixture', '/srv/a', conversationId())).messages[1].content).toBe('Fresh complete transcript')
    expect(executeRemoteScript).toHaveBeenCalledTimes(2)
  })

  it('releases a failed shared scan so a later request can retry', async () => {
    const failed = deferred<string>()
    const executeRemoteScript = vi.fn().mockImplementationOnce(() => failed.promise)
      .mockResolvedValueOnce(encode(scanPayload('/srv/a')))
    const indexer = new RemoteConversationIndexer({ executeRemoteScript })
    const results = Promise.allSettled([
      indexer.list('fixture', '/srv/a'),
      indexer.get('fixture', '/srv/a', conversationId()),
      indexer.findProviderSessionId('claude', 'fixture', '/srv/a', NOW, new Set())
    ])
    expect(executeRemoteScript).toHaveBeenCalledTimes(1)
    failed.reject(new Error('SSH fixture unavailable'))
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected'])
    expect(cacheState(indexer).cache.size).toBe(0)
    expect((await indexer.list('fixture', '/srv/a'))[0].providerSessionId).toBe(EXACT_ID)
    expect(executeRemoteScript).toHaveBeenCalledTimes(2)
  })

  it('shares Codex session reads, preserves exact identity filtering, and retries after failure', async () => {
    const failed = deferred<string>()
    const success = deferred<string>()
    const executeRemoteScript = vi.fn().mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(() => success.promise)
    const indexer = new RemoteConversationIndexer({ executeRemoteScript })
    const failedResults = Promise.allSettled([
      indexer.findCodexSessionId('fixture', '/srv/a', NOW, new Set(), EXACT_ID),
      indexer.findProviderSessionId('codex', 'fixture', '/srv/a', NOW, new Set(), EXACT_ID)
    ])
    expect(executeRemoteScript).toHaveBeenCalledTimes(1)
    failed.reject(new Error('Transient SSH fixture failure'))
    expect((await failedResults).map((result) => result.status)).toEqual(['rejected', 'rejected'])

    const exact = indexer.findCodexSessionId('fixture', '/srv/a', NOW, new Set(), EXACT_ID)
    const prefix = indexer.findCodexSessionId('fixture', '/srv/a', NOW, new Set(), EXACT_ID.slice(0, 12))
    const excluded = indexer.findCodexSessionId('fixture', '/srv/a', NOW, new Set([EXACT_ID]), EXACT_ID)
    const wrongHint = indexer.findCodexSessionId('fixture', '/srv/a', NOW, new Set(), 'unrelated-id')
    expect(executeRemoteScript).toHaveBeenCalledTimes(2)
    success.resolve(encode(codexPayload('/srv/a')))
    expect(await Promise.all([exact, prefix, excluded, wrongHint])).toEqual([EXACT_ID, EXACT_ID, null, null])
    expect(executeRemoteScript.mock.calls.every((call) => typeof call[1] === 'string' && call[1] !== REMOTE_SCAN_SCRIPT)).toBe(true)
    expect(cacheState(indexer).cache.size).toBe(1)
  })
})
