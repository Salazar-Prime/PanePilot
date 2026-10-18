import { useEffect, useState } from 'react'

/** Only the visible, linked Codex chat is scanned; never fetch transcript tails here. */
export function useSubagentPresence(sessionId: string | null, providerSessionId: string | null): boolean {
  const identity = sessionId && providerSessionId ? `${sessionId}:${providerSessionId}` : null
  const [result, setResult] = useState<{ identity: string; present: boolean } | null>(null)

  useEffect(() => {
    if (!identity || !sessionId) return
    let disposed = false
    let busy = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      if (disposed || busy || document.hidden) return
      busy = true
      try {
        const summary = await window.projectConsole.terminals.subagentSummary(sessionId)
        if (!disposed) setResult({ identity, present: summary.rootFound && summary.count > 0 })
      } catch {
        // An ambient SSH/archive failure must not interrupt the workspace or erase a known result.
      } finally {
        busy = false
        if (!disposed && !document.hidden) timer = setTimeout(poll, 10_000)
      }
    }
    const visibility = () => {
      clearTimeout(timer)
      if (!document.hidden) void poll()
    }
    void poll()
    document.addEventListener('visibilitychange', visibility)
    return () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [identity, sessionId])

  return !!identity && result?.identity === identity && result.present
}
