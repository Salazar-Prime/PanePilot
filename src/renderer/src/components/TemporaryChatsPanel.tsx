import { useEffect, useMemo, useRef, useState } from 'react'
import {
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  X
} from 'lucide-react'
import type { Project, TerminalSession } from '@shared/types'
import { useModalEscape } from '../lib/modalEscape'
import { ManagedTerminal } from './ManagedTerminal'
import { StatusDot } from './StatusDot'

interface Props {
  project: Project
  createRequest: number | null
  onChanged(): Promise<void>
  onClose(): void
}

export function TemporaryChatsPanel({
  project,
  createRequest,
  onChanged,
  onClose
}: Props) {
  const chats = useMemo(
    () =>
      project.sessions.filter(
        (session) => session.kind === 'temporary-chat' && !session.archived
      ),
    [project.sessions]
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const handledCreateRequest = useRef<number | null>(null)
  const selected =
    chats.find((chat) => chat.id === selectedId) ?? chats[0] ?? null
  const stopped =
    selected != null && ['completed', 'error'].includes(selected.state)

  useModalEscape(onClose, true, busy)

  useEffect(() => {
    setSelectedId(null)
    setMessage('')
    setError('')
  }, [project.id])

  useEffect(() => {
    if (!selected || stopped) return
    void window.projectConsole.terminals
      .acknowledge(selected.id)
      .then(onChanged)
  }, [selected?.id])

  useEffect(() => {
    if (
      createRequest == null ||
      handledCreateRequest.current === createRequest
    ) {
      return
    }
    handledCreateRequest.current = createRequest
    void startChat()
  }, [createRequest])

  async function startChat() {
    setBusy(true)
    setError('')
    try {
      const session = await window.projectConsole.temporaryChats.start(project.id)
      setSelectedId(session.id)
      setMessage('')
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      await onChanged()
      setBusy(false)
    }
  }

  async function send() {
    if (!selected || !message.trim() || stopped) return
    setBusy(true)
    setError('')
    try {
      await window.projectConsole.temporaryChats.sendPrompt(
        selected.id,
        message
      )
      setMessage('')
      await onChanged()
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setBusy(false)
    }
  }

  async function clearChat(chat: TerminalSession) {
    if (
      !window.confirm(
        `Clear “${chat.name}”? PanePilot will stop its exact tmux session and remove its saved output. The Codex conversation archive will remain untouched.`
      )
    ) {
      return
    }
    setBusy(true)
    setError('')
    try {
      await window.projectConsole.temporaryChats.clear(chat.id)
      if (selectedId === chat.id) setSelectedId(null)
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      await onChanged()
      setBusy(false)
    }
  }

  async function forceReload() {
    if (!selected) return
    setBusy(true)
    setError('')
    try {
      await window.projectConsole.terminals.forceReloadAgent(selected.id)
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      await onChanged()
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop temporary-chats-backdrop"
      role="presentation"
      onMouseDown={() => !busy && onClose()}
    >
      <section
        className="modal temporary-chats-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="temporary-chats-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="temporary-chats-heading">
          <div>
            <span className="eyebrow">UNTIL YOU CLEAR THEM</span>
            <h2 id="temporary-chats-title">Quick Codex chats</h2>
            <small>{project.name}</small>
          </div>
          <div>
            <button
              className="secondary-button"
              onClick={() => void startChat()}
              disabled={busy}
            >
              <Plus size={14} /> New chat
            </button>
            <button
              className="icon-button"
              onClick={onClose}
              disabled={busy}
              aria-label="Close temporary chats"
            >
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="temporary-chats-layout">
          <aside className="temporary-chat-list">
            {chats.length === 0 ? (
              <div className="temporary-chat-list-empty">
                <MessageSquarePlus size={20} />
                <strong>No quick chats</strong>
                <span>Create one for a short-lived Codex conversation.</span>
              </div>
            ) : (
              chats.map((chat) => (
                <button
                  key={chat.id}
                  className={chat.id === selected?.id ? 'selected' : ''}
                  onClick={() => setSelectedId(chat.id)}
                >
                  <StatusDot state={chat.state} compact />
                  <span>
                    <strong>{chat.name}</strong>
                    <small>{chat.state.replace('-', ' ')}</small>
                  </span>
                </button>
              ))
            )}
          </aside>

          <div className="temporary-chat-workspace">
            {selected ? (
              <>
                <div className="temporary-chat-toolbar">
                  <span>
                    <StatusDot state={selected.state} />
                    <strong>{selected.name}</strong>
                  </span>
                  <div>
                    <button
                      className="secondary-button"
                      onClick={() => void forceReload()}
                      disabled={busy}
                      title="Restart Codex in this chat, even before a thread ID is linked"
                    >
                      <RefreshCw size={13} /> Force reload
                    </button>
                    <button
                      className="secondary-button danger-text"
                      onClick={() => void clearChat(selected)}
                      disabled={busy}
                    >
                      <Trash2 size={13} /> Clear
                    </button>
                  </div>
                </div>
                {error && <p className="action-error">{error}</p>}
                <div className="temporary-chat-terminal">
                  <ManagedTerminal
                    session={selected}
                    projectFolder={project.folder}
                    retainOutputOnExit
                  />
                </div>
                {!stopped && (
                  <div className="temporary-chat-composer">
                    <textarea
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'Enter' &&
                          (event.metaKey || event.ctrlKey)
                        ) {
                          event.preventDefault()
                          void send()
                        }
                      }}
                      placeholder="Message Codex…"
                      rows={2}
                    />
                    <button
                      className="primary-button"
                      onClick={() => void send()}
                      disabled={busy || !message.trim()}
                    >
                      <Send size={13} /> Send
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="temporary-chat-empty">
                <MessageSquarePlus size={32} />
                <span className="eyebrow">QUICK CONVERSATION</span>
                <h3>Start a temporary Codex chat</h3>
                <p>
                  It stays attached to this project across restarts and remains
                  outside your terminal tabs until you clear it.
                </p>
                {error && <p className="form-error">{error}</p>}
                <button
                  className="primary-button"
                  onClick={() => void startChat()}
                  disabled={busy}
                >
                  <Plus size={14} /> {busy ? 'Starting…' : 'New quick chat'}
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
