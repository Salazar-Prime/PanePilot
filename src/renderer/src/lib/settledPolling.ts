/** Shares only running work. Settled results never become an implicit cache. */
export class InFlightReads<Key, Value> {
  private readonly pending = new Map<Key, Promise<Value>>()

  run(key: Key, read: () => Promise<Value>): Promise<Value> {
    const existing = this.pending.get(key)
    if (existing) return existing
    const promise = Promise.resolve().then(read)
    this.pending.set(key, promise)
    const clear = () => {
      if (this.pending.get(key) === promise) this.pending.delete(key)
    }
    void promise.then(clear, clear)
    return promise
  }

  async wait(key: Key): Promise<void> {
    await this.pending.get(key)?.catch(() => {})
  }
}

interface EventSource {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

interface PollingOptions {
  run: () => Promise<unknown>
  /** null performs a single read and refreshes only on visibility/focus events. */
  intervalMs: number | null
  visibility?: EventSource & { readonly hidden: boolean }
  focus?: EventSource
}

/** Optional UI reads sleep while hidden and schedule the next read after settlement. */
export function startSettledPolling({
  run,
  intervalMs,
  visibility,
  focus
}: PollingOptions): () => void {
  let disposed = false
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const visible = () => !visibility?.hidden
  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const refresh = () => {
    cancelTimer()
    if (disposed || running || !visible()) return
    running = true
    void Promise.resolve()
      .then(() => { if (!disposed && visible()) return run() })
      // A failed optional read must not produce an unhandled rejection or stop
      // future refreshes. The owner displays any relevant error state.
      .catch(() => {})
      .finally(() => {
        running = false
        if (!disposed && visible() && intervalMs !== null) {
          timer = setTimeout(refresh, intervalMs)
        }
      })
  }
  visibility?.addEventListener('visibilitychange', refresh)
  focus?.addEventListener('focus', refresh)
  refresh()
  return () => {
    disposed = true
    cancelTimer()
    visibility?.removeEventListener('visibilitychange', refresh)
    focus?.removeEventListener('focus', refresh)
  }
}
