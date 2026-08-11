import { describe, expect, it } from 'vitest'
import type { Project } from '../src/shared/types'
import {
  projectSortFor,
  sortProjects,
  type ProjectSort
} from '../src/renderer/src/lib/projectSort'

function project(
  id: string,
  name: string,
  state: Project['state'],
  createdAt: string,
  updatedAt: string
): Project {
  return {
    id,
    type: 'terminal',
    name,
    icon: null,
    connectionId: 'local',
    folder: `/tmp/${id}`,
    repositoryUrl: null,
    latex: null,
    state,
    archived: false,
    createdAt,
    updatedAt,
    sessions: [],
    actions: [],
    activities: []
  }
}

const projects = [
  project('alpha', 'Alpha', 'idle', '2025-01-01', '2025-03-01'),
  project('zulu', 'zulu', 'needs-input', '2025-03-01', '2025-01-01'),
  project('bravo', 'bravo', 'running', '2025-02-01', '2025-02-01')
]

describe('project sorting', () => {
  it.each<[ProjectSort, string[]]>([
    ['recent', ['alpha', 'bravo', 'zulu']],
    ['newest', ['zulu', 'bravo', 'alpha']],
    ['name', ['alpha', 'bravo', 'zulu']],
    ['attention', ['zulu', 'bravo', 'alpha']]
  ])('sorts one connection by %s', (order, expected) => {
    expect(sortProjects(projects, order).map((item) => item.id)).toEqual(expected)
  })

  it('keeps an independent selection for every connection', () => {
    const sorts = { local: 'name', studio: 'attention' } as const
    expect(projectSortFor(sorts, 'local')).toBe('name')
    expect(projectSortFor(sorts, 'studio')).toBe('attention')
    expect(projectSortFor(sorts, 'new-machine')).toBe('recent')
  })

  it('puts the most recently selected project first', () => {
    expect(
      sortProjects(projects, 'recent', {
        alpha: 10,
        zulu: 30,
        bravo: 20
      }).map((item) => item.id)
    ).toEqual(['zulu', 'bravo', 'alpha'])
  })
})
