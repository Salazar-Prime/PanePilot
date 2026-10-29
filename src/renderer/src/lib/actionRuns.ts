import { useSyncExternalStore } from 'react'
import type { TerminalSession } from '@shared/types'

const pending = new Map<string, Promise<TerminalSession>>()
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }

export function useActionRunPending(actionId: string | null): boolean {
  return useSyncExternalStore(subscribe, () => !!actionId && pending.has(actionId), () => false)
}

/** One request across a hover card, palette, and split panes. The backend also rejects live reruns. */
export function runProjectAction(actionId: string, refresh?: () => Promise<void>): Promise<TerminalSession> {
  const existing = pending.get(actionId)
  if (existing) return existing
  const request = Promise.resolve().then(() => window.projectConsole.actions.run(actionId)).then(async (session) => {
    if (refresh) {
      try { await refresh() }
      catch (error) { throw new Error(`The action started, but refreshing its output failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    return session
  }).finally(() => {
    if (pending.get(actionId) === request) { pending.delete(actionId); notify() }
  })
  pending.set(actionId, request)
  notify()
  return request
}
