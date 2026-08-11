import { useState } from 'react'

const STORAGE_KEY = 'panepilot.open-sessions'

function loadOpenIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((id) => typeof id === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function persistOpenIds(ids: Set<string>) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
}

export function useOpenSessions(): [Set<string>, (sessionId: string) => void, (sessionId: string) => void] {
  const [openIds, setOpenIds] = useState<Set<string>>(loadOpenIds)

  function openSession(sessionId: string) {
    setOpenIds((current) => {
      if (current.has(sessionId)) return current
      const next = new Set(current)
      next.add(sessionId)
      persistOpenIds(next)
      return next
    })
  }

  function closeSession(sessionId: string) {
    setOpenIds((current) => {
      if (!current.has(sessionId)) return current
      const next = new Set(current)
      next.delete(sessionId)
      persistOpenIds(next)
      return next
    })
  }

  return [openIds, openSession, closeSession]
}
