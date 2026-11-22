import { validatePowerSaving, type PowerSavingSettings, type PowerSavingState } from '../shared/powerSaving'

export interface IdleChat { id: string; idle: boolean; activityAt: number }
interface Dependencies {
  readSettings(): PowerSavingSettings
  saveSettings(settings: PowerSavingSettings): void
  snapshot(): Promise<IdleChat[]>
  suspend(id: string, cutoff: number, keepAtLeast: number, allowed: () => boolean): Promise<boolean>
  notify(state: PowerSavingState): void
  now?: () => number
}

/** One settlement-scheduled scan; no timer or host reads while disabled. */
export class PowerSavingService {
  private state: PowerSavingState
  private readonly idleSince = new Map<string, number>()
  private readonly retryAfter = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private revision = 0
  private disposed = false
  private readonly now: () => number
  constructor(private readonly deps: Dependencies) {
    this.state = { settings: deps.readSettings(), liveChats: null, suspended: 0, error: null }
    this.now = deps.now ?? Date.now
  }
  get(): PowerSavingState { return { ...this.state, settings: { ...this.state.settings } } }
  start(): void { this.schedule() }
  save(value: unknown): PowerSavingState {
    const settings = validatePowerSaving(value)
    this.deps.saveSettings(settings)
    this.revision++
    this.idleSince.clear()
    this.retryAfter.clear()
    this.state = { ...this.state, settings, error: null }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.schedule()
    this.deps.notify(this.get())
    return this.get()
  }
  private schedule(): void {
    if (this.disposed || !this.state.settings.enabled || this.timer) return
    this.timer = setTimeout(() => { this.timer = null; void this.check().finally(() => this.schedule()) }, 30_000)
    this.timer.unref()
  }
  check(): Promise<void> {
    if (this.running) return this.running
    const task = this.sweep().finally(() => { if (this.running === task) this.running = null })
    this.running = task
    return task
  }
  private async sweep(): Promise<void> {
    if (this.disposed || !this.state.settings.enabled) return
    const revision = this.revision
    const allowed = () => !this.disposed && revision === this.revision && this.state.settings.enabled
    try {
      const chats = await this.deps.snapshot()
      if (!allowed()) return
      const now = this.now()
      const ids = new Set(chats.map(chat => chat.id))
      for (const id of this.idleSince.keys()) if (!ids.has(id)) this.idleSince.delete(id)
      for (const id of this.retryAfter.keys()) if (!ids.has(id)) this.retryAfter.delete(id)
      for (const chat of chats) {
        if (!chat.idle) this.idleSince.delete(chat.id)
        else this.idleSince.set(chat.id, Math.max(this.idleSince.get(chat.id) ?? now, chat.activityAt))
      }
      const { idleMinutes, keepAtLeast } = this.state.settings
      const cutoff = now - idleMinutes * 60_000
      let live = chats.length
      const candidates = chats.filter(chat => chat.idle && this.idleSince.get(chat.id)! <= cutoff && (this.retryAfter.get(chat.id) ?? 0) <= now)
        .sort((a, b) => this.idleSince.get(a.id)! - this.idleSince.get(b.id)!)
      // Bound each sweep; remaining eligible chats wait for the next scan.
      for (const chat of candidates.slice(0, 4)) {
        if (!allowed() || live <= keepAtLeast) break
        if (await this.deps.suspend(chat.id, cutoff, keepAtLeast, allowed)) {
          live--
          this.idleSince.delete(chat.id)
          this.retryAfter.delete(chat.id)
          this.state.suspended++
        } else if (allowed()) {
          // Protected/unknown sub-agents must not monopolize a bounded batch
          // forever. Give the next oldest chats a turn before retrying these.
          this.retryAfter.set(chat.id, this.now() + 60_000)
        }
      }
      if (!allowed()) return
      this.state = { ...this.state, liveChats: live, error: null }
    } catch (error) {
      if (!allowed()) return
      this.state.error = error instanceof Error ? error.message : String(error)
    }
    if (allowed()) this.deps.notify(this.get())
  }
  dispose(): void {
    this.disposed = true
    this.revision++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
