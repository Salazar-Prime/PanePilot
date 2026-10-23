import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { prepareSparkle, sparkleBin, sparkleNative, run } from './prepare-sparkle.mjs'

if (process.platform !== 'darwin') throw new Error('The native Sparkle smoke test requires macOS.')
await prepareSparkle()
const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronBundle = resolve(require('electron'), '../../..')
const temp = await mkdtemp(join(tmpdir(), 'panepilot-sparkle-test-'))
const profile = join(temp, 'profile')
const stateFile = join(temp, 'state.json')
const controlFile = join(temp, 'control.json')
const completedFile = join(temp, 'completed.json')
const bundleId = `com.salazarprime.panepilot.updatetest.${randomUUID().replaceAll('-', '')}`
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64')
const publicEdKey = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64')
const keyFile = join(temp, 'test-key')
await writeFile(keyFile, seed, { mode: 0o600 }) // Ephemeral test key, never the maintainer's Keychain key.
let feed = Buffer.alloc(0), archive = Buffer.alloc(0), corruptArchive = false
const requests = []
const server = createServer((request, response) => {
  requests.push(request.url)
  if (request.url === '/appcast.xml') { response.setHeader('Content-Type', 'application/rss+xml'); response.end(feed); return }
  if (request.url === '/update.zip') {
    response.setHeader('Content-Length', archive.length)
    const bytes = Buffer.from(archive)
    if (corruptArchive) bytes[Math.floor(bytes.length / 2)] ^= 1
    response.end(bytes); return
  }
  response.writeHead(404).end()
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const feedUrl = `http://127.0.0.1:${server.address().port}/appcast.xml`
let child
const waitFor = async (predicate, description, timeout = 90_000, allowExited = false) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    if (!allowExited && child?.exitCode != null) throw new Error(`Fixture exited before ${description}: ${child.exitCode}`)
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`Timed out: ${description}`)
}
const readState = async () => { try { return JSON.parse(await readFile(stateFile, 'utf8')) } catch { return null } }
const control = (action, blocked = false) => writeFile(controlFile, JSON.stringify({ action, blocked, id: randomUUID() }))
try {
  const oldApp = await makeApp('installed', '0.0.1')
  const nextApp = await makeApp('next', '0.0.2')
  const archives = join(temp, 'archives')
  await mkdir(archives)
  await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', nextApp, join(archives, 'update.zip')])
  await run(join(sparkleBin, 'generate_appcast'), ['--ed-key-file', keyFile, '--maximum-deltas', '0', '--download-url-prefix', feedUrl.replace('appcast.xml', ''), archives])
  const validFeed = await readFile(join(archives, 'appcast.xml'))
  archive = await readFile(join(archives, 'update.zip'))
  feed = Buffer.from(validFeed.toString().replace('<channel>', '<channel>\n<!-- tampered -->'))
  assert.notDeepEqual(feed, validFeed)
  await control('none')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  child = spawn(join(oldApp, 'Contents/MacOS/PanePilot Update Test'), [], { env, stdio: ['ignore', 'inherit', 'inherit'] })
  await waitFor(async () => (await readState())?.phase === 'idle', 'fixture startup')
  await new Promise((done) => setTimeout(done, 1200))
  assert.equal(requests.length, 0, 'Startup must not contact the feed')

  await control('check')
  await waitFor(async () => (await readState())?.phase === 'error', 'tampered feed rejection')
  assert.equal(requests.includes('/update.zip'), false, 'A bad feed signature must fail before archive download')
  feed = validFeed; corruptArchive = true
  await control('check')
  await waitFor(async () => (await readState())?.phase === 'downloading', 'bad archive download')
  await waitFor(async () => (await readState())?.phase === 'error', 'corrupt archive rejection')
  await control('restart')
  await waitFor(async () => (await readState())?.restartError?.includes('Download and verify'), 'reject install before verification')

  corruptArchive = false
  await control('check')
  await waitFor(async () => (await readState())?.phase === 'ready', 'valid signed update readiness')
  await new Promise((done) => setTimeout(done, 1200))
  assert.equal((await readState()).currentVersion, '0.0.1', 'A downloaded update must not install automatically')
  assert.equal(child.exitCode, null)
  await control('quit')
  await waitFor(async () => child.exitCode !== null, 'ordinary quit')
  await new Promise((done) => setTimeout(done, 1200))
  assert.equal(JSON.parse(await readFile(join(oldApp, 'Contents/Resources/app/package.json'), 'utf8')).version, '0.0.1', 'Ordinary quit must not install a downloaded update')
  await control('automatic')
  child = spawn(join(oldApp, 'Contents/MacOS/PanePilot Update Test'), [], { env, stdio: ['ignore', 'inherit', 'inherit'] })
  await waitFor(async () => (await readState())?.phase === 'idle', 'restart of unchanged original application')
  await waitFor(async () => (await readState())?.phase === 'ready', 'automatic background download after ordinary quit')
  assert.equal((await readState()).background, true, 'The application scheduler discovered the update without a user check')
  await control('restart', true)
  await waitFor(async () => (await readState())?.restartError === 'Fixture upload still running.', 'restart safety guard')
  assert.equal((await readState()).phase, 'ready')
  await control('restart', false)
  await waitFor(async () => { try { return JSON.parse(await readFile(completedFile, 'utf8')).version === '0.0.2' } catch { return false } }, 'new application relaunch', 90_000, true)
  await waitFor(async () => child.exitCode !== null, 'old application shutdown')
  await new Promise((done) => setTimeout(done, 700))
  const version = await readFile(join(oldApp, 'Contents/Resources/app/package.json'), 'utf8')
  assert.equal(JSON.parse(version).version, '0.0.2', 'Sparkle replaced only the temporary installed fixture')
  console.log('Sparkle native update passed: ad-hoc 0.0.1 → 0.0.2, signed feed, corrupt archive rejection, delayed automatic check/download, no install-on-quit, explicit restart, safety guard, install and relaunch. No installed PanePilot or provider sessions were touched.')
} catch (error) {
  console.error('Last fixture state:', await readState())
  throw error
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((done) => child.once('exit', done)) }
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  if (process.env.PANEPILOT_KEEP_UPDATE_TEST === '1') console.log(`Fixture retained at ${temp}`)
  else {
    await rm(temp, { recursive: true, force: true })
    // Sparkle uses the native bundle identity, not Electron's temporary userData path.
    await rm(join(homedir(), 'Library/Caches', bundleId), { recursive: true, force: true })
    await rm(join(homedir(), 'Library/Preferences', `${bundleId}.plist`), { force: true })
  }
}

