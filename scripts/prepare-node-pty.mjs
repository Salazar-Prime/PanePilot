import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import {
  NODE_PTY_DARWIN_PATCH_VERSION,
  patchNodePtyDarwinSource
} from './node-pty-darwin-patch.mjs'

const require = createRequire(import.meta.url)
const forceRebuild = process.argv.includes('--force-rebuild')

function rebuildNodePty() {
  const rebuildCli = join(dirname(require.resolve('@electron/rebuild')), 'cli.js')
  const result = spawnSync(
    process.execPath,
    [rebuildCli, '-f', '-w', 'node-pty'],
    {
      cwd: process.cwd(),
      stdio: 'inherit'
    }
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`electron-rebuild exited with status ${result.status}.`)
  }
}

function makeSpawnHelpersExecutable(packageRoot) {
  const candidates = [
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
    join(
      packageRoot,
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'spawn-helper'
    )
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) chmodSync(candidate, 0o755)
  }
}

let packageRoot
try {
  packageRoot = dirname(require.resolve('node-pty/package.json'))
} catch (error) {
  // Some package managers can invoke this script before node-pty is linked.
  if (!forceRebuild && error?.code === 'MODULE_NOT_FOUND') process.exit(0)
  throw error
}

let needsRebuild = forceRebuild
let stampPath = null

if (process.platform === 'darwin') {
  const sourcePath = join(packageRoot, 'src', 'unix', 'pty.cc')
  const originalSource = readFileSync(sourcePath, 'utf8')
  const patched = patchNodePtyDarwinSource(originalSource)
  if (patched.changed) {
    writeFileSync(sourcePath, patched.source)
    needsRebuild = true
  }

  stampPath = join(
    packageRoot,
    'build',
    'Release',
    `.${NODE_PTY_DARWIN_PATCH_VERSION}`
  )
  if (!existsSync(stampPath)) needsRebuild = true
}

if (needsRebuild) rebuildNodePty()
makeSpawnHelpersExecutable(packageRoot)

if (stampPath && needsRebuild) {
  mkdirSync(dirname(stampPath), { recursive: true })
  writeFileSync(stampPath, `${NODE_PTY_DARWIN_PATCH_VERSION}\n`)
}
