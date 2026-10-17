import { useEffect, useRef, useState } from 'react'
import { Bot, ShieldAlert, Sparkles, TerminalSquare, X } from 'lucide-react'
import type { LaunchProfile, StartTerminalInput } from '@shared/types'
import { useModalEscape } from '../lib/modalEscape'
import { useModalShortcuts } from '../lib/modalShortcuts'

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
  const dialogRef = useRef<HTMLElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const submittingRef = useRef(false)
  const [profile, setProfile] = useState<LaunchProfile>('codex')
  const [name, setName] = useState('')
  const [codexThreadId, setCodexThreadId] = useState('')
  const [dangerousMode, setDangerousMode] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const isAgent = profile === 'codex' || profile === 'claude'
  useModalEscape(onClose, true, submitting)
  useModalShortcuts({
    dialogRef,
    onSubmit: () => formRef.current?.requestSubmit(),
    blocked: submitting
  })

  useEffect(() => {
    const focusNameInput = () => nameInputRef.current?.focus()
    const keepFocusInDialog = (event: FocusEvent) => {
      if (!(event.target instanceof Element) || !dialogRef.current) return
      const otherDialog = event.target.closest('[role="dialog"][aria-modal="true"]')
      if (otherDialog && otherDialog !== dialogRef.current) return
      if (!dialogRef.current.contains(event.target)) {
        focusNameInput()
      }
    }
    document.addEventListener('focusin', keepFocusInDialog)
    const frame = window.requestAnimationFrame(focusNameInput)
    return () => {
      document.removeEventListener('focusin', keepFocusInDialog)
      window.cancelAnimationFrame(frame)
    }
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (submittingRef.current) return
    submittingRef.current = true
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
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
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
        <form ref={formRef} onSubmit={submit}>
          <label className="field">
            <span>
              Terminal / tmux name <kbd className="modal-shortcut-hint">⌘1</kbd>
            </span>
            <input
              ref={nameInputRef}
              autoFocus
              data-modal-shortcut
              aria-keyshortcuts="Meta+1 Control+1"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Optional — PanePilot will choose a unique name"
            />
          </label>
          <div className="profile-grid">
            {profiles.map((item, index) => {
              const Icon = item.icon
              return (
                <button
                  type="button"
                  key={item.id}
                  data-modal-shortcut
                  aria-keyshortcuts={`Meta+${index + 2} Control+${index + 2}`}
                  className={`profile-card ${profile === item.id ? 'selected' : ''}`}
                  onClick={() => {
                    setProfile(item.id)
                  }}
                >
                  <Icon size={20} />
                  <strong>{item.label}</strong>
                  <span>{item.description}</span>
                  <kbd className="modal-shortcut-hint">⌘{index + 2}</kbd>
                </button>
              )
            })}
          </div>
          {profile === 'codex' && (
            <label className="field">
              <span>
                Existing Codex thread ID <small>Optional</small>
                <kbd className="modal-shortcut-hint">⌘5</kbd>
              </span>
              <input
                data-modal-shortcut
                aria-keyshortcuts="Meta+5 Control+5"
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
                data-modal-shortcut
                aria-keyshortcuts={
                  profile === 'codex' ? 'Meta+6 Control+6' : 'Meta+5 Control+5'
                }
                checked={dangerousMode}
                onChange={(event) => setDangerousMode(event.target.checked)}
              />
              <ShieldAlert size={19} />
              <span>
                <strong>Disable permission checks</strong>
                <small>Only for isolated or disposable environments</small>
              </span>
              <kbd className="modal-shortcut-hint">⌘{profile === 'codex' ? 6 : 5}</kbd>
            </label>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
              title="Escape"
              aria-keyshortcuts="Escape"
            >
              Cancel <kbd className="modal-shortcut-hint">Esc</kbd>
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={submitting}
              title="Command + Enter"
              aria-keyshortcuts="Meta+Enter Control+Enter"
            >
              {submitting ? 'Starting…' : 'Start terminal'}
              <kbd className="modal-shortcut-hint">⌘↵</kbd>
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