async function makeApp(folder, version) {
  const appPath = join(temp, folder, 'PanePilot Update Test.app')
  await mkdir(dirname(appPath), { recursive: true })
  await run('/usr/bin/ditto', [electronBundle, appPath])
  const contents = join(appPath, 'Contents')
  await rename(join(contents, 'MacOS/Electron'), join(contents, 'MacOS/PanePilot Update Test'))
  const resources = join(contents, 'Resources')
  await mkdir(join(resources, 'app'), { recursive: true })
  await cp(join(sparkleNative, 'vendor/Sparkle.framework'), join(contents, 'Frameworks/Sparkle.framework'), { recursive: true, verbatimSymlinks: true })
  const dependency = join(resources, 'app.asar.unpacked/node_modules/electron-sparkle-updater')
  await mkdir(join(dependency, 'dist'), { recursive: true })
  await mkdir(join(dependency, 'native/build/Release'), { recursive: true })
  await cp(join(sparkleNative, '../dist/index.js'), join(dependency, 'dist/index.js'))
  await cp(join(sparkleNative, '../package.json'), join(dependency, 'package.json'))
  await cp(join(sparkleNative, 'build/Release/sparkle_bridge.node'), join(dependency, 'native/build/Release/sparkle_bridge.node'))
  await writeFile(join(resources, 'app/package.json'), JSON.stringify({ name: 'panepilot-update-test', version, main: 'main.cjs' }))
  await build({ stdin: { contents: fixtureMain(), loader: 'ts', resolveDir: root }, bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], outfile: join(resources, 'app/main.cjs') })
  const info = join(contents, 'Info.plist')
  const properties = { CFBundleIdentifier: bundleId, CFBundleName: 'PanePilot Update Test', CFBundleExecutable: 'PanePilot Update Test', CFBundleVersion: version,
    CFBundleShortVersionString: version, SUFeedURL: feedUrl, SUPublicEDKey: publicEdKey,
    SUEnableAutomaticChecks: false, SUAutomaticallyUpdate: false, SUSendProfileInfo: false,
    SUEnableInstallerLauncherService: false, SUVerifyUpdateBeforeExtraction: true, SURequireSignedFeed: true }
  for (const [key, value] of Object.entries(properties)) {
    await run('/usr/bin/plutil', ['-replace', key, typeof value === 'boolean' ? '-bool' : '-string', String(value), info])
  }
  // Loopback HTTP is allowed only in this throwaway fixture; production config requires HTTPS.
  await run('/usr/bin/plutil', ['-replace', 'NSAppTransportSecurity', '-json', '{"NSAllowsLocalNetworking":true}', info])
  const { signAsync } = await import('@electron/osx-sign')
  await signAsync({ app: appPath, identity: '-', identityValidation: false,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false, optionsForFile: () => ({ hardenedRuntime: false }) })
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
  return appPath
}

