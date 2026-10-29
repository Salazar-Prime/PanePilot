// Usage: ELECTRON_RUN_AS_NODE=1 /path/PanePilot.app/Contents/MacOS/PanePilot \
//   scripts/test-packaged-runtime.cjs /path/PanePilot.app
// Loads packaged dependencies, not the application main process or any user data.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { mkdtempSync, realpathSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
assert.ok(process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1',
  'Run with ELECTRON_RUN_AS_NODE=1 using the packaged Electron executable.')
assert.ok(process.argv[2], 'An explicit packaged .app path is required.')
const app = realpathSync(resolve(process.argv[2]))
const resources = join(app, 'Contents/Resources')
const asar = join(resources, 'app.asar')
const request = createRequire(join(asar, 'package.json'))
const temp = mkdtempSync(join(tmpdir(), 'panepilot-packaged-runtime-'))
async function main() {
  const roots = ['@xterm/headless', 'node-pty', 'electron-sparkle-updater']
  for (const name of roots) assert.ok(request.resolve(name).startsWith(asar + '/'), `${name} resolves inside packaged app`)
  const { Terminal } = request('@xterm/headless')
  const terminal = new Terminal({ cols: 40, rows: 4, allowProposedApi: true })
  await new Promise((done) => terminal.write('packaged-headless-ok', done))
  assert.match(terminal.buffer.active.getLine(0).translateToString(true), /packaged-headless-ok/)
  terminal.dispose()
  const pty = request('node-pty')
  const output = await new Promise((done, reject) => {
    const child = pty.spawn('/usr/bin/printf', ['packaged-pty-ok'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: temp, env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' } })
    let text = ''
    const timeout = setTimeout(() => { child.kill(); reject(new Error('PTY fixture timed out')) }, 5000)
    child.onData((chunk) => { text += chunk })
    child.onExit(({ exitCode }) => { clearTimeout(timeout); exitCode === 0 ? done(text) : reject(new Error(`PTY exited ${exitCode}`)) })
  })
  assert.match(output, /packaged-pty-ok/)
  const updater = await import(pathToFileURL(request.resolve('electron-sparkle-updater')).href)
  const bridgeErrors = []
  const bridge = updater.loadSparkleBridge({ isPackaged: true, resourcesPath: resources, log: (message) => bridgeErrors.push(message) })
  assert.ok(bridge, bridgeErrors.join('; ') || 'Sparkle bridge must load')
  assert.equal(typeof bridge.checkForUpdates, 'function')
  // Deliberately do not initialize Sparkle or check for updates.
  console.log(JSON.stringify({ headlessTerminal: true, exactFixturePty: true, sparkleBridgeLoadedWithoutInitialization: true, runtimeRoots: roots, electron: process.versions.electron }))
}
main().then(() => { rmSync(temp, { recursive: true, force: true }) }, (error) => { console.error(error); rmSync(temp, { recursive: true, force: true }); process.exitCode = 1 })
