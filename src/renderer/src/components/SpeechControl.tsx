import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  ChevronDown,
  Cloud,
  LoaderCircle,
  Play,
  Settings2,
  ShieldCheck,
  Square,
  Volume2
} from 'lucide-react'
import type {
  SpeechConnectionTestResult,
  SpeechReadingMode,
  SpeechStatus
} from '@shared/types'
import {
  selectedDocumentText,
  speechContentFor
} from '../lib/speechContent'

const DEFAULT_VOICES = [
  'en-US-Neural2-A',
  'en-US-Neural2-C',
  'en-US-Neural2-D',
  'en-US-Neural2-E',
  'en-US-Neural2-F',
  'en-US-Neural2-G',
  'en-US-Neural2-H',
  'en-US-Neural2-I',
  'en-US-Neural2-J'
]

function activeFieldText(): string {
  const active = document.activeElement
  if (active instanceof HTMLTextAreaElement) return active.value.trim()
  if (
    active instanceof HTMLInputElement &&
    ['text', 'search', 'url', 'email', 'tel'].includes(active.type)
  ) {
    return active.value.trim()
  }
  return ''
}

function activePaneRoot(): HTMLElement | null {
  const focusedPane = document.querySelector<HTMLElement>(
    '.workspace-pane.focused'
  )
  if (focusedPane?.getClientRects().length) return focusedPane

  const visiblePane = [
    ...document.querySelectorAll<HTMLElement>('.workspace-pane')
  ].find((element) => element.getClientRects().length > 0)
  return (
    visiblePane ??
    document.querySelector<HTMLElement>('.main-content') ??
    document.querySelector<HTMLElement>('main')
  )
}

function visibleTerminalContent(root: HTMLElement | null) {
  const visibleTerminal = [...(root?.querySelectorAll<HTMLElement>(
    '[data-speech-terminal-id]'
  ) ?? [])].find((element) => element.getClientRects().length > 0)
  const visibleId = visibleTerminal?.dataset.speechTerminalId ?? null
  return speechContentFor(visibleId)
}

function readableText(): string {
  const documentSelection = selectedDocumentText()
  if (documentSelection) return documentSelection

  const root = activePaneRoot()
  const terminal = visibleTerminalContent(root)
  if (terminal?.selectedText) return terminal.selectedText

  const fieldText = activeFieldText()
  if (fieldText) return fieldText

  if (terminal?.visibleText) return terminal.visibleText
  return root?.innerText.trim() ?? ''
}

function usageLabel(status: SpeechStatus | null): string {
  if (!status) return 'Loading usage…'
  const { usedCharacters, monthlyCharacterLimit } = status.usage
  return `${usedCharacters.toLocaleString()} of ${monthlyCharacterLimit.toLocaleString()} characters used`
}

