export interface GitHubRepositoryReference {
  nameWithOwner: string
  url: string
}

export function parseGitHubRepositoryReference(
  rawUrl: string | null | undefined
): GitHubRepositoryReference | null {
  const value = rawUrl?.trim()
  if (!value) return null
  const scpMatch = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i)
  const normalized = scpMatch
    ? `https://github.com/${scpMatch[1]}/${scpMatch[2]}`
    : value
  try {
    const url = new URL(normalized)
    if (
      url.hostname.toLocaleLowerCase() !== 'github.com' ||
      !['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) ||
      url.search ||
      url.hash
    ) return null
    const parts = url.pathname
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean)
    if (parts.length !== 2) return null
    const owner = parts[0]
    const name = parts[1].replace(/\.git$/i, '')
    if (
      !owner ||
      !name ||
      !/^[a-z0-9_.-]+$/i.test(owner) ||
      !/^[a-z0-9_.-]+$/i.test(name)
    ) return null
    return {
      nameWithOwner: `${owner}/${name}`,
      url: `https://github.com/${owner}/${name}`
    }
  } catch {
    return null
  }
}
