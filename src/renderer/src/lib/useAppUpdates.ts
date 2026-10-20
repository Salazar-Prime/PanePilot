import { useCallback, useEffect, useState } from 'react'
import type { AppUpdateState } from '@shared/appUpdates'
import { updateRestartBlocker } from './updateRestartGuards'

export function useAppUpdates() {
  const [state, setState] = useState<AppUpdateState>({ phase: 'disabled', currentVersion: '', version: null,
    percent: null, stage: 'download', message: 'Restart PanePilot to load the update controls.' })
  useEffect(() => {
    const api = window.projectConsole.updates
    if (!api) return
    let active = true
    let received = false
    const off = api.onChanged((next) => { received = true; if (active) setState(next) })
    void api.get().then((next) => { if (active && !received) setState(next) }).catch(() => {})
    return () => { active = false; off() }
  }, [])
  const check = useCallback(async () => { await window.projectConsole.updates?.check() }, [])
  const restart = useCallback(async () => {
    const blocker = updateRestartBlocker()
    if (blocker) throw new Error(blocker)
    if (!window.projectConsole.updates) throw new Error('Restart PanePilot to load the update controls.')
    await window.projectConsole.updates.restart()
  }, [])
  return { state, check, restart }
}
