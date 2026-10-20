import { describe, expect, it, vi } from 'vitest'
import type { SparkleBridge, SparkleBridgeEvent } from 'electron-sparkle-updater'
import { AppUpdateService, validateSparkleConfig } from '../src/main/app-update-service'
import { cachedUpdateRestartGuard, forgetProjectUpdateRestartGuards, updateRestartBlocker } from '../src/renderer/src/lib/updateRestartGuards'
import { readFileSync } from 'node:fs'

const config = { feedUrl: 'https://example.com/appcast.xml', publicEdKey: Buffer.alloc(32, 7).toString('base64') }
function fixture(overrides: Partial<ConstructorParameters<typeof AppUpdateService>[0]> = {}) {
  let receive: ((event: SparkleBridgeEvent) => void) | null = null
  const bridge: SparkleBridge = {
    init: vi.fn(() => true), checkForUpdates: vi.fn(), installUpdateNow: vi.fn(),
    installUpdateOnQuit: vi.fn(), discardDownloadedUpdate: vi.fn(), setAutomaticChecks: vi.fn(),
    setEventHandler: vi.fn((listener) => { receive = listener })
  }
  const options = { platform: 'darwin', packaged: true, currentVersion: '0.15.0',
    readConfig: vi.fn(async () => config), loadBridge: vi.fn(async () => bridge),
    notify: vi.fn(), restartBlocker: vi.fn(() => null as string | null), ...overrides }
  const service = new AppUpdateService(options)
  return { service, bridge, options, emit: (event: SparkleBridgeEvent) => receive?.(event) }
}

