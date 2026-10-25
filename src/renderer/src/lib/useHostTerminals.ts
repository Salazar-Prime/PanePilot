import { useEffect, useRef, useState } from 'react'
import type { HostTerminal } from '@shared/types'

export function useHostTerminals() {
  const [sessions, setSessions] = useState<HostTerminal[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const busy = useRef(false)
  const version = useRef(0)

  const accept = (next: HostTerminal[]) => {
    setSessions(next)
    setSelectedId((selected) => next.some((session) => session.id === selected) ? selected : next.at(-1)?.id ?? null)
  }
  useEffect(() => {
    mounted.current = true
    const api = window.projectConsole.hostTerminals
    if (!api) return () => { mounted.current = false }
    const unsubscribe = api.onChanged((next) => { version.current++; if (mounted.current) accept(next) })
    let reading = false
    const refresh = async () => {
      if (reading || document.hidden) return
      reading = true
      const request = ++version.current
      try {
        const next = await api.list()
        if (mounted.current && request === version.current) accept(next)
      } catch (cause) {
        if (mounted.current && request === version.current) setError(String(cause instanceof Error ? cause.message : cause))
      } finally { reading = false }
    }
    void refresh()
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      mounted.current = false; version.current++; unsubscribe()
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  async function operate(operation: () => Promise<void>) {
    if (busy.current) return
    busy.current = true; setPending(true); setError('')
    try {
      if (!window.projectConsole.hostTerminals) throw new Error('Restart PanePilot to enable host terminals. Your project tmux sessions can stay running.')
      await operation()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
      throw cause
    } finally {
      busy.current = false
      if (mounted.current) setPending(false)
    }
  }
  const create = () => {
    setOpen(true)
    return operate(async () => {
      const session = await window.projectConsole.hostTerminals.create()
      if (!mounted.current) return
      // An IPC change event may arrive before or after this response. Both
      // paths merge the same exact ID instead of creating a second collection.
      version.current++
      setSessions((current) => [...current.filter((item) => item.id !== session.id), session])
      setSelectedId(session.id)
    })
  }
  const remove = (id: string) => operate(async () => {
    await window.projectConsole.hostTerminals.close(id)
    const request = ++version.current
    const next = await window.projectConsole.hostTerminals.list()
    if (mounted.current && request === version.current) accept(next)
  })
  return { sessions, selectedId, pending, error, open, create, remove,
    select: setSelectedId, show: () => setOpen(true), dismiss: () => { if (!busy.current) setOpen(false) } }
}
