import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SPARKLE_VERSION = '2.10.0'
export const SPARKLE_SHA256 = 'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
export const sparkleNative = join(root, 'node_modules/electron-sparkle-updater/native')
export const sparkleBin = join(sparkleNative, 'vendor/bin')

export function run(command, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? done() : reject(new Error(`${command} ${signal ? `was stopped (${signal}); check for a pending Keychain approval or timeout` : `exited with ${code}`}`)))
  })
}

/** Use the unmodified, checksum-pinned official framework, not the bridge's delta-chain fork. */
export async function prepareSparkle(arch = process.arch) {
  if (process.platform !== 'darwin') return
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Sparkle packaging supports arm64 or x64 builds.')
  const electronVersion = require('electron/package.json').version
  const marker = join(sparkleNative, '.panepilot-sparkle.json')
  const expected = { version: SPARKLE_VERSION, sha256: SPARKLE_SHA256, electronVersion, arch }
  try {
    if (JSON.stringify(JSON.parse(await readFile(marker, 'utf8'))) === JSON.stringify(expected)) {
      await access(join(sparkleNative, 'build/Release/sparkle_bridge.node'))
      await access(join(sparkleBin, 'generate_appcast'))
      await access(join(sparkleNative, 'vendor/LICENSE'))
      return
    }
  } catch { /* First build or a dependency/architecture changed. */ }
  const staging = await mkdtemp(join(sparkleNative, '.panepilot-prepare-'))
  try {
    const response = await fetch(`https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz`,
      { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`Sparkle download failed: HTTP ${response.status}`)
    const archive = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(archive).digest('hex') !== SPARKLE_SHA256) throw new Error('Sparkle archive checksum mismatch.')
    const archivePath = join(staging, 'sparkle.tar.xz')
    await writeFile(archivePath, archive)
    await run('/usr/bin/tar', ['-xf', archivePath, '-C', staging])
    const vendor = join(sparkleNative, 'vendor')
    // Only generated dependency artifacts are replaced, never application or user data.
    await rm(vendor, { recursive: true, force: true })
    await cp(join(staging, 'Sparkle.framework'), join(vendor, 'Sparkle.framework'), { recursive: true, verbatimSymlinks: true })
    await cp(join(staging, 'bin'), join(vendor, 'bin'), { recursive: true, verbatimSymlinks: true })
    await cp(join(staging, 'LICENSE'), join(vendor, 'LICENSE'))
    const dependencyRequire = createRequire(join(sparkleNative, '../package.json'))
    const gyp = dependencyRequire.resolve('node-gyp/bin/node-gyp.js')
    await run(process.execPath, [gyp, 'rebuild', `--target=${electronVersion}`, `--arch=${arch}`,
      '--dist-url=https://electronjs.org/headers'], { cwd: sparkleNative })
    await writeFile(join(staging, 'marker.json'), JSON.stringify(expected))
    await rename(join(staging, 'marker.json'), marker)
  } finally { await rm(staging, { recursive: true, force: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareSparkle(process.argv[2])
}
