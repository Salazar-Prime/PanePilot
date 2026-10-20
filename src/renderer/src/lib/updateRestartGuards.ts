import { useLayoutEffect, useRef } from 'react'

const liveGuards = new Map<symbol, () => string | null>()
const cachedGuards = new Map<string, string>()
const removedProjects = new Set<string>()

function belongsToProject(key: string, projectId: string): boolean {
  return key === `files:${projectId}` || key.startsWith(`latex:${projectId}\u0000`)
}

export function forgetProjectUpdateRestartGuards(projectId: string): void {
  removedProjects.add(projectId)
  for (const key of cachedGuards.keys()) if (belongsToProject(key, projectId)) cachedGuards.delete(key)
}

export function cachedUpdateRestartGuard(key: string, message: string | null): void {
  for (const projectId of removedProjects) if (belongsToProject(key, projectId)) return
  if (message) cachedGuards.set(key, message)
  else cachedGuards.delete(key)
}

export function useUpdateRestartGuard(message: string | null): void {
  const value = useRef(message)
  value.current = message
  useLayoutEffect(() => {
    const id = Symbol('update-restart-guard')
    liveGuards.set(id, () => value.current)
    return () => { liveGuards.delete(id) }
  }, [])
}

export function updateRestartBlocker(): string | null {
  for (const read of liveGuards.values()) {
    const message = read()
    if (message) return message
  }
  return cachedGuards.values().next().value ?? null
}
