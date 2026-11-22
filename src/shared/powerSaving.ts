export interface PowerSavingSettings {
  enabled: boolean
  idleMinutes: number
  keepAtLeast: number
}

export const DEFAULT_POWER_SAVING: PowerSavingSettings = { enabled: false, idleMinutes: 30, keepAtLeast: 3 }

export function validatePowerSaving(value: unknown): PowerSavingSettings {
  const input = value as Partial<PowerSavingSettings> | null
  if (!input || typeof input.enabled !== 'boolean' || !Number.isInteger(input.idleMinutes) ||
      input.idleMinutes! < 1 || input.idleMinutes! > 10080 || !Number.isInteger(input.keepAtLeast) ||
      input.keepAtLeast! < 0 || input.keepAtLeast! > 1000) {
    throw new Error('Choose an idle timeout of 1–10,080 minutes and a minimum of 0–1,000 chats.')
  }
  return { enabled: input.enabled, idleMinutes: input.idleMinutes!, keepAtLeast: input.keepAtLeast! }
}

export interface PowerSavingState {
  settings: PowerSavingSettings
  liveChats: number | null
  suspended: number
  error: string | null
}

export interface AppMemorySnapshot {
  totalBytes: number
  processes: Array<{ pid: number; name: string; bytes: number }>
  sampledAt: string
}

export interface PowerSavingApi {
  get(): Promise<PowerSavingState>
  save(settings: PowerSavingSettings): Promise<PowerSavingState>
  memory(): Promise<AppMemorySnapshot>
  onChanged(listener: (state: PowerSavingState) => void): () => void
}
