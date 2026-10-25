import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const rootRequire = createRequire(join(root, 'package.json'))
const tmuxCandidates = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']
let tmuxPath = null
for (const candidate of tmuxCandidates) {
  try { await access(candidate); tmuxPath = candidate; break } catch { /* Try the next standard install location. */ }
}
if (!tmuxPath) {
  process.stdout.write('SKIP host-terminal native smoke: tmux not installed at a supported path.\n')
} else {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-host-terminal-native-'))
  const bundlePath = join(temp, 'host-terminal-smoke.cjs')
  const fixture = `
    const assert = require('node:assert/strict')
    const { mkdir } = require('node:fs/promises')
    const { join } = require('node:path')
    const { app } = require('electron')
    const { HostTerminalService } = require('./src/main/host-terminal-service')
    const { Store } = require('./src/main/store')

    const temp = process.argv[2]
    const tmux = process.argv[3]
    app.setPath('userData', join(temp, 'electron-profile'))
    const timeout = setTimeout(() => {
      process.stderr.write('Host-terminal native smoke timed out.\\n')
      app.exit(1)
    }, 45_000)
    timeout.unref()

    void app.whenReady().then(async () => {
      if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
      let store
      let service
      const services = []
      const buffers = new Map()
      try {
        const home = join(temp, 'home')
        const storePath = join(temp, 'store')
        await mkdir(home, { recursive: true })
        await mkdir(storePath, { recursive: true })
        store = new Store(storePath)
        const events = {
          changed: () => {},
          data: ({ sessionId, data }) => buffers.set(sessionId, (buffers.get(sessionId) ?? '') + data),
          transport: () => {}
        }
        const createService = () => {
          const instance = new HostTerminalService(store, join(temp, 'profile'), events, { tmux, home, shell: '/bin/sh' })
          services.push(instance)
          return instance
        }
        const pause = (ms) => new Promise((done) => setTimeout(done, ms))
        const waitFor = async (predicate, label) => {
          const until = Date.now() + 8_000
          while (Date.now() < until) {
            if (predicate()) return
            await pause(50)
          }
          throw new Error('Timed out waiting for ' + label)
        }
        const sendAndWait = async (instance, id, command, token) => {
          const previous = buffers.get(id) ?? ''
          instance.write(id, command)
          await waitFor(() => (buffers.get(id) ?? '').slice(previous.length).includes(token), token)
        }

        service = createService()
        const [first, second] = await Promise.all([service.create(), service.create()])
        assert.notEqual(first.id, second.id)
        assert.equal(store.listHostTerminals().length, 2)
        assert.equal(store.listProjects().length, 0)
        await service.attach(first.id, 100, 30)
        await service.attach(second.id, 100, 30)
        await waitFor(() => buffers.has(first.id) && buffers.has(second.id), 'both attached terminal clients')
        await sendAndWait(service, first.id, "PP_HOST_SMOKE=kept; printf 'ONE%s\\n' 'READY'\\r", 'ONEREADY')
        await sendAndWait(service, second.id, "printf 'TWO%s\\n' 'READY'\\r", 'TWOREADY')
        assert.ok(buffers.get(first.id).includes('ONEREADY'))
        assert.ok(buffers.get(second.id).includes('TWOREADY'))
        assert.ok(!buffers.get(first.id).includes('TWOREADY'))
        assert.ok(!buffers.get(second.id).includes('ONEREADY'))

        service.shutdown()
        service = createService()
        const restored = await service.list()
        assert.equal(restored.find(({ id }) => id === first.id)?.state, 'idle')
        await service.attach(first.id, 100, 30)
        await service.attach(second.id, 100, 30)
        await waitFor(() => (buffers.get(first.id) ?? '').length > 0, 'reattached first terminal output')
        await sendAndWait(service, first.id, "printf '%s%s\\n' 'PERSIST' \\\"$PP_HOST_SMOKE\\\"\\r", 'PERSISTkept')

        await service.close(first.id)
        assert.equal(store.getHostTerminal(first.id), null)
        assert.ok(store.getHostTerminal(second.id))
        await sendAndWait(service, second.id, "printf 'SECOND%s\\n' 'ALIVE'\\r", 'SECONDALIVE')
        service.write(second.id, 'exit\\r')
        const until = Date.now() + 8_000
        while (Date.now() < until && (await service.list()).find(({ id }) => id === second.id)?.state === 'idle') await pause(50)
        assert.equal((await service.list()).find(({ id }) => id === second.id)?.state, 'completed')
        const retained = await service.captureBuffer(second.id)
        assert.ok(retained.includes('SECONDALIVE'))
        await service.close(second.id)
        assert.deepEqual(store.listHostTerminals(), [])
        assert.equal(store.listProjects().length, 0)
        process.stdout.write('PASS host-terminal native smoke (PTY + private tmux persistence).\\n')
      } catch (error) {
        process.stderr.write((error && error.stack) || String(error))
        process.stderr.write('\\n')
        process.exitCode = 1
      } finally {
        for (const instance of services) {
          try {
            for (const session of store?.listHostTerminals() ?? []) await instance.close(session.id)
          } catch { /* Keep attempting exact-session cleanup below. */ }
          try { instance.shutdown() } catch {}
        }
        try { store?.close() } catch {}
        clearTimeout(timeout)
        app.exit(process.exitCode ?? 0)
      }
    })
  `
  try {
    await build({
      stdin: { contents: fixture, loader: 'js', resolveDir: root },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      banner: { js: `process.env.NODE_PATH = ${JSON.stringify(join(root, 'node_modules'))}; require('node:module').Module._initPaths()` },
      outfile: bundlePath
    })
    const electron = rootRequire('electron')
    const env = { ...process.env, NODE_PATH: join(root, 'node_modules') }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron, [bundlePath, temp, tmuxPath], { env, stdio: 'inherit' })
    const code = await new Promise((done, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error('Host-terminal native smoke exceeded 45 seconds.'))
      }, 45_000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', (status, signal) => {
        clearTimeout(timer)
        if (signal) reject(new Error(`Host-terminal native smoke exited from ${signal}.`))
        else done(status)
      })
    })
    if (code !== 0) process.exitCode = 1
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
