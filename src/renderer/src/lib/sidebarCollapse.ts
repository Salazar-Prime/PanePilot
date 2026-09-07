import { useCallback, useState } from 'react'

const STORAGE_KEY = 'panepilot.collapsed-projects'

function loadCollapsedIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter((id) => typeof id === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function persistCollapsedIds(ids: Set<string>) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
}

export function useCollapsedProjects(): [
  Set<string>,
  (projectId: string) => void,
  (projectId: string) => void
] {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(loadCollapsedIds)

  const toggle = useCallback((projectId: string) => {
    setCollapsedIds((current) => {
      const next = new Set(current)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      persistCollapsedIds(next)
      return next
    })
  }, [])

  const expand = useCallback((projectId: string) => {
    setCollapsedIds((current) => {
      if (!current.has(projectId)) return current
      const next = new Set(current)
      next.delete(projectId)
      persistCollapsedIds(next)
      return next
    })
  }, [])

  return [collapsedIds, toggle, expand]
}
