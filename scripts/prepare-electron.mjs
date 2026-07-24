import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const packageRoot = dirname(require.resolve('electron/package.json'))
const relativeExecutable = readFileSync(join(packageRoot, 'path.txt'), 'utf8').trim()
const executable = join(packageRoot, 'dist', relativeExecutable)

if (!existsSync(executable)) {
  const result = spawnSync(process.execPath, [join(packageRoot, 'install.js')], {
    stdio: 'inherit'
  })
  if (result.status !== 0 || !existsSync(executable)) {
    throw new Error('Electron’s runtime could not be prepared.')
  }
}