function fixtureMain() {
  return `
    import {app,BrowserWindow} from 'electron';
    import {readFileSync,writeFileSync,renameSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
    import {AppUpdateService} from './src/main/app-update-service';
    app.setPath('userData',${JSON.stringify(profile)});
    let service,blocked=false,lastId='',restartError='';
    const record=()=>{writeFileSync(${JSON.stringify(stateFile + '.tmp')},JSON.stringify({...service.get(),restartError}));renameSync(${JSON.stringify(stateFile + '.tmp')},${JSON.stringify(stateFile)})};
    setTimeout(()=>app.exit(2),120000).unref();
    void app.whenReady().then(async()=>{
      if(app.getVersion()==='0.0.2'){writeFileSync(${JSON.stringify(completedFile)},JSON.stringify({version:app.getVersion()}));setTimeout(()=>app.quit(),250);return}
      const window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});await window.loadURL('data:text/html,Update fixture');
      const {loadSparkleBridgeForApp}=await import(pathToFileURL(join(process.resourcesPath,'app.asar.unpacked/node_modules/electron-sparkle-updater/dist/index.js')).href);
      const native=await loadSparkleBridgeForApp();
      if(!native)throw Error('Native bridge did not load');
      service=new AppUpdateService({platform:process.platform,packaged:app.isPackaged,currentVersion:app.getVersion(),
        automaticChecks:JSON.parse(readFileSync(${JSON.stringify(controlFile)},'utf8')).action==='automatic',
        readConfig:async()=>({feedUrl:'https://updates.invalid/appcast.xml',publicEdKey:${JSON.stringify(publicEdKey)}}),
        loadBridge:async()=>({...native,init:options=>native.init({...options,appcastUrl:${JSON.stringify(feedUrl)}})}),
        notify:()=>record(),restartBlocker:()=>blocked?'Fixture upload still running.':null});
      await service.initialize();record();
      setInterval(async()=>{let command;try{command=JSON.parse(readFileSync(${JSON.stringify(controlFile)},'utf8'))}catch{return}
        if(command.id===lastId)return;lastId=command.id;blocked=command.blocked;restartError='';
        try{if(command.action==='check')await service.check();if(command.action==='restart')await service.restart();if(command.action==='quit')app.quit()}
        catch(error){restartError=String(error.message)}record();
      },100);
    }).catch(error=>{console.error(error);app.exit(1)});
    app.on('before-quit',()=>service?.dispose());
  `
}
