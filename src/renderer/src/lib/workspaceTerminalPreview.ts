import type { WorkspaceDestination, WorkspaceSwitcherMode } from './workspaceHistory'

export function workspacePreviewDestination(
  destinations: WorkspaceDestination[], selectedIndex: number,
  mode: WorkspaceSwitcherMode, removingKey: string | null
): WorkspaceDestination | null {
  if (mode === 'capabilities' || removingKey) return null
  const destination = destinations[selectedIndex]
  return destination?.sessionId && ['terminal', 'manuscript', 'pdf'].includes(destination.tab)
    ? destination : null
}

export function previewScale(width: number, height: number, screenWidth: number, screenHeight: number): number {
  if (screenWidth <= 0 || screenHeight <= 0) return 1
  return Math.max(0.01, Math.min(1, width / screenWidth, height / screenHeight))
}
