import { useEffect, useState } from 'react'
import {
  MessageCircleQuestion,
  RotateCcw,
  Send,
  Sparkles
} from 'lucide-react'
import type { Project } from '@shared/types'
import { ManagedTerminal } from './ManagedTerminal'
import { StatusDot } from './StatusDot'
import type { TerminalFileTarget } from '../lib/terminalFileLinks'

export function ProjectQnaPane({
  project,
  onChanged,
  onOpenFile
}: {
  project: Project
  onChanged(): Promise<void>
  onOpenFile?(target: TerminalFileTarget): void
}) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const session =
    project.sessions.find(
      (candidate) =>
        candidate.kind === 'project-qna' && !candidate.archived
    ) ?? null
  const stopped =
    session != null && ['completed', 'error'].includes(session.state)

  useEffect(() => {
    setMessage('')
    setError('')
  }, [project.id])

  useEffect(() => {
    if (!session || stopped) return
    void window.projectConsole.terminals
      .acknowledge(session.id)
      .then(onChanged)
  }, [session?.id])

  async function start() {
    setBusy(true)
    setError('')
    try {
      await window.projectConsole.projectQna.start(project.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      await onChanged()
      setBusy(false)
    }
  }

  async function send() {
    if (!session || !message.trim()) return
    setBusy(true)
    setError('')
    try {
      await window.projectConsole.projectQna.sendPrompt(session.id, message)
      setMessage('')
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!session) {
    return (
      <div className="project-qna-empty capability-empty">
        <div className="empty-orbit">
          <MessageCircleQuestion size={31} />
        </div>
        <span className="eyebrow">ONE CHAT PER PROJECT</span>
        <h2>Ask Codex about {project.name}</h2>
        <p>
          PanePilot keeps this Q&amp;A chat in a dedicated persistent tmux
          session and asks Codex not to modify files.
        </p>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button" onClick={() => void start()} disabled={busy}>
          <Sparkles size={15} /> {busy ? 'Starting…' : 'Start project Q&A'}
        </button>
      </div>
    )
  }

  return (
    <section className="project-qna-pane">
      <header>
        <div>
          <StatusDot state={session.state} />
          <span>
            <strong>Project Q&amp;A</strong>
            <small>Codex · project guidance for {project.name}</small>
          </span>
        </div>
        {stopped && (
          <button
            className="primary-button"
            onClick={() => void start()}
            disabled={busy}
          >
            <RotateCcw size={13} /> {busy ? 'Resuming…' : 'Resume Q&A'}
          </button>
        )}
      </header>
      {error && <p className="action-error">{error}</p>}
      <div className="project-qna-terminal">
        <ManagedTerminal
          session={session}
          projectFolder={project.folder}
          onOpenFile={onOpenFile}
        />
      </div>
      {!stopped && (
        <div className="project-qna-composer">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder="Ask a question about this project…"
            rows={3}
          />
          <button
            className="primary-button"
            onClick={() => void send()}
            disabled={busy || !message.trim()}
          >
            <Send size={13} /> Ask
          </button>
          <small>⌘↵ to send · prompts instruct Codex not to modify files</small>
        </div>
      )}
    </section>
  )
}
