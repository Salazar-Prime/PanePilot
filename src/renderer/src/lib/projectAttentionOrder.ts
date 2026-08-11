import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { isAttentionState } from './status'

export interface ProjectAttentionOrderState {
  top: number
  bottom: number
  order: Record<string, number>
  attention: Record<string, boolean>
}

const STORAGE_KEY = 'panepilot.project-attention-order'
const CHANGE_EVENT = 'panepilot-project-attention-order-changed'

const emptyState = (): ProjectAttentionOrderState => ({
  top: 0,
  bottom: 0,
  order: {},
  attention: {}
})

function cleanNumberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1])
    )
  )
}

function cleanBooleanMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, boolean] => typeof entry[1] === 'boolean'
    )
  )
}

function storedState(): ProjectAttentionOrderState {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? '{}'
    ) as Partial<ProjectAttentionOrderState>
    const order = cleanNumberMap(parsed.order)
    const values = Object.values(order)
    return {
      top: Math.max(
        typeof parsed.top === 'number' && Number.isFinite(parsed.top)
          ? parsed.top
          : 0,
        0,
        ...values
      ),
      bottom: Math.min(
        typeof parsed.bottom === 'number' && Number.isFinite(parsed.bottom)
          ? parsed.bottom
          : 0,
        0,
        ...values
      ),
      order,
      attention: cleanBooleanMap(parsed.attention)
    }
  } catch {
    return emptyState()
  }
}

export function updateProjectAttentionOrder(
  current: ProjectAttentionOrderState,
  projects: Project[]
): ProjectAttentionOrderState {
  let changed = false
  let top = current.top
  let bottom = current.bottom
  const order = { ...current.order }
  const attention = { ...current.attention }

  if (Object.keys(order).length === 0 && projects.length > 0) {
    for (const project of [...projects].reverse()) {
      top += 1
      order[project.id] = top
    }
    bottom = 1
    changed = true
  } else {
    for (const project of projects) {
      if (order[project.id] != null) continue
      bottom -= 1
      order[project.id] = bottom
      changed = true
    }
  }

  const promotions = projects.filter(
    (project) =>
      isAttentionState(project.state) && attention[project.id] !== true
  )
  // The incoming project list is already newest-first. Promote it in reverse so
  // its first item receives the highest final rank when several arrive together.
  for (const project of [...promotions].reverse()) {
    top += 1
    order[project.id] = top
    changed = true
  }

  for (const project of projects) {
    const next = isAttentionState(project.state)
    if (attention[project.id] === next) continue
    attention[project.id] = next
    changed = true
  }

  return changed ? { top, bottom, order, attention } : current
}

export function useProjectAttentionOrder(
  projects: Project[]
): Record<string, number> {
  const [state, setState] = useState<ProjectAttentionOrderState>(storedState)

  useEffect(() => {
    function sync() {
      setState(storedState())
    }
    window.addEventListener(CHANGE_EVENT, sync)
    return () => window.removeEventListener(CHANGE_EVENT, sync)
  }, [])

  useEffect(() => {
    const current = storedState()
    const next = updateProjectAttentionOrder(current, projects)
    if (next === current) return
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setState(next)
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }, [projects])

  return state.order
}