function messageFor(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

export function SpeechControl() {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<SpeechStatus | null>(null)
  const [voices, setVoices] = useState(DEFAULT_VOICES)
  const [connection, setConnection] =
    useState<SpeechConnectionTestResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [voiceName, setVoiceName] = useState('en-US-Neural2-F')
  const [speakingRate, setSpeakingRate] = useState(1)
  const [pitch, setPitch] = useState(0)
  const [monthlyCharacterLimit, setMonthlyCharacterLimit] = useState(950_000)
  const rootRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const playbackIdRef = useRef(0)

  useEffect(() => {
    void refreshStatus()
  }, [])

  useEffect(() => {
    if (!open) return
    function close(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  useEffect(
    () => () => {
      playbackIdRef.current += 1
      audioRef.current?.pause()
      audioRef.current = null
    },
    []
  )

  async function refreshStatus(): Promise<void> {
    try {
      const next = await window.projectConsole.speech.status()
      setStatus(next)
      setVoiceName(next.settings.voiceName)
      setSpeakingRate(next.settings.speakingRate)
      setPitch(next.settings.pitch)
      setMonthlyCharacterLimit(next.settings.monthlyCharacterLimit)
    } catch (caught) {
      setError(messageFor(caught))
    }
  }

  function stop(): void {
    playbackIdRef.current += 1
    audioRef.current?.pause()
    audioRef.current = null
    setLoading(false)
    setSpeaking(false)
  }

  async function play(url: string, playbackId: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const audio = new Audio(url)
      audioRef.current = audio
      audio.addEventListener('ended', () => resolve(), { once: true })
      audio.addEventListener('pause', () => resolve(), { once: true })
      audio.addEventListener(
        'error',
        () => reject(new Error('The generated speech audio could not be played.')),
        { once: true }
      )
      if (playbackId !== playbackIdRef.current) {
        resolve()
        return
      }
      void audio.play().catch(reject)
    })
  }

  async function read(mode: SpeechReadingMode): Promise<void> {
    setOpen(false)
    setError('')
    const text = readableText()
    if (!text) {
      setError('There is no readable text in the active pane.')
      setOpen(true)
      return
    }

    stop()
    const playbackId = playbackIdRef.current
    setLoading(true)
    try {
      const result = await window.projectConsole.speech.synthesize({ text, mode })
      setStatus((current) =>
        current
          ? {
              ...current,
              usage:
                result.usage.usedCharacters >= current.usage.usedCharacters
                  ? result.usage
                  : current.usage
            }
          : current
      )
      if (playbackId !== playbackIdRef.current) return
      setLoading(false)
      setSpeaking(true)
      for (const url of result.audioDataUrls) {
        if (playbackId !== playbackIdRef.current) break
        await play(url, playbackId)
      }
    } catch (caught) {
      if (playbackId === playbackIdRef.current) {
        setError(messageFor(caught))
        setOpen(true)
      }
    } finally {
      if (playbackId === playbackIdRef.current) {
        audioRef.current = null
        setLoading(false)
        setSpeaking(false)
      }
    }
  }

  async function testConnection(): Promise<void> {
    setTesting(true)
    setError('')
    setConnection(null)
    try {
      const result = await window.projectConsole.speech.testConnection()
      setConnection(result)
      if (result.voices.length) {
        setVoices([...new Set([...DEFAULT_VOICES, ...result.voices])].sort())
      }
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setTesting(false)
    }
  }

  async function saveSettings(): Promise<void> {
    setSaving(true)
    setError('')
    try {
      const next = await window.projectConsole.speech.updateSettings({
        voiceName,
        speakingRate,
        pitch,
        monthlyCharacterLimit
      })
      setStatus(next)
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setSaving(false)
    }
  }

  const usedPercent = status
    ? Math.min(
        100,
        (status.usage.usedCharacters / status.usage.monthlyCharacterLimit) * 100
      )
    : 0

  return (
    <div className="speech-control" ref={rootRef}>
      <button
        className={`icon-button ${speaking ? 'active' : ''}`}
        aria-label={speaking || loading ? 'Stop reading aloud' : 'Read active pane aloud'}
        title={speaking || loading ? 'Stop reading aloud' : 'Read active pane aloud'}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (speaking || loading) stop()
          else void read('concise')
        }}
      >
        {loading ? (
          <LoaderCircle className="spin" size={16} />
        ) : speaking ? (
          <Square size={14} />
        ) : (
          <Volume2 size={16} />
        )}
      </button>
      <button
        className="speech-menu-button"
        aria-label="Read-aloud settings"
        aria-expanded={open}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
      >
        <ChevronDown size={11} />
      </button>

      {open && (
        <div className="speech-popover">
          <header>
            <div>
              <span className="eyebrow">GOOGLE CLOUD</span>
              <strong>Read aloud</strong>
            </div>
            <Cloud size={18} />
          </header>

          <div className="speech-actions">
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void read('concise')}
            >
              <Play size={14} /> Read naturally
            </button>
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void read('verbatim')}
            >
              <Volume2 size={14} /> Read exact text
            </button>
            {(speaking || loading) && (
              <button onClick={stop}>
                <Square size={13} /> Stop
              </button>
            )}
          </div>

          <div className="speech-usage">
            <div>
              <ShieldCheck size={15} />
              <span>{usageLabel(status)}</span>
            </div>
            <div className="speech-usage-track">
              <i style={{ width: `${usedPercent}%` }} />
            </div>
            <small>
              Resets at midnight Pacific time on the first day of each month.
            </small>
          </div>

          <div className="speech-settings-grid">
            <label>
              Neural2 voice
              <select value={voiceName} onChange={(event) => setVoiceName(event.target.value)}>
                {voices.map((voice) => (
                  <option key={voice} value={voice}>
                    {voice}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Speed <span>{speakingRate.toFixed(2)}×</span>
              <input
                type="range"
                min="0.75"
                max="1.25"
                step="0.05"
                value={speakingRate}
                onChange={(event) => setSpeakingRate(Number(event.target.value))}
              />
            </label>
            <label>
              Pitch <span>{pitch > 0 ? '+' : ''}{pitch.toFixed(1)}</span>
              <input
                type="range"
                min="-5"
                max="5"
                step="0.5"
                value={pitch}
                onChange={(event) => setPitch(Number(event.target.value))}
              />
            </label>
            <label>
              Monthly device limit
              <input
                type="number"
                min="1000"
                max="1000000"
                step="1000"
                value={monthlyCharacterLimit}
                onChange={(event) =>
                  setMonthlyCharacterLimit(Number(event.target.value))
                }
              />
            </label>
          </div>

          <p className="speech-safety-note">
            The default 950,000 limit leaves a 50,000-character buffer. This ledger
            covers only this PanePilot installation; other apps and projects using the
            same billing account count toward Google’s shared free tier.
          </p>

          <div className="speech-setup">
            <strong><Settings2 size={14} /> Authentication</strong>
            <p>
              PanePilot uses Google Application Default Credentials and stores no
              Google secret. Enable Cloud Text-to-Speech, then run:
            </p>
            <code>gcloud auth application-default login</code>
            <code>
              gcloud auth application-default set-quota-project YOUR_PROJECT_ID
            </code>
            {connection && (
              <span className={connection.ok ? 'success' : 'error'}>
                {connection.ok && <CheckCircle2 size={13} />}
                {connection.message}
              </span>
            )}
          </div>

          {error && <p className="speech-error">{error}</p>}

          <footer>
            <button
              className="secondary-button"
              disabled={testing}
              onClick={() => void testConnection()}
            >
              {testing && <LoaderCircle className="spin" size={13} />}
              Test Google
            </button>
            <button
              className="primary-button"
              disabled={saving}
              onClick={() => void saveSettings()}
            >
              {saving && <LoaderCircle className="spin" size={13} />}
              Save
            </button>
          </footer>
        </div>
      )}
    </div>
  )
}
