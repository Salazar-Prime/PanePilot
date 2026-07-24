import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

try {
  const packageRoot = dirname(require.resolve('node-pty/package.json'))
  const candidates = [
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) chmodSync(candidate, 0o755)
  }
} catch {
  // npm runs postinstall before node-pty is always resolvable on every platform.
}
