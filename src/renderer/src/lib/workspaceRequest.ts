export type WorkspacePane = 'a' | 'b'

export interface WorkspaceRequest {
  id: number
  projectId: string
  pane: WorkspacePane
}

export function workspaceRequestIdFor(
  request: WorkspaceRequest | null,
  projectId: string,
  pane: WorkspacePane
): number | null {
  return request?.projectId === projectId && request.pane === pane
    ? request.id
    : null
}

export function consumeWorkspaceRequest(
  request: WorkspaceRequest | null,
  requestId: number
): WorkspaceRequest | null {
  return request?.id === requestId ? null : request
}
