import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Bot, Check, Copy, MessageSquareText, Search } from 'lucide-react'
import type {
  ConversationDetail,
  ConversationSummary,
  Project
} from '@shared/types'
import { copyConversationSessionId } from '../lib/conversationSessionId'

export function ChatHistoryPanel({ project }: { project: Project }) {
  const [query, setQuery] = useState('')
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null)
  const copiedTimer = useRef<number | null>(null)

  useEffect(() => {
    setSelectedId(null)
    setDetail(null)
    setQuery('')
    setCopiedSessionId(null)
  }, [project.id])

  useEffect(
    () => () => {
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current)
    },
    []
  )

  useEffect(() => {
    let active = true
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError('')
      void window.projectConsole.conversations
        .list(project.id, query)
        .then((items) => {
          if (!active) return
          setConversations(items)
          setSelectedId((current) =>
            current && items.some((item) => item.id === current)
              ? current
              : items[0]?.id ?? null
          )
          if (!items.length) setDetail(null)
        })
        .catch((caught) => {
          if (active) setError(caught instanceof Error ? caught.message : String(caught))
        })
        .finally(() => {
          if (active) setLoading(false)
        })
    }, 220)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [project.id, query])

  useEffect(() => {
    let active = true
    if (!selectedId) return
    setCopiedSessionId(null)
    void window.projectConsole.conversations
      .get(project.id, selectedId, query)
      .then((conversation) => {
        if (active) setDetail(conversation)
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      active = false
    }
  }, [project.id, query, selectedId])

  async function copySessionId(): Promise<void> {
    const sessionId = detail?.providerSessionId
    if (!sessionId) return
    try {
      await copyConversationSessionId(
        sessionId,
        window.projectConsole.system.copyText
      )
      setCopiedSessionId(sessionId)
      if (copiedTimer.current != null) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => {
        setCopiedSessionId((current) => (current === sessionId ? null : current))
        copiedTimer.current = null
      }, 1_600)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <div className="chat-history-layout">
      <aside className="chat-list-pane">
        <div className="chat-list-heading">
          <div>
            <span className="eyebrow">LLM ARCHIVES</span>
            <strong>Chat history</strong>
          </div>
          <small>{conversations.length}</small>
        </div>
        <label className="chat-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search complete chat text"
          />
        </label>
        <div className="chat-list">
          {error ? (
            <p className="chat-list-message error-text">{error}</p>
          ) : loading && !conversations.length ? (
            <p className="chat-list-message">Indexing provider archives…</p>
          ) : conversations.length ? (
            conversations.map((conversation) => (
              <button
                key={conversation.id}
                className={conversation.id === selectedId ? 'selected' : ''}
                onClick={() => setSelectedId(conversation.id)}
              >
                <div className="chat-card-meta">
                  <span className={`provider-badge ${conversation.provider}`}>
                    {conversation.provider}
                  </span>
                  <time>{formatDate(conversation.updatedAt)}</time>
                </div>
                <strong>{conversation.title}</strong>
                <p>{conversation.snippet}</p>
                <small>
                  {conversation.messageCount} messages
                  {query && ` · ${conversation.matchCount} matches`}
                </small>
              </button>
            ))
          ) : (
            <p className="chat-list-message">
              {query
                ? 'No archived chats match this search.'
                : 'No Codex or Claude chats match this project folder yet.'}
            </p>
          )}
        </div>
      </aside>
      <main className="chat-detail-pane">
        {detail ? (
          <>
            <header className="chat-detail-heading">
              <div className="chat-detail-icon">
                <Bot size={17} />
              </div>
              <div className="chat-detail-summary">
                <strong>{detail.title}</strong>
                <span>
                  {detail.provider} · {detail.workingDirectory}
                  {detail.providerSessionId &&
                    ` · session ${detail.providerSessionId.slice(0, 8)}…`}
                </span>
              </div>
              {detail.providerSessionId && (
                <button
                  className="secondary-button chat-detail-copy-button"
                  onClick={() => void copySessionId()}
                  title={`Copy the exact ${detail.provider === 'claude' ? 'Claude session' : 'Codex thread'} ID`}
                  aria-live="polite"
                >
                  {copiedSessionId === detail.providerSessionId ? (
                    <Check size={12} />
                  ) : (
                    <Copy size={12} />
                  )}
                  {copiedSessionId === detail.providerSessionId
                    ? 'Copied'
                    : 'Copy session ID'}
                </button>
              )}
            </header>
            <div className="chat-messages">
              {detail.messages.map((message) => (
                <article className={`chat-message ${message.role}`} key={message.id}>
                  <header>
                    <span>{message.role === 'user' ? 'You' : detail.provider}</span>
                    {message.timestamp && <time>{formatDate(message.timestamp)}</time>}
                  </header>
                  <div>{highlight(message.content, query)}</div>
                </article>
              ))}
            </div>
          </>
        ) : (
          <div className="preview-empty">
            <MessageSquareText size={32} />
            <p>Select a conversation.</p>
            <span>Activity events remain in the separate Activity tab.</span>
          </div>
        )}
      </main>
    </div>
  )
}

function formatDate(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
}

function highlight(content: string, query: string): ReactNode {
  const needle = query.trim()
  if (!needle) return content
  const nodes: ReactNode[] = []
  const normalized = content.toLocaleLowerCase()
  const normalizedNeedle = needle.toLocaleLowerCase()
  let start = 0
  let match = normalized.indexOf(normalizedNeedle)
  while (match !== -1) {
    nodes.push(content.slice(start, match))
    nodes.push(<mark key={`${match}-${nodes.length}`}>{content.slice(match, match + needle.length)}</mark>)
    start = match + needle.length
    match = normalized.indexOf(normalizedNeedle, start)
  }
  nodes.push(content.slice(start))
  return nodes
}
