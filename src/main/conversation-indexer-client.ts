import type { Worker } from 'node:worker_threads'
import type { ConversationDetail, ConversationProvider, ConversationSummary } from '../shared/types'
import type { ConversationCacheOptions, ConversationIndexer, ConversationRoot } from './conversation-indexer'

export interface ConversationWorkerOptions {
  roots?: ConversationRoot[]
  cache?: ConversationCacheOptions
}
export type ConversationWorkerMethod = 'list' | 'get' | 'findProviderSessionId' | 'diagnostics'
export interface ConversationWorkerRequest { id: number; method: ConversationWorkerMethod; args: unknown[] }
export interface ConversationWorkerReply { id: number; value?: unknown; error?: string }

/** One worker owns all archive IO, JSON parsing, full-text search and detail caches. */
export class AsyncConversationIndexer {
  private worker: Worker | null = null
  private nextId = 0
  private closed = false
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly inFlight = new Map<string, Promise<unknown>>()

  constructor(private readonly createWorker: (options: ConversationWorkerOptions) => Worker,
    private readonly options: ConversationWorkerOptions = {}) {}

  list(folder: string, query = '', hiddenCount = 0): Promise<ConversationSummary[]> {
    return this.request('list', [folder, query, hiddenCount])
  }
  get(folder: string, id: string, query = ''): Promise<ConversationDetail> {
    return this.request('get', [folder, id, query])
  }
  findProviderSessionId(provider: ConversationProvider, folder: string, createdAt: string,
    excluded: Set<string>, hint: string | null = null): Promise<string | null> {
    return this.request('findProviderSessionId', [provider, folder, createdAt, [...excluded], hint])
  }
  diagnostics(): Promise<ReturnType<ConversationIndexer['diagnostics']>> {
    return this.request('diagnostics', [])
  }

  dispose(): void {
    this.closed = true
    const worker = this.worker
    this.fail(new Error('Conversation archive worker was closed.'))
    void worker?.terminate()
  }

  private fail(error: Error): void {
    this.worker = null
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    this.inFlight.clear()
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = this.createWorker(this.options)
    this.worker = worker
    worker.on('message', (reply: ConversationWorkerReply) => {
      if (this.worker !== worker) return
      const request = this.pending.get(reply.id)
      if (!request) return
      this.pending.delete(reply.id)
      if (reply.error) request.reject(new Error(reply.error))
      else request.resolve(reply.value)
      if (!this.pending.size) worker.unref()
    })
    worker.on('error', (error) => {
      if (this.worker === worker) this.fail(error)
    })
    worker.on('exit', (code) => {
      if (this.worker === worker) this.fail(new Error(`Conversation archive worker exited (${code}).`))
    })
    worker.unref()
    return worker
  }

  private request<T>(method: ConversationWorkerMethod, args: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Conversation archive worker was closed.'))
    const key = JSON.stringify([method, args])
    const existing = this.inFlight.get(key)
    if (existing) return existing as Promise<T>
    const promise = new Promise<unknown>((resolve, reject) => {
      try {
        const worker = this.ensureWorker()
        const id = ++this.nextId
        this.pending.set(id, { resolve, reject })
        worker.ref()
        try { worker.postMessage({ id, method, args } satisfies ConversationWorkerRequest) }
        catch (error) {
          this.pending.delete(id)
          if (!this.pending.size) worker.unref()
          reject(error)
        }
      } catch (error) { reject(error) }
    })
    this.inFlight.set(key, promise)
    const clear = () => { if (this.inFlight.get(key) === promise) this.inFlight.delete(key) }
    void promise.then(clear, clear)
    return promise as Promise<T>
  }
}
