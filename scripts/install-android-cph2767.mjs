// Run from the PanePilot project Actions panel, or use --dry-run to check only.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const requiredModel = 'CPH2767'

export function selectPhone(adb) {
  const listing = adb(['devices', '-l'])
  const phones = new Map()
  for (const line of listing.split('\n')) {
    // Wireless mDNS identifiers can contain spaces: select by transport, not name.
    const match = line.match(/\sdevice\s.*\btransport_id:(\d+)\b/)
    if (!match) continue
    const transport = match[1]
    const property = (name) => adb(['-t', transport, 'shell', 'getprop', name]).trim()
    if (property('ro.product.model') !== requiredModel) continue
    const serial = property('ro.serialno')
    if (!serial || serial.toLowerCase() === 'unknown') {
      throw new Error('Cannot identify the CPH2767 physical device. Installation refused.')
    }
    if (!phones.has(serial)) phones.set(serial, { transport, serial })
  }
  if (phones.size !== 1) {
    throw new Error(phones.size
      ? 'Multiple different CPH2767 phones are connected. Disconnect the others first.'
      : 'No authorized, online CPH2767 found. Connect/pair the OnePlus in ADB first.')
  }
  return [...phones.values()][0]
}

export function installPhone({ adb, build, apk, dryRun = false, log = console.log }) {
  const phone = selectPhone(adb)
  log(`Selected ${requiredModel} (ADB transport ${phone.transport}).`)
  if (dryRun) {
    log('Dry run passed. No build or installation performed.')
    return
  }
  build()
  // Re-scan after the build: transports can disappear/reconnect while Gradle runs.
  const current = selectPhone(adb)
  if (current.serial !== phone.serial) {
    throw new Error('The connected phone changed during the build. Installation refused.')
  }
  const prefix = ['-t', current.transport]
  const model = adb([...prefix, 'shell', 'getprop', 'ro.product.model']).trim()
  const serial = adb([...prefix, 'shell', 'getprop', 'ro.serialno']).trim()
  if (model !== requiredModel || serial !== phone.serial) {
    throw new Error('Device identity changed before installation. Installation refused.')
  }
  log('Installing PanePilot update; existing app data will be retained…')
  log(adb([...prefix, 'install', '-r', apk], 180_000).trim())
  log('PanePilot installed on CPH2767. Open it on the phone when ready.')
}

function main() {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== '--dry-run')) {
    throw new Error('Usage: node scripts/install-android-cph2767.mjs [--dry-run]')
  }
  const projectRoot = fileURLToPath(new URL('../', import.meta.url))
  const androidRoot = resolve(process.env.PANEPILOT_ANDROID_DIR || resolve(projectRoot, '../PanePilot-Remote'))
  const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    '/opt/homebrew/share/android-commandlinetools', resolve(homedir(), 'Library/Android/sdk'),
    resolve(homedir(), 'Android/Sdk')].find((path) => path && existsSync(resolve(path, 'platform-tools/adb')))
  const adbPath = sdk ? resolve(sdk, 'platform-tools/adb') : 'adb'
  const apk = resolve(androidRoot, 'app/build/outputs/apk/debug/app-debug.apk')
  const adb = (args, timeout = 10_000) => execFileSync(adbPath, args, {
    encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe']
  })
  installPhone({
    adb, apk, dryRun: args.includes('--dry-run'),
    build: () => {
      const gradle = resolve(androidRoot, 'gradlew')
      if (!existsSync(gradle)) throw new Error('PanePilot-Remote checkout not found. Set PANEPILOT_ANDROID_DIR to its folder.')
      console.log('Building the latest PanePilot Android debug APK…')
      execFileSync(gradle, ['assembleDebug'], {
        cwd: androidRoot, stdio: 'inherit', timeout: 15 * 60_000,
        env: { ...process.env, ...(sdk ? { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk } : {}) }
      })
      if (!existsSync(apk)) throw new Error('Build did not produce the expected APK.')
    }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main() } catch (error) {
    console.error(`Installation stopped: ${error.message}`)
    process.exitCode = 1
  }
}
