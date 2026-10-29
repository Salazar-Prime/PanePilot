// Test-only adapters for loading the real built application in a disposable profile.
// This module is never imported by production. See test-desktop-workflows.mjs.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const cp = require('node:child_process')
const { syncBuiltinESMExports, createRequire } = require('node:module')

exports.install = function install({ root, temp, electron }) {
  const realHome = os.homedir()
  const syntheticHome = path.join(temp, 'synthetic-home')
  const bin = path.join(temp, 'bin')
  const wrapper = path.join(bin, 'tmux')
  const safeShell = path.join(bin, 'fixture-shell')
  const violations = []
  const calls = []
  const inside = (base, target) => target === base || target.startsWith(base + path.sep)
  const deny = (kind, target) => {
    const message = `Fixture isolation blocked ${kind}: ${String(target).replaceAll(realHome, '<real-home>').replaceAll(temp, '<fixture>')}`
    violations.push(message)
    throw new Error(message)
  }
  const filePath = (value) => {
    if (typeof value === 'number') return null
    if (value instanceof URL) value = require('node:url').fileURLToPath(value)
    if (Buffer.isBuffer(value)) value = value.toString()
    return typeof value === 'string' ? path.resolve(value) : null
  }
  const readGuard = (value) => {
    const target = filePath(value)
    if (target && inside(realHome, target) && !inside(root, target) && !inside(temp, target)) deny('real-home read', target)
  }
  const writeGuard = (value) => {
    const target = filePath(value)
    if (target && !inside(temp, target) && target !== '/dev/null') deny('write outside fixture', target)
  }
  for (const api of [fs, fsp]) {
    for (const name of ['readFile', 'readdir', 'readlink', 'realpath', 'stat', 'lstat', 'access', 'exists', 'watch', 'watchFile']) {
      for (const suffix of ['', 'Sync']) {
        const key = name + suffix
        if (typeof api[key] !== 'function') continue
        const original = api[key]
        const guarded = function (target, ...args) { readGuard(target); return original.call(this, target, ...args) }
        if (original.native) guarded.native = function (target, ...args) { readGuard(target); return original.native.call(this, target, ...args) }
        api[key] = guarded
      }
    }
    for (const name of ['mkdir', 'mkdtemp', 'writeFile', 'appendFile', 'unlink', 'rm', 'rmdir', 'truncate', 'chmod']) {
      for (const suffix of ['', 'Sync']) {
        const key = name + suffix
        if (typeof api[key] !== 'function') continue
        const original = api[key]
        api[key] = function (target, ...args) { writeGuard(target); return original.call(this, target, ...args) }
      }
    }
    for (const name of ['rename', 'copyFile', 'link', 'symlink']) {
      for (const suffix of ['', 'Sync']) {
        const key = name + suffix
        if (typeof api[key] !== 'function') continue
        const original = api[key]
        api[key] = function (source, target, ...args) {
          readGuard(source); writeGuard(target)
          if (name === 'rename') writeGuard(source)
          return original.call(this, source, target, ...args)
        }
      }
    }
    for (const key of ['open', 'openSync']) {
      if (typeof api[key] !== 'function') continue
      const original = api[key]
      api[key] = function (target, flags, ...args) {
        readGuard(target)
        if (typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0 : /[wa+]/.test(flags ?? 'r')) writeGuard(target)
        return original.call(this, target, flags, ...args)
      }
    }
  }
  for (const [key, guard] of [['createReadStream', readGuard], ['createWriteStream', writeGuard]]) {
    const original = fs[key]
    fs[key] = function (target, ...args) { guard(target); return original.call(this, target, ...args) }
  }
  const commandGuard = (file, args = [], options = {}) => {
    const command = String(file)
    const values = args.map(String)
    if (options.shell) deny('shell-enabled child process', command)
    if (options.cwd && !inside(temp, path.resolve(options.cwd))) deny('child cwd outside fixture', options.cwd)
    const safe = command === wrapper || command === safeShell ||
      (command === 'sh' && values[0] === '-lc' && (values[1] === 'command -v tmux' || (values[1]?.includes(wrapper) && !values[1]?.includes('ssh')))) ||
      (command === 'which' && values.length === 1 && values[0] === 'tmux') ||
      (command === 'ssh' && values.includes('fixture-ssh')) ||
      (command === path.join(bin, 'rclone') && values.length === 1 && values[0] === 'listremotes') ||
      (command === 'git' && values.includes('-C') && inside(temp, values[values.indexOf('-C') + 1] ?? '')) ||
      (command === '/bin/sh' && values[0] === '-c' && values[1]?.includes(wrapper) && !values[1]?.includes('ssh'))
    if (!safe) deny('child command', [command, ...values].join(' '))
    calls.push({ command: command.replaceAll(temp, '<fixture>'), args: values.map(value => value.replaceAll(temp, '<fixture>')) })
  }
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = cp[name]
    const guarded = function (file, args, options, ...rest) {
      commandGuard(file, Array.isArray(args) ? args : [], options && typeof options === 'object' ? options : {})
      return original.call(this, file, args, options, ...rest)
    }
    // node:util.promisify(execFile) relies on this custom result shape.
    const custom = require('node:util').promisify.custom
    if (original[custom]) guarded[custom] = function (file, args, options) {
      commandGuard(file, Array.isArray(args) ? args : [], options ?? {})
      return original[custom].call(this, file, args, options)
    }
    cp[name] = guarded
  }
  cp.exec = cp.execSync = () => deny('unbounded shell execution', 'exec')
  const pty = createRequire(path.join(root, 'package.json'))('node-pty')
  const spawnPty = pty.spawn
  pty.spawn = function (file, args, options) {
    assert.equal(file, wrapper, 'All fixture PTYs must use the explicit isolated tmux wrapper.')
    assert.ok(inside(temp, options.cwd), 'PTY cwd must be synthetic.')
    calls.push({ command: '<fixture>/bin/tmux', args: [...args].map(value => value.replaceAll(temp, '<fixture>')), pty: true })
    return spawnPty.call(this, file, args, options)
  }
  for (const name of ['node:http', 'node:https']) {
    const network = require(name)
    network.request = network.get = () => deny('Node network', name)
  }
  for (const [name, methods] of [['node:net', ['connect', 'createConnection']], ['node:tls', ['connect']], ['node:dgram', ['createSocket']]]) {
    const network = require(name)
    for (const method of methods) network[method] = () => deny('Node network', `${name}.${method}`)
  }
  require('node:net').Socket.prototype.connect = () => deny('Node socket connection', 'Socket.connect')
  globalThis.fetch = () => deny('Node network', 'fetch')
  electron.net.request = electron.net.fetch = () => deny('Electron network', 'net')
  os.homedir = () => syntheticHome
  os.tmpdir = () => temp
  process.chdir(temp)
  process.env.PATH = `${bin}:/usr/bin:/bin`
  process.env.SHELL = safeShell
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  delete process.env.ELECTRON_RENDERER_URL
  electron.app.setPath('appData', path.join(temp, 'appdata'))
  electron.app.setPath('userData', path.join(temp, 'appdata', 'project-console'))
  electron.app.setPath('sessionData', path.join(temp, 'session'))
  electron.app.setPath('logs', path.join(temp, 'logs'))
  assert.equal(electron.app.isPackaged, false, 'Updater initialization must remain disabled.')
  // Electron exposes BrowserWindow as a nonconfigurable export. The driver's
  // browser-window-created listener hides it before renderer loading; suppress
  // later explicit show/focus calls without replacing the production module.
  electron.BrowserWindow.prototype.show = function () {}
  electron.BrowserWindow.prototype.focus = function () {}
  let clipboardText = ''
  electron.clipboard.readText = () => clipboardText
  electron.clipboard.writeText = (text) => { clipboardText = String(text) }
  electron.clipboard.clear = () => { clipboardText = '' }
  for (const name of ['read', 'readHTML', 'readRTF', 'readBookmark', 'readImage', 'write', 'writeHTML', 'writeRTF', 'writeBookmark', 'writeImage', 'availableFormats']) {
    electron.clipboard[name] = () => deny('unmodeled clipboard API', name)
  }
  const threads = require('node:worker_threads')
  const RealWorker = threads.Worker
  threads.Worker = class FixtureWorker extends RealWorker {
    constructor(filename, options) {
      const roots = options?.workerData?.roots
      assert.ok(Array.isArray(roots) && roots.length > 0, 'Archive workers must receive explicit parent-resolved roots.')
      assert.ok(roots.every(root => typeof root.path === 'string' && inside(syntheticHome, root.path)), 'Every archive root must be in the synthetic home.')
      readGuard(filename)
      super(filename, options)
      calls.push({ worker: true, roots: roots.map(root => ({ ...root, path: root.path.replaceAll(temp, '<fixture>') })) })
    }
  }
  electron.shell.openExternal = () => deny('external application', 'openExternal')
  electron.shell.openPath = () => deny('external application', 'openPath')
  electron.shell.showItemInFolder = () => deny('external application', 'showItemInFolder')
  electron.dialog.showOpenDialog = electron.dialog.showSaveDialog = () => deny('native file dialog', 'dialog')
  electron.dialog.showErrorBox = (title, content) => { throw new Error(`${title}: ${content}`) }
  syncBuiltinESMExports()
  return { violations, calls, assertClean() {
    assert.deepEqual(violations, [])
    assert.equal(os.homedir(), syntheticHome)
    assert.equal(electron.app.getPath('userData'), path.join(temp, 'appdata', 'project-console'))
  } }
}
