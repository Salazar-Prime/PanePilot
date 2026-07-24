import { execFileSync } from 'node:child_process'

export function discoverRepository(folder: string): string | null {
  try {
    const raw = execFileSync('git', ['-C', folder, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (!raw) return null
    const sshMatch = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
    if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, '')}`
    return raw.replace(/\.git$/, '')
  } catch {
    return null
  }
}
