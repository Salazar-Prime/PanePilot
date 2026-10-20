import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { prepareSparkle, sparkleBin } from './prepare-sparkle.mjs'

if (process.platform !== 'darwin') throw new Error('Sparkle signing-key setup requires macOS.')
await prepareSparkle()
const execute = promisify(execFile)
const account = 'com.salazarprime.panepilot.sparkle'
const configPath = fileURLToPath(new URL('../build/sparkle-config.json', import.meta.url))
const config = JSON.parse(await readFile(configPath, 'utf8'))
// Sparkle creates/reuses this app-specific Keychain entry. Never export its private key.
if (!config.publicEdKey) await execute(join(sparkleBin, 'generate_keys'), ['--account', account], { timeout: 120_000 })
const { stdout } = await execute(join(sparkleBin, 'generate_keys'), ['--account', account, '-p'], { timeout: 120_000 })
  .catch(() => { throw new Error('This checkout already has a public key. Securely import its existing private key into the PanePilot Keychain account; do not generate a replacement.') })
const publicEdKey = stdout.trim()
if (Buffer.from(publicEdKey, 'base64').length !== 32) throw new Error('Sparkle did not return a valid public key.')
if (config.publicEdKey && config.publicEdKey !== publicEdKey) throw new Error('This Mac has a different signing key. Do not rotate an established update key; import the existing key securely.')
await writeFile(configPath, JSON.stringify({ ...config, publicEdKey }, null, 2) + '\n')
console.log('Sparkle is configured. Only the public verification key was written to build/sparkle-config.json; the private key stays in Keychain.')
