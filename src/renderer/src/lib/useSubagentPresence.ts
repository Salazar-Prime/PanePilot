import { useEffect, useState } from 'react'

export interface SubagentPresence { present: boolean; running: boolean }

/** Only the visible, linked chat is checked. IPC carries counts/activity, never transcripts. */
export function useSubagentPresence(sessionId: string | null, providerSessionId: string | null): SubagentPresence {
  const identity = sessionId && providerSessionId ? `${sessionId}:${providerSessionId}` : null
  const [result, setResult] = useState<SubagentPresence & { identity: string } | null>(null)

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
        if (!disposed) {
          const next = { identity, present: summary.rootFound && summary.count > 0,
            running: summary.rootFound && summary.count > 0 && summary.running === true }
          setResult((current) => current?.identity === identity && current.present === next.present &&
            current.running === next.running ? current : next)
        }
      } catch {
        // Retain known presence, but never claim ongoing work from a failed activity check.
        if (!disposed) setResult((current) => current?.identity === identity && current.running ? { ...current, running: false } : current)
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

  return identity && result?.identity === identity ? result : { present: false, running: false }
}
