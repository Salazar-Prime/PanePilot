import { useEffect, useState } from 'react'
import type { AgentState, TerminalSession } from '@shared/types'

export type SessionSort = 'recent' | 'oldest' | 'name' | 'attention'

export const sessionSortOptions: Array<{ value: SessionSort; label: string }> = [
  { value: 'recent', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'attention', label: 'Needs attention' }
]

const STORAGE_KEY = 'panepilot.session-sort'
const CHANGE_EVENT = 'panepilot-session-sort-changed'
const STATE_ORDER: AgentState[] = [
  'needs-input',
  'needs-attention',
  'running',
  'response-ready',
  'idle',
  'error',
  'completed'
]

function storedSort(): SessionSort {
  const value = window.localStorage.getItem(STORAGE_KEY)
  return sessionSortOptions.some((option) => option.value === value)
    ? (value as SessionSort)
    : 'recent'
}

export function sortSessions(
  sessions: TerminalSession[],
  order: SessionSort
): TerminalSession[] {
  return [...sessions].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    if (order === 'name') return left.name.localeCompare(right.name)
    if (order === 'oldest') {
      return Date.parse(left.createdAt) - Date.parse(right.createdAt)
    }
    if (order === 'attention') {
      const priority = STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state)
      if (priority !== 0) return priority
    }
    return Date.parse(right.createdAt) - Date.parse(left.createdAt)
  })
}

export function useSessionSort(): [SessionSort, (value: SessionSort) => void] {
  const [order, setOrder] = useState<SessionSort>(storedSort)

  useEffect(() => {
    function sync() {
      setOrder(storedSort())
    }
    window.addEventListener(CHANGE_EVENT, sync)
    return () => window.removeEventListener(CHANGE_EVENT, sync)
  }, [])

  function update(value: SessionSort) {
    window.localStorage.setItem(STORAGE_KEY, value)
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }

  return [order, update]
}
