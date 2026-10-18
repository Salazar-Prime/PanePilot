import { describe, expect, it } from 'vitest'
import { gitBranchKey, matchingGitBranches } from '../src/renderer/src/lib/gitBranches'
import type { GitBranchRef } from '../src/shared/types'

describe('timeline branch navigation', () => {
  const branches: GitBranchRef[] = [
    { name: 'feature/Editor', hash: 'a', remote: false },
    { name: 'origin/feature/Editor', hash: 'b', remote: true },
    { name: 'main', hash: 'c', remote: false },
    { name: 'main', hash: 'd', remote: true }
  ]

  it('finds local and remote branches without losing their exact identities', () => {
    expect(matchingGitBranches(branches, ' EDITOR ').map(gitBranchKey)).toEqual(['local:feature/Editor', 'remote:origin/feature/Editor'])
    expect(matchingGitBranches(branches, 'main').map(gitBranchKey)).toEqual(['local:main', 'remote:main'])
    expect(matchingGitBranches(branches, '')).toEqual(branches)
    expect(matchingGitBranches(branches, 'missing')).toEqual([])
  })

  it('finds a branch far beyond the initially visible chips or picker page', () => {
    const crowded = Array.from({ length: 600 }, (_, index) => ({ name: `origin/feature/${index}`, hash: String(index), remote: true }))
    expect(matchingGitBranches(crowded, '/599')).toEqual([crowded[599]])
    expect(crowded).toHaveLength(600)
  })
})
