import type { SparkleBridge, SparkleBridgeEvent } from 'electron-sparkle-updater'
import type { AppUpdateState } from '../shared/appUpdates'

export interface SparkleConfig { feedUrl: string; publicEdKey: string }

export function validateSparkleConfig(value: unknown): SparkleConfig {
  const config = value as Partial<SparkleConfig> | null
  if (!config || typeof config.feedUrl !== 'string' || typeof config.publicEdKey !== 'string') throw new Error('This build has no Sparkle update configuration.')
  const url = new URL(config.feedUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Sparkle update feeds must use HTTPS without credentials or fragments.')
  const key = Buffer.from(config.publicEdKey, 'base64')
  if (key.length !== 32 || key.toString('base64') !== config.publicEdKey) throw new Error('This build has no valid Sparkle signing key. Run npm run updates:setup before packaging.')
  return { feedUrl: url.href, publicEdKey: config.publicEdKey }
}

/** Main-process only: the renderer can never supply an update URL, key, archive, or command. */
export class AppUpdateService {
  private bridge: SparkleBridge | null = null
  private initialization: Promise<void> | null = null
  private disposed = false
  private installing = false
  private pendingOperations = 0
  private progressTimer: ReturnType<typeof setTimeout> | null = null
  private state: AppUpdateState

  constructor(private options: {
    platform: string; packaged: boolean; currentVersion: string
    readConfig(): Promise<unknown>
    loadBridge(): Promise<SparkleBridge | null>
    notify(state: AppUpdateState): void
    restartBlocker(): string | null
  }) {
    const enabled = options.platform === 'darwin' && options.packaged
    this.state = { phase: enabled ? 'idle' : 'disabled', currentVersion: options.currentVersion,
      version: null, percent: null, stage: 'download',
      message: enabled ? 'Check for signed PanePilot updates.' : options.platform === 'darwin'
        ? 'Updates are available in packaged macOS builds, not the development app.' : 'Sparkle updates are available on macOS only.' }
  }

  get(): AppUpdateState { return { ...this.state } }

  async protectRestartWhile<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.disposed || this.installing) throw new Error('PanePilot is restarting. Wait for the new version before editing.')
    this.pendingOperations++
    try { return await work() }
    finally { this.pendingOperations-- }
  }

  private patch(patch: Partial<AppUpdateState>, coalesce = false): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    if (coalesce) {
      if (!this.progressTimer) {
        this.progressTimer = setTimeout(() => {
          this.progressTimer = null
          if (!this.disposed) this.options.notify(this.get())
        }, 200)
        this.progressTimer.unref?.()
      }
      return
    }
    if (this.progressTimer) clearTimeout(this.progressTimer)
    this.progressTimer = null
    this.options.notify(this.get())
  }

  initialize(): Promise<void> {
    return this.initialization ??= this.start()
  }

  private async start(): Promise<void> {
    if (this.state.phase === 'disabled' || this.disposed) return
    try {
      const config = validateSparkleConfig(await this.options.readConfig())
      const bridge = await this.options.loadBridge()
      if (this.disposed) return
      if (!bridge) throw new Error('Sparkle could not load. Reinstall a complete PanePilot release.')
      this.bridge = bridge
      bridge.setEventHandler((event) => this.receive(event))
      if (!bridge.init({ appcastUrl: config.feedUrl, publicEdKey: config.publicEdKey })) throw new Error('Sparkle could not initialize. Check this build’s signing configuration.')
      // No startup networking, system-profile reporting, or unattended installation.
      bridge.setAutomaticChecks(false)
    } catch (error) {
      this.bridge?.setEventHandler(null)
      this.bridge = null
      this.patch({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  async check(): Promise<AppUpdateState> {
    await this.initialize()
    if (this.disposed || !this.bridge || ['checking', 'downloading', 'ready', 'restarting'].includes(this.state.phase)) return this.get()
    this.patch({ phase: 'checking', version: null, percent: null, stage: 'download', message: 'Checking for updates…' })
    try { this.bridge.checkForUpdates() }
    catch (error) { this.patch({ phase: 'error', message: error instanceof Error ? error.message : String(error) }) }
    return this.get()
  }

  private receive(event: SparkleBridgeEvent): void {
    if (this.disposed || (this.installing && event.type !== 'error')) return
    const version = typeof event.version === 'string' ? event.version.slice(0, 120) : this.state.version
    switch (event.type) {
      case 'checking': this.patch({ phase: 'checking', message: 'Checking for updates…' }); break
      case 'update-available': this.patch({ phase: 'downloading', version, percent: null, stage: 'download', message: 'Downloading a signed update…' }); break
      case 'download-progress': {
        const verifying = event.phase === 'apply'
        this.patch({ phase: 'downloading', stage: verifying ? 'verify' : 'download',
          percent: Number.isFinite(event.percent) ? Math.max(0, Math.min(100, event.percent!)) : null,
          message: verifying ? 'Verifying and preparing the update…' : 'Downloading a signed update…' }, true)
        break
      }
      case 'update-downloaded': this.patch({ phase: 'ready', version, percent: 100, message: 'Update ready. Restart when you’re ready.' }); break
      case 'update-not-available': this.patch({ phase: 'current', version: null, percent: null, message: 'You’re using the latest available version.' }); break
      case 'error':
        this.installing = false
        this.patch({ phase: 'error', percent: null, message: typeof event.message === 'string' ? event.message.slice(0, 1600) : 'The update could not be downloaded or verified. Try again later.' })
        break
    }
  }

  async restart(): Promise<void> {
    if (this.disposed || this.installing || !this.bridge || this.state.phase !== 'ready') throw new Error('Download and verify an update before restarting.')
    if (this.pendingOperations) throw new Error('Wait for file and editor operations to finish before updating.')
    const blocker = this.options.restartBlocker()
    if (blocker) throw new Error(blocker)
    this.installing = true
    this.patch({ phase: 'restarting', message: 'Restarting to install the verified update…' })
    try { this.bridge.installUpdateNow() }
    catch (error) {
      this.installing = false
      this.patch({ phase: 'ready', message: 'The restart failed. Try again after saving your work.' })
      throw error
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.progressTimer) clearTimeout(this.progressTimer)
    this.progressTimer = null
    // An ordinary Quit must not silently authorize a downloaded update.
    if (!this.installing) this.bridge?.discardDownloadedUpdate()
    this.bridge?.setEventHandler(null)
    this.bridge = null
  }
}
