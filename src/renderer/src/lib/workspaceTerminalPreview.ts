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

export function previewFontSize(width: number, height: number, cols: number, rows: number): number {
  if (cols <= 0 || rows <= 0) return 13
  // Render native-size glyphs; never shrink a rasterized terminal using CSS scale.
  return Math.max(1, Math.floor(Math.min(16, (width - 2) / (cols * 0.62), (height - 2) / (rows * 1.32))))
}
