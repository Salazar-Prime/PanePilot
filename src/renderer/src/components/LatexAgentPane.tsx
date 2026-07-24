import { useMemo, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  Bot,
  MessageCircleQuestion,
  PencilLine,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2
} from 'lucide-react'
import type {
  LatexChatMode,
  LatexSection,
  TerminalSession
} from '@shared/types'
import { ManagedTerminal } from './ManagedTerminal'
import { StatusDot } from './StatusDot'

interface Props {
  sessions: TerminalSession[]
  archivedSessions: TerminalSession[]
  sections: LatexSection[]
  activeSessionId: string | null
  onSelectSession(id: string): void
  onNewChat(): void
  onChanged(): Promise<void>
  onPromptSent(sessionId: string): void
}

export function LatexAgentPane({
  sessions,
  archivedSessions,
  sections,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onChanged,
  onPromptSent
}: Props) {
  const [message, setMessage] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? null
  const sectionById = useMemo(
    () => new Map(sections.map((section) => [section.id, section])),
    [sections]
  )

  function scopeLabel(session: TerminalSession): string {
    const chat = session.latexChat
    if (!chat || chat.scope === 'project') return 'Whole project'
    return sectionById.get(chat.sectionId ?? '')?.title ?? 'Removed section'
  }

  async function setMode(mode: LatexChatMode) {
    if (!activeSession?.latexChat) return
    setError('')
    try {
      await window.projectConsole.latex.setChatMode(activeSession.id, mode)
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function send() {
    if (!activeSession || !message.trim()) return
    setSending(true)
    setError('')
    try {
      await window.projectConsole.latex.sendPrompt(activeSession.id, message)
      setMessage('')
      onPromptSent(activeSession.id)
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSending(false)
    }
  }

  async function stop() {
    if (!activeSession) return
    if (!window.confirm(`Stop “${activeSession.name}”? Its tmux output will be kept.`)) return
    await window.projectConsole.terminals.stop(activeSession.id)
    await onChanged()
  }

  async function resume() {
    if (!activeSession) return
    await window.projectConsole.terminals.resumeAgent(activeSession.id)
    await onChanged()
  }

  async function archive() {
    if (!activeSession) return
    await window.projectConsole.terminals.archive(activeSession.id)
    await onChanged()
  }

  async function remove() {
    if (!activeSession) return
    if (
      !window.confirm(
        `Permanently delete “${activeSession.name}” and its saved terminal output? The provider conversation archive will remain.`
      )
    )
      return
    await window.projectConsole.terminals.delete(activeSession.id)
    await onChanged()
  }

  async function restoreArchived(session: TerminalSession) {
    await window.projectConsole.terminals.restore(session.id)
    setShowArchived(false)
    onSelectSession(session.id)
    await onChanged()
  }

  async function removeArchived(session: TerminalSession) {
    if (
      !window.confirm(
        `Permanently delete “${session.name}” and its saved terminal output? The provider conversation archive will remain.`
      )
    )
      return
    await window.projectConsole.terminals.delete(session.id)
    await onChanged()
  }

  function run(action: Promise<void>) {
    void action.catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught))
    })
  }

  return (
    <aside className="latex-agent-pane">
      <header className="latex-agent-heading">
        <div>
          <span className="eyebrow">AGENT MARGIN</span>
          <strong>Writing chats</strong>
        </div>
        <div className="latex-agent-heading-actions">
          {archivedSessions.length > 0 && (
            <button
              className="secondary-button"
              onClick={() => setShowArchived((current) => !current)}
              title="Archived writing chats"
            >
              <Archive size={12} /> {archivedSessions.length}
            </button>
          )}
          <button className="secondary-button" onClick={onNewChat}>
            <Plus size={13} /> New
          </button>
        </div>
      </header>

      {showArchived && (
        <div className="latex-archived-chats">
          <strong>Archived chats</strong>
          {archivedSessions.map((session) => (
            <div key={session.id}>
              <StatusDot state={session.state} compact />
              <span>{session.name}</span>
              <button onClick={() => run(restoreArchived(session))}>
                <ArchiveRestore size={11} /> Restore
              </button>
              <button
                className="danger-text"
                onClick={() => run(removeArchived(session))}
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {sessions.length > 0 && (
        <div className="latex-chat-switcher">
          {sessions.map((session) => (
            <button
              key={session.id}
              className={activeSession?.id === session.id ? 'active' : ''}
              onClick={() => onSelectSession(session.id)}
              title={`${session.name} · ${scopeLabel(session)}`}
            >
              <StatusDot state={session.state} compact />
              {session.profile === 'codex' ? <Sparkles size={12} /> : <Bot size={12} />}
              <span>{session.name}</span>
              {session.latexChat && (
                <small className={session.latexChat.mode}>
                  {session.latexChat.mode}
                </small>
              )}
            </button>
          ))}
        </div>
      )}

      {activeSession?.latexChat ? (
        <>
          <div className="latex-chat-toolbar">
            <div className="latex-chat-scope">
              <span>{scopeLabel(activeSession)}</span>
              <small>{activeSession.profile === 'codex' ? 'Codex' : 'Claude'}</small>
            </div>
            <div className="latex-mode-toggle" aria-label="Chat mode">
              <button
                className={activeSession.latexChat.mode === 'ask' ? 'active' : ''}
                onClick={() => void setMode('ask')}
                title="Ask without changing files"
              >
                <MessageCircleQuestion size={12} /> Ask
              </button>
              <button
                className={activeSession.latexChat.mode === 'edit' ? 'active edit' : 'edit'}
                onClick={() => void setMode('edit')}
                title="Allow edits in the attached scope"
              >
                <PencilLine size={12} /> Edit
              </button>
            </div>
          </div>

          <div className="latex-agent-terminal">
            <ManagedTerminal session={activeSession} />
          </div>

          {['completed', 'error'].includes(activeSession.state) ? (
            <div className="latex-chat-ended">
              <span>This tmux chat is stopped.</span>
              <div>
                {(activeSession.providerSessionId ?? activeSession.providerSessionName) && (
                  <button onClick={() => run(resume())}>
                    <RotateCcw size={12} /> Resume
                  </button>
                )}
                <button onClick={() => run(archive())}>
                  <Archive size={12} /> Archive
                </button>
                <button className="danger-text" onClick={() => run(remove())}>
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </div>
          ) : (
            <div className="latex-composer">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void send()
                  }
                }}
                placeholder={
                  activeSession.latexChat.mode === 'ask'
                    ? `Ask about ${scopeLabel(activeSession).toLocaleLowerCase()}…`
                    : `Describe the edit for ${scopeLabel(activeSession).toLocaleLowerCase()}…`
                }
                rows={3}
              />
              <div>
                <button
                  className="latex-stop-button"
                  onClick={() => run(stop())}
                  title="Stop chat"
                >
                  <Square size={12} />
                </button>
                <span>⌘↵ to send</span>
                <button
                  className="primary-button"
                  onClick={() => void send()}
                  disabled={sending || !message.trim()}
                >
                  <Send size={13} /> {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          )}
          {error && <p className="latex-agent-error">{error}</p>}
        </>
      ) : (
        <div className="latex-agent-empty">
          <div>
            <Sparkles size={25} />
          </div>
          <strong>Attach a writing agent</strong>
          <p>
            Scope a persistent Codex or Claude chat to the whole paper or one section.
          </p>
          <button className="primary-button" onClick={onNewChat}>
            <Plus size={14} /> New chat
          </button>
        </div>
      )}
    </aside>
  )
}
