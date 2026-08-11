import { describe, expect, it } from 'vitest'
import {
  consumeWorkspaceRequest,
  workspaceRequestIdFor,
  type WorkspaceRequest
} from '../src/renderer/src/lib/workspaceRequest'

const request: WorkspaceRequest = {
  id: 7,
  projectId: 'latex-project',
  pane: 'b'
}

describe('workspace requests', () => {
  it('delivers a launcher request only to its intended project and pane', () => {
    expect(workspaceRequestIdFor(request, 'latex-project', 'b')).toBe(7)
    expect(workspaceRequestIdFor(request, 'other-project', 'b')).toBeNull()
    expect(workspaceRequestIdFor(request, 'latex-project', 'a')).toBeNull()
  })

  it('consumes only the matching request so an old acknowledgement is safe', () => {
    expect(consumeWorkspaceRequest(request, 7)).toBeNull()
    expect(consumeWorkspaceRequest(request, 6)).toBe(request)
    expect(consumeWorkspaceRequest(null, 7)).toBeNull()
  })
})
