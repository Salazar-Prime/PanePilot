export type AppUpdatePhase = 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error' | 'restarting'

export interface AppUpdateState {
  phase: AppUpdatePhase
  currentVersion: string
  version: string | null
  percent: number | null
  stage: 'download' | 'verify'
  message: string
  /** Background checks stay quiet until an update is actually found. */
  background?: boolean
}

export interface AppUpdatesApi {
  get(): Promise<AppUpdateState>
  check(): Promise<AppUpdateState>
  restart(): Promise<void>
  onChanged(listener: (state: AppUpdateState) => void): () => void
}
