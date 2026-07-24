import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function discoverSshAliases(): string[] {
  const configPath = join(homedir(), '.ssh', 'config')
  if (!existsSync(configPath)) return []

  const aliases = new Set<string>()
  const config = readFileSync(configPath, 'utf8')
  for (const line of config.split(/\r?\n/)) {
    const match = line.match(/^\s*Host\s+(.+)$/i)
    if (!match) continue
    for (const alias of match[1].trim().split(/\s+/)) {
      if (!alias.includes('*') && !alias.includes('?') && !alias.startsWith('!')) aliases.add(alias)
    }
  }
  return [...aliases].sort((a, b) => a.localeCompare(b))
}
