import type { GitBranchRef } from '../../../shared/types'

export const gitBranchKey = (branch: GitBranchRef) => `${branch.remote ? 'remote' : 'local'}:${branch.name}`

export function matchingGitBranches(branches: readonly GitBranchRef[], query: string): GitBranchRef[] {
  const needle = query.trim().toLocaleLowerCase()
  return branches.filter((branch) => !needle || branch.name.toLocaleLowerCase().includes(needle))
}
