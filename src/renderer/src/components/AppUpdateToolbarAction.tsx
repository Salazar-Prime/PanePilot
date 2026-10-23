import { Download } from 'lucide-react'
import type { AppUpdateState } from '@shared/appUpdates'
import '../app-updates.css'

export function AppUpdateIcon({ state }: { state: AppUpdateState }) {
  const available = state.phase === 'downloading' || state.phase === 'ready'
  return <span className="app-update-icon"><Download size={15} />
    {available && <span className="app-update-icon-dot" aria-hidden="true" />}
  </span>
}

/** An explicit pin owns the button; otherwise reveal it only for a known update. */
export function AppUpdateToolbarAction({ state, pinned, onOpen }: {
  state: AppUpdateState; pinned: boolean; onOpen(): void
}) {
  if (pinned || !['downloading', 'ready'].includes(state.phase)) return null
  const ready = state.phase === 'ready'
  const version = state.version ? ` ${state.version}` : ''
  const detail = ready ? 'Restart to update' : state.stage === 'verify' ? 'Preparing update' : 'Downloading update'
  return <button className="icon-button app-update-toolbar-action"
    aria-label={ready ? 'Update ready' : 'Update available'}
    title={`PanePilot${version} · ${detail}`} onClick={onOpen}>
    <AppUpdateIcon state={state} />
  </button>
}
