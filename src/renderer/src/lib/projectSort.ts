import { useEffect, useState } from 'react'
import type { AgentState, Project } from '@shared/types'
import {
  compareSelectionRecency,
  type SelectionRecencyMap
} from './selectionRecency'

export type ProjectSort = 'recent' | 'name' | 'attention' | 'newest'

export const projectSortOptions: Array<{
  value: ProjectSort
  label: string
}> = [
  { value: 'recent', label: 'Newest first' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'newest', label: 'Newest added' }
]

const STORAGE_KEY = 'panepilot.project-sort-by-connection'
const CHANGE_EVENT = 'panepilot-project-sort-changed'
const STATE_ORDER: AgentState[] = [
  'needs-input',
  'needs-attention',
  'running',
  'response-ready',
  'idle',
  'error',
  'completed'
]

function isProjectSort(value: unknown): value is ProjectSort {
  return projectSortOptions.some((option) => option.value === value)
}

function storedSorts(): Record<string, ProjectSort> {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, ProjectSort] =>
        isProjectSort(entry[1])
      )
    )
  } catch {
    return {}
  }
}

export function projectSortFor(
  sorts: Record<string, ProjectSort>,
  connectionId: string
): ProjectSort {
  return sorts[connectionId] ?? 'recent'
}

export function sortProjects(
  projects: Project[],
  order: ProjectSort,
  selectionRecency: SelectionRecencyMap = {},
  attentionOrder: Record<string, number> = {}
): Project[] {
  return [...projects].sort((left, right) => {
    if (order === 'name') {
      return left.name.localeCompare(right.name, undefined, {
        sensitivity: 'base'
      })
    }
    if (order === 'attention') {
      const stickyOrder =
        (attentionOrder[right.id] ?? 0) - (attentionOrder[left.id] ?? 0)
      if (stickyOrder !== 0) return stickyOrder
      // Keep the legacy priority only during the first render before the local
      // sticky order has been initialized.
      if (
        attentionOrder[left.id] == null &&
        attentionOrder[right.id] == null
      ) {
        const priority =
          STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state)
        if (priority !== 0) return priority
      }
    }
    if (order === 'recent') {
      const selectionOrder = compareSelectionRecency(
        left.id,
        right.id,
        selectionRecency
      )
      if (selectionOrder !== 0) return selectionOrder
    }
    const dateField = order === 'newest' ? 'createdAt' : 'updatedAt'
    const dateOrder =
      Date.parse(right[dateField]) - Date.parse(left[dateField])
    return dateOrder || left.name.localeCompare(right.name)
  })
}

export function useProjectSorts(): [
  Record<string, ProjectSort>,
  (connectionId: string, value: ProjectSort) => void
] {
  const [sorts, setSorts] = useState<Record<string, ProjectSort>>(storedSorts)

  useEffect(() => {
    function sync() {
      setSorts(storedSorts())
    }
    window.addEventListener(CHANGE_EVENT, sync)
    return () => window.removeEventListener(CHANGE_EVENT, sync)
  }, [])

  function update(connectionId: string, value: ProjectSort) {
    const next = { ...storedSorts(), [connectionId]: value }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }

  return [sorts, update]
}