describe('Sparkle configuration and lifecycle', () => {
  it('requires a canonical 32-byte public key and credential-free HTTPS feed', () => {
    expect(validateSparkleConfig(config)).toEqual(config)
    for (const feedUrl of ['http://example.com/feed', 'file:///appcast.xml', 'https://name:secret@example.com/feed', 'https://example.com/feed#fragment']) {
      expect(() => validateSparkleConfig({ ...config, feedUrl })).toThrow()
    }
    for (const publicEdKey of ['', 'PLACEHOLDER', config.publicEdKey.slice(0, -1), config.publicEdKey + '\n']) {
      expect(() => validateSparkleConfig({ ...config, publicEdKey })).toThrow()
    }
  })
  it.each([{ platform: 'linux' }, { packaged: false }])('does not load native code or read a feed when disabled: %o', async (override) => {
    const { service, options } = fixture(override)
    await service.check()
    expect(service.get().phase).toBe('disabled')
    expect(options.readConfig).not.toHaveBeenCalled()
    expect(options.loadBridge).not.toHaveBeenCalled()
  })
  it('initializes once without checking, downloading, or installing on startup', async () => {
    const { service, bridge, options } = fixture()
    await Promise.all([service.initialize(), service.initialize()])
    expect(options.loadBridge).toHaveBeenCalledTimes(1)
    expect(bridge.init).toHaveBeenCalledWith({ appcastUrl: config.feedUrl, publicEdKey: config.publicEdKey })
    expect(bridge.setAutomaticChecks).toHaveBeenCalledWith(false)
    expect(bridge.checkForUpdates).not.toHaveBeenCalled()
    expect(bridge.installUpdateNow).not.toHaveBeenCalled()
    expect(bridge.installUpdateOnQuit).not.toHaveBeenCalled()
  })
  it('reports missing native code or configuration without crashing the application', async () => {
    for (const override of [{ loadBridge: async () => null }, { readConfig: async () => ({}) }]) {
      const { service } = fixture(override)
      await expect(service.initialize()).resolves.toBeUndefined()
      expect(service.get().phase).toBe('error')
      await expect(service.restart()).rejects.toThrow('Download and verify')
    }
  })
  it('coalesces checks, reports progress, and waits for explicit installation', async () => {
    const { service, bridge, emit } = fixture()
    await Promise.all([service.check(), service.check()])
    expect(bridge.checkForUpdates).toHaveBeenCalledTimes(1)
    emit({ type: 'update-available', version: '0.16.0' })
    emit({ type: 'download-progress', percent: 999, phase: 'apply' })
    expect(service.get()).toMatchObject({ phase: 'downloading', percent: 100, stage: 'verify', version: '0.16.0' })
    await expect(service.restart()).rejects.toThrow('Download and verify')
    emit({ type: 'update-downloaded', version: '0.16.0' })
    await service.check()
    expect(bridge.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(bridge.installUpdateNow).not.toHaveBeenCalled()
    await service.restart()
    expect(bridge.installUpdateNow).toHaveBeenCalledTimes(1)
    await expect(service.restart()).rejects.toThrow()
    service.dispose()
    expect(bridge.discardDownloadedUpdate).not.toHaveBeenCalled()
  })
  it('blocks restart during uploads or inline edits and retains a ready update', async () => {
    const { service, bridge, emit, options } = fixture()
    await service.check(); emit({ type: 'update-downloaded' })
    vi.mocked(options.restartBlocker).mockReturnValue('Wait for file transfers.')
    await expect(service.restart()).rejects.toThrow('Wait for file transfers')
    expect(service.get().phase).toBe('ready')
    expect(bridge.installUpdateNow).not.toHaveBeenCalled()
    vi.mocked(options.restartBlocker).mockReturnValue(null)
    await service.restart()
    expect(bridge.installUpdateNow).toHaveBeenCalledTimes(1)
  })
  it('handles native verification failures, retry, and errors during restart', async () => {
    const { service, bridge, emit } = fixture()
    await service.check(); emit({ type: 'error', message: 'Invalid signature' })
    expect(service.get()).toMatchObject({ phase: 'error', message: 'Invalid signature' })
    await expect(service.restart()).rejects.toThrow()
    await service.check()
    expect(bridge.checkForUpdates).toHaveBeenCalledTimes(2)
    emit({ type: 'update-downloaded' }); await service.restart()
    emit({ type: 'error', message: 'Installation failed' })
    expect(service.get().phase).toBe('error')
  })
  it('protects asynchronous saves even when their renderer was unmounted, and rejects new writes after restart', async () => {
    const { service, emit } = fixture()
    await service.check(); emit({ type: 'update-downloaded' })
    let resolve!: () => void
    const pending = service.protectRestartWhile(() => new Promise<void>((done) => { resolve = done }))
    await expect(service.restart()).rejects.toThrow('file and editor operations')
    resolve(); await pending
    await expect(service.protectRestartWhile(() => { throw Error('Save failed') })).rejects.toThrow('Save failed')
    await service.restart()
    await expect(service.protectRestartWhile(() => 'late save')).rejects.toThrow('restarting')
  })
  it('coalesces progress notifications and flushes terminal states immediately', async () => {
    vi.useFakeTimers()
    const { service, emit, options } = fixture()
    try {
      await service.check(); emit({ type: 'update-available', version: '0.16.0' })
      vi.mocked(options.notify).mockClear()
      for (let percent = 0; percent < 100; percent++) emit({ type: 'download-progress', percent })
      expect(options.notify).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      expect(options.notify).toHaveBeenCalledTimes(1)
      expect(options.notify).toHaveBeenLastCalledWith(expect.objectContaining({ percent: 99 }))
      emit({ type: 'download-progress', percent: 100 }); emit({ type: 'update-downloaded' })
      expect(options.notify).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'ready' }))
      await vi.advanceTimersByTimeAsync(200)
      expect(options.notify).toHaveBeenCalledTimes(2)
    } finally { service.dispose(); vi.useRealTimers() }
  })
  it('discards a staged update on ordinary quit rather than installing silently', async () => {
    const { service, bridge, emit } = fixture()
    await service.check(); emit({ type: 'update-downloaded' })
    service.dispose()
    expect(bridge.discardDownloadedUpdate).toHaveBeenCalledTimes(1)
    expect(bridge.setEventHandler).toHaveBeenLastCalledWith(null)
    expect(bridge.installUpdateOnQuit).not.toHaveBeenCalled()
    expect(bridge.installUpdateNow).not.toHaveBeenCalled()
    const state = service.get()
    emit({ type: 'checking' })
    expect(service.get()).toEqual(state)
  })
  it('does not start a bridge after the owner shuts down during initialization', async () => {
    let resolve!: (bridge: SparkleBridge | null) => void
    const { service, bridge } = fixture({ loadBridge: () => new Promise((done) => { resolve = done }) })
    const pending = service.initialize()
    await Promise.resolve()
    service.dispose(); resolve(bridge); await pending
    expect(bridge.init).not.toHaveBeenCalled()
  })
  it('retains unsaved cached-draft guards until the corresponding cache is saved or removed', () => {
    cachedUpdateRestartGuard('test:file', 'Save the cached file.')
    expect(updateRestartBlocker()).toBe('Save the cached file.')
    cachedUpdateRestartGuard('test:file', null)
    expect(updateRestartBlocker()).toBeNull()
  })
  it('clears deleted-project guards and ignores late cache flushes from the removed workspace', () => {
    cachedUpdateRestartGuard('files:deleted', 'Save a deleted project.')
    cachedUpdateRestartGuard('latex:deleted\u0000main.tex', 'Save deleted source.')
    forgetProjectUpdateRestartGuards('deleted')
    cachedUpdateRestartGuard('files:deleted', 'Late unmount flush')
    expect(updateRestartBlocker()).toBeNull()
  })
  it('keeps update IPC restricted to the main app frame and exposes no URL arguments', () => {
    const source = readFileSync('src/main/index.ts', 'utf8')
    const ipc = source.slice(source.indexOf('  const updateSender'), source.indexOf("  ipcMain.handle('files:interactive-html:open'"))
    expect(ipc).toContain('event.senderFrame !== event.sender.mainFrame')
    expect(ipc).toContain('event.sender !== mainWindow?.webContents')
    expect(ipc).toContain('appUpdates.restart()')
    expect(ipc).not.toContain('rawUrl')
    expect(ipc).not.toContain('input')
  })
})
