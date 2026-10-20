const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') return
  const { prepareSparkle } = await import('./prepare-sparkle.mjs')
  // beforePack prepared the binary; verify cached artifacts without fetching after staging.
  await prepareSparkle(context.arch === 1 ? 'x64' : 'arm64')
  const config = JSON.parse(readFileSync(join(context.packager.projectDir, 'build/sparkle-config.json'), 'utf8'))
  const key = Buffer.from(config.publicEdKey, 'base64')
  if (key.length !== 32 || key.toString('base64') !== config.publicEdKey) {
    throw new Error('Missing Sparkle public key. Run npm run updates:setup before packaging.')
  }
  const url = new URL(config.feedUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Sparkle feed must use HTTPS without credentials or fragments.')
  const plist = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents/Info.plist')
  const values = { SUFeedURL: config.feedUrl, SUPublicEDKey: config.publicEdKey,
    SUEnableAutomaticChecks: false, SUAutomaticallyUpdate: false, SUSendProfileInfo: false,
    SUEnableInstallerLauncherService: false, SUVerifyUpdateBeforeExtraction: true, SURequireSignedFeed: true }
  for (const [name, value] of Object.entries(values)) {
    execFileSync('/usr/bin/plutil', ['-replace', name, typeof value === 'boolean' ? '-bool' : '-string', String(value), plist])
  }
  // electron-builder signs the completed app (including nested native helpers) after this hook.
}
