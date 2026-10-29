import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Bot, Check, Copy, GitBranch, MessageSquareText, RefreshCw, Search } from 'lucide-react'
import { conversationForest } from '@shared/conversation-hierarchy'
import type {
  ConversationDetail,
  ConversationSummary,
  Project
} from '@shared/types'
import { copyConversationSessionId } from '../lib/conversationSessionId'
import { conversationMessageWindow } from '../lib/conversationMessageWindow'
import { formatConversationDate as formatDate } from '../lib/conversationDate'
import { ConversationList } from './ConversationList'
import { ConversationMessageControls } from './ConversationMessageControls'
import { getConversationHiddenCount, setConversationHiddenCount, subscribeConversationHiddenCount } from '../lib/conversationViewSession'
import { useConversationUserNavigation } from '../lib/useConversationUserNavigation'

export function ChatHistoryPanel({ project }: { project: Project }) {
  const [query, setQuery] = useState('')
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const forest = useMemo(() => conversationForest(conversations), [conversations])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [refresh, setRefresh] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadedDetail, setDetail] = useState<ConversationDetail | null>(null)
  const detail = loadedDetail?.id === selectedId ? loadedDetail : null
  const hiddenCount = useSyncExternalStore(subscribeConversationHiddenCount, getConversationHiddenCount)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const renderKey = JSON.stringify([project.id, detail?.id ?? null])
  const rendered = useMemo(() => conversationMessageWindow(detail?.messages ?? [], hiddenCount), [detail?.messages, hiddenCount])
  const navigation = useConversationUserNavigation(messagesRef, rendered.messages)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [detailError, setDetailError] = useState('')
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null)
  const copiedTimer = useRef<number | null>(null)

  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = 0
  }, [renderKey, rendered.hiddenCount])

  useEffect(() => {
    setSelectedId(null)
    setDetail(null)
    setQuery('')
    setConversations([])
    setExpanded(new Set())
    setDetailError('')
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
        .list(project.id, query, hiddenCount)
        .then((items) => {
          if (!active) return
          setConversations(items)
          setSelectedId((current) =>
            current && items.some((item) => item.id === current && (!query.trim() || item.matchCount > 0))
              ? current
              : (query.trim() ? items.find((item) => item.matchCount > 0) : conversationForest(items)[0]?.conversation)?.id ?? null
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
  }, [project.id, query, refresh, hiddenCount])

  useEffect(() => {
    const ancestors: string[] = []
    const pending = forest.map((node) => ({ node, path: [] as string[] }))
    while (pending.length) {
      const { node, path } = pending.pop()!
      if (node.conversation.id === selectedId) { ancestors.push(...path); break }
      pending.push(...node.children.map((child) => ({ node: child, path: [...path, node.conversation.id] })))
    }
    if (!ancestors.length) return
    setExpanded((current) => ancestors.every((id) => current.has(id)) ? current : new Set([...current, ...ancestors]))
  }, [forest, selectedId])

  useEffect(() => {
    let active = true
    if (!selectedId) return
    setCopiedSessionId(null)
    setDetailError('')
    void window.projectConsole.conversations
      .get(project.id, selectedId)
      .then((conversation) => {
        if (active) setDetail(conversation)
      })
      .catch((caught) => {
        if (active) setDetailError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      active = false
    }
  }, [project.id, selectedId, refresh])

  const parent = useMemo(() => detail?.parentProviderSessionId
    ? conversations.find((item) => item.provider === detail.provider && item.providerSessionId === detail.parentProviderSessionId)
    : undefined, [detail, conversations])

  function toggleSubagents(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
          <div className="chat-list-heading-actions">
            <small title={`${forest.length} chats · ${conversations.length - forest.length} subagents`}>{forest.length}</small>
            <button className="icon-button" aria-label="Refresh chat archives" title="Refresh chat archives" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
            </button>
          </div>
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
            <ConversationList nodes={forest} selectedId={selectedId} expanded={expanded}
              searching={Boolean(query.trim())} onSelect={setSelectedId} onToggle={toggleSubagents} />
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
                    ` · ${detail.provider === 'claude' && detail.parentProviderSessionId ? 'agent' : 'session'} ${detail.providerSessionId.slice(0, 8)}…`}
                </span>
              </div>
              {detail.providerSessionId && (
                <button
                  className="secondary-button chat-detail-copy-button"
                  onClick={() => void copySessionId()}
                  title={`Copy the exact ${detail.provider === 'claude' ? detail.parentProviderSessionId ? 'Claude agent' : 'Claude session' : 'Codex thread'} ID`}
                  aria-live="polite"
                >
                  {copiedSessionId === detail.providerSessionId ? (
                    <Check size={12} />
                  ) : (
                    <Copy size={12} />
                  )}
                  {copiedSessionId === detail.providerSessionId
                    ? 'Copied'
                    : detail.provider === 'claude' && detail.parentProviderSessionId ? 'Copy agent ID' : 'Copy session ID'}
                </button>
              )}
            </header>
            {detail.parentProviderSessionId && (
              <div className="chat-parent-navigation">
                <GitBranch size={12} />
                {parent ? <button onClick={() => setSelectedId(parent.id)} title={parent.title}>← {parent.agentName || parent.title}</button>
                  : <span>Parent chat not available in this archive</span>}
                <span className="chat-subagent-info">
                  <span>Subagent{detail.agentName ? ` · ${detail.agentName}` : ''}</span>
                  {detail.agentPath && <span className="chat-subagent-path" title={`Agent hierarchy path: ${detail.agentPath} (not a filesystem folder)`}>
                    <small>Agent path</small><code>{detail.agentPath}</code>
                  </span>}
                </span>
              </div>
            )}
            <ConversationMessageControls hiddenCount={hiddenCount} total={detail.messages.length}
              previous={navigation.previous} next={navigation.next}
              onChange={setConversationHiddenCount} onJump={navigation.jump} />
            <div className="chat-messages" ref={messagesRef}>
              {rendered.hiddenCount > 0 && !rendered.messages.length && (
                <p className="chat-list-message">All messages are hidden. Lower the number above to see them again.</p>
              )}
              {rendered.messages.map((message) => (
                <article className={`chat-message ${message.role}${message.id === navigation.activeId ? ' navigation-target' : ''}`} key={message.id}
                  data-message-id={message.id} data-message-role={message.role}>
                  <header>
                    <span>{message.role === 'user' ? detail.parentProviderSessionId ? 'Instruction' : 'You' : detail.agentName || detail.provider}</span>
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
            <p>{detailError || (selectedId ? 'Loading conversation…' : 'Select a conversation.')}</p>
            <span>Expand a chat’s subagents to read their conversations.</span>
          </div>
        )}
      </main>
    </div>
  )
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
