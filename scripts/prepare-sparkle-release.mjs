import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { parseArgs, promisify } from 'node:util'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSparkle, sparkleBin, run } from './prepare-sparkle.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { positionals, values } = parseArgs({ allowPositionals: true, options: { output: { type: 'string' } } })
const archive = positionals[0] ? resolve(positionals[0]) : null
if (!archive || !archive.endsWith('.zip')) throw new Error('Usage: npm run updates:release -- /path/to/PanePilot-version-macOS-arm64.zip [release-notes.md]')
if (!(await lstat(archive)).isFile()) throw new Error('Choose a regular release ZIP, not a symlink or directory.')
await prepareSparkle()
const execute = promisify(execFile)
const config = JSON.parse(await readFile(join(root, 'build/sparkle-config.json'), 'utf8'))
const temp = await mkdtemp(join(dirname(archive), '.panepilot-release-check-'))
let staging
try {
  await run('/usr/bin/ditto', ['-x', '-k', archive, temp])
  const names = await readdir(temp)
  if (names.filter((name) => name.endsWith('.app')).length !== 1) throw new Error('Update ZIP must contain exactly one application.')
  const application = join(temp, names.find((name) => name.endsWith('.app')))
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application])
  const plist = join(application, 'Contents/Info.plist')
  const property = async (name) => (await execute('/usr/bin/plutil', ['-extract', name, 'raw', '-o', '-', plist])).stdout.trim()
  if (await property('CFBundleIdentifier') !== 'com.salazarprime.panepilot') throw new Error('Not a PanePilot update archive.')
  if (await property('SUPublicEDKey') !== config.publicEdKey || await property('SUFeedURL') !== config.feedUrl) throw new Error('Archive signing key/feed does not match this repository’s public configuration.')
  if (await property('SURequireSignedFeed') !== 'true' || await property('SUVerifyUpdateBeforeExtraction') !== 'true') throw new Error('Archive must require signed feeds and pre-extraction verification.')
  const version = await property('CFBundleShortVersionString')
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Archive has an invalid release version.')
  const expected = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  if (version !== expected || await property('CFBundleVersion') !== expected) throw new Error('Archive, bundle build number, and package.json versions must agree.')
  const destination = values.output ? resolve(values.output) : join(root, 'release/sparkle', `v${version}`)
  await mkdir(dirname(destination), { recursive: true })
  await mkdir(destination) // Refuse to overwrite an already prepared release.
  staging = destination
  const zipName = basename(archive)
  await copyFile(archive, join(destination, zipName))
  if (positionals[1]) await copyFile(resolve(positionals[1]), join(destination, zipName.replace(/\.zip$/, '.md')))
  await run(join(sparkleBin, 'generate_appcast'), ['--account', 'com.salazarprime.panepilot.sparkle',
    '--maximum-deltas', '0', '--maximum-versions', '1', '--embed-release-notes',
    '--download-url-prefix', `https://github.com/Salazar-Prime/PanePilot/releases/download/v${version}/`, destination], { timeout: 120_000 })
  await run(join(sparkleBin, 'sign_update'), ['--account', 'com.salazarprime.panepilot.sparkle', '--verify', join(destination, 'appcast.xml')], { timeout: 120_000 })
  const xml = await readFile(join(destination, 'appcast.xml'), 'utf8')
  if (!xml.includes('sparkle:edSignature=') || !xml.includes(`releases/download/v${version}/`)) throw new Error('Appcast is missing a signed update enclosure.')
  const sums = []
  for (const name of (await readdir(destination)).filter((name) => /\.(zip|xml|md)$/.test(name)).sort()) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(destination, name))) hash.update(chunk)
    sums.push(`${hash.digest('hex')}  ${name}`)
  }
  await writeFile(join(destination, 'SHA256SUMS.txt'), sums.join('\n') + '\n')
  console.log(`Prepared signed update assets in ${destination}. Nothing was published. Upload the exact ZIP and other referenced files before appcast.xml to the matching GitHub release; do not edit signed XML or notes afterward.`)
} catch (error) {
  if (staging) console.error(`Preparation failed; unpublished staging files remain at ${staging} for inspection.`)
  throw error
} finally { await rm(temp, { recursive: true, force: true }) }
