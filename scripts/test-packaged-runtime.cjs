// Usage: ELECTRON_RUN_AS_NODE=1 /path/PanePilot.app/Contents/MacOS/PanePilot \
//   scripts/test-packaged-runtime.cjs /path/PanePilot.app
// Loads packaged dependencies, not the application main process or any user data.
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const { mkdtempSync, realpathSync, rmSync, readdirSync, mkdirSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { Worker } = require('node:worker_threads')
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
  const archiveWorker = await checkArchiveWorker()
  console.log(JSON.stringify({ headlessTerminal: true, exactFixturePty: true, sparkleBridgeLoadedWithoutInitialization: true, archiveWorker, runtimeRoots: roots, electron: process.versions.electron }))
}

async function checkArchiveWorker() {
  const candidates = []
  const scan = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) scan(path)
      else if (/conversation-indexer-worker.*\.[cm]?js$/.test(entry.name)) candidates.push(path)
    }
  }
  scan(join(asar, 'out/main'))
  assert.equal(candidates.length, 1, 'Exactly one bundled archive worker entry must ship.')
  const sessions = join(temp, 'synthetic-sessions')
  mkdirSync(sessions)
  const records = [
    { type: 'session_meta', payload: { id: 'packaged-worker-fixture-thread', cwd: temp } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Packaged synthetic archive question.' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PACKAGED_ARCHIVE_WORKER_OK' }] } }
  ]
  writeFileSync(join(sessions, 'fixture.jsonl'), records.map(record => JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', ...record })).join('\n') + '\n')
  const worker = new Worker(candidates[0], { workerData: { roots: [{ provider: 'codex', path: sessions }] } })
  let nextId = 0
  const invoke = (method, args) => new Promise((resolve, reject) => {
    const id = ++nextId
    const clean = () => { clearTimeout(timeout); worker.removeListener('message', message); worker.removeListener('error', error); worker.removeListener('exit', exit) }
    const message = (reply) => { if (reply.id !== id) return; clean(); reply.error ? reject(new Error(reply.error)) : resolve(reply.value) }
    const error = (caught) => { clean(); reject(caught) }
    const exit = (code) => { clean(); reject(new Error(`Packaged archive worker exited unexpectedly (${code}).`)) }
    const timeout = setTimeout(() => { clean(); reject(new Error('Packaged archive worker timed out.')) }, 10_000)
    worker.on('message', message); worker.on('error', error); worker.on('exit', exit)
    worker.postMessage({ id, method, args })
  })
  try {
    const list = await invoke('list', [temp, 'PACKAGED_ARCHIVE_WORKER_OK', 0])
    assert.equal(list.length, 1)
    assert.equal(list[0].providerSessionId, 'packaged-worker-fixture-thread')
    const detail = await invoke('get', [temp, list[0].id, ''])
    assert.ok(detail.messages.some(message => message.content === 'PACKAGED_ARCHIVE_WORKER_OK'))
    assert.equal(await invoke('findProviderSessionId', ['codex', temp, '2025-12-31T00:00:00.000Z', [], 'packaged-worker-fixture-thread']), 'packaged-worker-fixture-thread')
    return { executed: true, entry: candidates[0].slice(asar.length + 1), syntheticFullTextSearch: true, detail: true, exactProviderIdentity: true }
  } finally {
    await worker.terminate()
  }
}
main().then(() => { rmSync(temp, { recursive: true, force: true }) }, (error) => { console.error(error); rmSync(temp, { recursive: true, force: true }); process.exitCode = 1 })
