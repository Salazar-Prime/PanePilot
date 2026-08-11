import { describe, expect, it } from 'vitest'
import type { Project } from '../src/shared/types'
import {
  updateProjectAttentionOrder,
  type ProjectAttentionOrderState
} from '../src/renderer/src/lib/projectAttentionOrder'
import { sortProjects } from '../src/renderer/src/lib/projectSort'

function project(id: string, state: Project['state']): Project {
  return {
    id,
    type: 'terminal',
    name: id,
    icon: null,
    connectionId: 'local',
    folder: `/tmp/${id}`,
    repositoryUrl: null,
    latex: null,
    state,
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessions: [],
    actions: [],
    activities: []
  }
}

const empty: ProjectAttentionOrderState = {
  top: 0,
  bottom: 0,
  order: {},
  attention: {}
}

describe('sticky project attention ordering', () => {
  it('promotes on attention without demoting when attention clears', () => {
    const alpha = project('alpha', 'idle')
    const bravo = project('bravo', 'idle')
    const initial = updateProjectAttentionOrder(empty, [alpha, bravo])

    const promoted = updateProjectAttentionOrder(initial, [
      alpha,
      { ...bravo, state: 'needs-input' }
    ])
    expect(
      sortProjects([alpha, bravo], 'attention', {}, promoted.order).map(
        (item) => item.id
      )
    ).toEqual(['bravo', 'alpha'])

    const resolved = updateProjectAttentionOrder(promoted, [alpha, bravo])
    expect(resolved.order).toEqual(promoted.order)
    expect(
      sortProjects(
        [{ ...alpha, updatedAt: '2030-01-01T00:00:00.000Z' }, bravo],
        'attention',
        {},
        resolved.order
      ).map((item) => item.id)
    ).toEqual(['bravo', 'alpha'])

    const alphaPromoted = updateProjectAttentionOrder(resolved, [
      { ...alpha, state: 'needs-attention' },
      bravo
    ])
    expect(
      sortProjects([alpha, bravo], 'attention', {}, alphaPromoted.order).map(
        (item) => item.id
      )
    ).toEqual(['alpha', 'bravo'])
  })
})
