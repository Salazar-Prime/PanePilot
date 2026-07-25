import { useState } from 'react'
import { Bot, ShieldAlert, Sparkles, TerminalSquare, X } from 'lucide-react'
import type { LaunchProfile, StartTerminalInput } from '@shared/types'

const profiles: Array<{
  id: LaunchProfile
  label: string
  description: string
  icon: typeof Bot
}> = [
  { id: 'shell', label: 'Login shell', description: 'Your normal interactive shell', icon: TerminalSquare },
  { id: 'codex', label: 'Codex', description: 'Start an OpenAI coding agent', icon: Sparkles },
  { id: 'claude', label: 'Claude Code', description: 'Start an Anthropic coding agent', icon: Bot }
]

interface Props {
  projectId: string
  onClose(): void
  onStart(input: StartTerminalInput): Promise<void>
}

export function TerminalLauncher({ projectId, onClose, onStart }: Props) {
  const [profile, setProfile] = useState<LaunchProfile>('codex')
  const [name, setName] = useState('')
  const [codexThreadId, setCodexThreadId] = useState('')
  const [dangerousMode, setDangerousMode] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const isAgent = profile === 'codex' || profile === 'claude'

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (
      dangerousMode &&
      !window.confirm(
        'Disable the agent’s permission checks for this terminal? Only use this in an isolated or disposable environment.'
      )
    ) {
      return
    }
    setSubmitting(true)
    setError('')
    try {
      await onStart({
        projectId,
        name: name.trim() || undefined,
        profile,
        codexThreadId:
          profile === 'codex' ? codexThreadId.trim() || undefined : undefined,
        dangerousMode: isAgent && dangerousMode
      })
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal launcher-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launcher-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">NEW TERMINAL</span>
            <h2 id="launcher-title">What do you want to run?</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <form onSubmit={submit}>
          <label className="field">
            <span>Terminal / tmux name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Optional — PanePilot will choose a unique name"
            />
          </label>
          <div className="profile-grid">
            {profiles.map((item) => {
              const Icon = item.icon
              return (
                <button
                  type="button"
                  key={item.id}
                  className={`profile-card ${profile === item.id ? 'selected' : ''}`}
                  onClick={() => {
                    setProfile(item.id)
                    if (item.id === 'shell') setDangerousMode(false)
                  }}
                >
                  <Icon size={20} />
                  <strong>{item.label}</strong>
                  <span>{item.description}</span>
                </button>
              )
            })}
          </div>
          {profile === 'codex' && (
            <label className="field">
              <span>Existing Codex thread ID <small>Optional</small></span>
              <input
                value={codexThreadId}
                onChange={(event) => setCodexThreadId(event.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <small>
                Paste an exact thread ID to run <code>codex resume</code> instead
                of creating a new conversation.
              </small>
            </label>
          )}
          {isAgent && (
            <label className={`danger-option ${dangerousMode ? 'enabled' : ''}`}>
              <input
                type="checkbox"
                checked={dangerousMode}
                onChange={(event) => setDangerousMode(event.target.checked)}
              />
              <ShieldAlert size={19} />
              <span>
                <strong>Disable permission checks</strong>
                <small>Only for isolated or disposable environments</small>
              </span>
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={submitting}
            >
              {submitting ? 'Starting…' : 'Start terminal'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
