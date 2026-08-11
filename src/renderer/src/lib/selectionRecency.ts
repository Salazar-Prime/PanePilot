import { useCallback, useEffect, useState } from 'react'

export type SelectionRecencyMap = Record<string, number>

interface StoredSelectionRecency {
  sequence: number
  projects: SelectionRecencyMap
  sessions: SelectionRecencyMap
}

export interface SelectionRecency {
  projects: SelectionRecencyMap
  sessions: SelectionRecencyMap
}

const STORAGE_KEY = 'panepilot.selection-recency'
const CHANGE_EVENT = 'panepilot-selection-recency-changed'
const MAX_ENTRIES_PER_KIND = 2_000

function cleanMap(value: unknown): SelectionRecencyMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' &&
        Number.isFinite(entry[1]) &&
        entry[1] > 0
    )
  )
}

function storedRecency(): StoredSelectionRecency {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}'
    ) as Partial<StoredSelectionRecency>
    const projects = cleanMap(parsed.projects)
    const sessions = cleanMap(parsed.sessions)
    const largestRecorded = Math.max(
      0,
      ...Object.values(projects),
      ...Object.values(sessions)
    )
    return {
      sequence: Math.max(
        typeof parsed.sequence === 'number' && Number.isFinite(parsed.sequence)
          ? parsed.sequence
          : 0,
        largestRecorded
      ),
      projects,
      sessions
    }
  } catch {
    return { sequence: 0, projects: {}, sessions: {} }
  }
}

function trimMap(value: SelectionRecencyMap): SelectionRecencyMap {
  const entries = Object.entries(value)
  if (entries.length <= MAX_ENTRIES_PER_KIND) return value
  return Object.fromEntries(
    entries
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_ENTRIES_PER_KIND)
  )
}

export function compareSelectionRecency(
  leftId: string,
  rightId: string,
  recency: SelectionRecencyMap
): number {
  return (recency[rightId] ?? 0) - (recency[leftId] ?? 0)
}

export function useSelectionRecency(): {
  recency: SelectionRecency
  recordProjectSelection(projectId: string): void
  recordSessionSelection(sessionId: string): void
} {
  const [recency, setRecency] = useState<SelectionRecency>(() => {
    const stored = storedRecency()
    return { projects: stored.projects, sessions: stored.sessions }
  })

  useEffect(() => {
    function sync() {
      const stored = storedRecency()
      setRecency({ projects: stored.projects, sessions: stored.sessions })
    }
    window.addEventListener(CHANGE_EVENT, sync)
    return () => window.removeEventListener(CHANGE_EVENT, sync)
  }, [])

  const record = useCallback((kind: 'projects' | 'sessions', id: string) => {
    const current = storedRecency()
    const sequence = Math.max(Date.now(), current.sequence + 1)
    const next: StoredSelectionRecency = {
      ...current,
      sequence,
      [kind]: trimMap({ ...current[kind], [id]: sequence })
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }, [])

  const recordProjectSelection = useCallback(
    (projectId: string) => record('projects', projectId),
    [record]
  )
  const recordSessionSelection = useCallback(
    (sessionId: string) => record('sessions', sessionId),
    [record]
  )

  return { recency, recordProjectSelection, recordSessionSelection }
}
