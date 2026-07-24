import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type {
  ConversationDetail,
  ConversationMessage,
  ConversationProvider,
  ConversationSummary
} from '../shared/types'

interface ParsedConversation {
  id: string
  provider: ConversationProvider
  title: string
  workingDirectory: string
  updatedAt: string
  messages: ConversationMessage[]
}

interface CacheEntry {
  size: number
  mtimeMs: number
  conversation: ParsedConversation | null
}

type JsonRecord = Record<string, unknown>

function object(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (!Array.isArray(value)) return ''
  return value
    .flatMap((item): string[] => {
      const record = object(item)
      if (!record) return []
      const type = string(record.type)
      if (type && !['text', 'input_text', 'output_text'].includes(type)) return []
      const text = string(record.text)
      return text ? [text] : []
    })
    .join('\n\n')
    .trim()
}

function stableId(provider: ConversationProvider, path: string, archiveId?: string | null): string {
  return createHash('sha256')
    .update(`${provider}:${archiveId || path}`)
    .digest('hex')
    .slice(0, 24)
}

function pushMessage(
  messages: ConversationMessage[],
  role: 'user' | 'assistant',
  content: string,
  timestamp: string | null
): void {
  const cleaned = content.trim()
  if (!cleaned) return
  const previous = messages.at(-1)
  if (previous?.role === role && previous.content === cleaned) return
  messages.push({ id: randomUUID(), role, content: cleaned, timestamp })
}

function defaultTitle(messages: ConversationMessage[]): string {
  const firstUser = messages.find((message) => message.role === 'user')?.content
  if (!firstUser) return 'Untitled conversation'
  const line = firstUser.replace(/\s+/g, ' ').trim()
  return line.length > 78 ? `${line.slice(0, 77)}…` : line
}

export function parseCodexConversation(
  path: string,
  source: string,
  fileUpdatedAt: string
): ParsedConversation | null {
  const eventMessages: ConversationMessage[] = []
  const responseMessages: ConversationMessage[] = []
  let workingDirectory = ''
  let archiveId: string | null = null
  let updatedAt = fileUpdatedAt

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record: JsonRecord
    try {
      record = JSON.parse(line) as JsonRecord
    } catch {
      continue
    }
    const timestamp = string(record.timestamp)
    if (timestamp) updatedAt = timestamp
    const payload = object(record.payload)
    const type = string(record.type)
    if (!payload || !type) continue

    if (type === 'session_meta') {
      workingDirectory = string(payload.cwd) ?? workingDirectory
      archiveId = string(payload.id) ?? archiveId
      continue
    }

    if (type === 'response_item' && payload.type === 'message') {
      const role = payload.role
      if (role === 'user' || role === 'assistant') {
        pushMessage(responseMessages, role, contentText(payload.content), timestamp)
      }
      continue
    }

    if (type === 'event_msg') {
      const eventType = string(payload.type)
      if (eventType === 'user_message') {
        pushMessage(eventMessages, 'user', string(payload.message) ?? '', timestamp)
      } else if (eventType === 'agent_message') {
        pushMessage(eventMessages, 'assistant', string(payload.message) ?? '', timestamp)
      }
    }
  }

  // event_msg is the user-visible Codex transcript. response_item is retained as
  // a fallback for archive versions that do not emit those higher-level events.
  const messages = eventMessages.length ? eventMessages : responseMessages
  if (!workingDirectory || !messages.length) return null
  return {
    id: stableId('codex', path, archiveId),
    provider: 'codex',
    title: defaultTitle(messages),
    workingDirectory,
    updatedAt,
    messages
  }
}

export function parseClaudeConversation(
  path: string,
  source: string,
  fileUpdatedAt: string
): ParsedConversation | null {
  const messages: ConversationMessage[] = []
  let workingDirectory = ''
  let archiveId: string | null = null
  let summary = ''
  let updatedAt = fileUpdatedAt

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record: JsonRecord
    try {
      record = JSON.parse(line) as JsonRecord
    } catch {
      continue
    }
    const timestamp = string(record.timestamp)
    if (timestamp) updatedAt = timestamp
    workingDirectory = string(record.cwd) ?? workingDirectory
    archiveId = string(record.sessionId) ?? archiveId
    const type = string(record.type)

    if (type === 'summary') {
      summary = string(record.summary) ?? summary
      continue
    }
    if (type !== 'user' && type !== 'assistant') continue
    const message = object(record.message)
    if (!message) continue
    pushMessage(messages, type, contentText(message.content), timestamp)
  }

  if (!workingDirectory || !messages.length) return null
  return {
    id: stableId('claude', path, archiveId),
    provider: 'claude',
    title: summary || defaultTitle(messages),
    workingDirectory,
    updatedAt,
    messages
  }
}

function collectJsonlFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  return files
}

function countMatches(text: string, query: string): number {
  if (!query) return 0
  let count = 0
  let offset = 0
  const normalized = text.toLocaleLowerCase()
  while ((offset = normalized.indexOf(query, offset)) !== -1) {
    count += 1
    offset += query.length
  }
  return count
}

function snippetFor(conversation: ParsedConversation, query: string): string {
  const fallback = conversation.messages.at(-1)?.content ?? ''
  if (!query) return fallback.replace(/\s+/g, ' ').slice(0, 180)
  const matching = conversation.messages.find((message) =>
    message.content.toLocaleLowerCase().includes(query)
  )
  const content = (matching?.content ?? fallback).replace(/\s+/g, ' ')
  const index = content.toLocaleLowerCase().indexOf(query)
  if (index < 0) return content.slice(0, 180)
  const start = Math.max(0, index - 65)
  const end = Math.min(content.length, index + query.length + 105)
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`
}

export class ConversationIndexer {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly roots: Array<{ provider: ConversationProvider; path: string }> = [
    { provider: 'codex', path: join(homedir(), '.codex', 'sessions') },
    { provider: 'claude', path: join(homedir(), '.claude', 'projects') }
  ]

  list(projectFolder: string, query = ''): ConversationSummary[] {
    const normalizedFolder = resolve(projectFolder)
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return this.indexAll()
      .filter((conversation) => resolve(conversation.workingDirectory) === normalizedFolder)
      .map((conversation) => {
        const searchable = [
          conversation.title,
          conversation.workingDirectory,
          ...conversation.messages.map((message) => message.content)
        ]
        const matchCount = normalizedQuery
          ? searchable.reduce((total, value) => total + countMatches(value, normalizedQuery), 0)
          : 0
        return {
          id: conversation.id,
          provider: conversation.provider,
          title: conversation.title,
          workingDirectory: conversation.workingDirectory,
          updatedAt: conversation.updatedAt,
          messageCount: conversation.messages.length,
          snippet: snippetFor(conversation, normalizedQuery),
          matchCount
        }
      })
      .filter((conversation) => !normalizedQuery || conversation.matchCount > 0)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }

  get(projectFolder: string, id: string, query = ''): ConversationDetail {
    const conversation = this.indexAll().find((candidate) => candidate.id === id)
    if (
      !conversation ||
      resolve(conversation.workingDirectory) !== resolve(projectFolder)
    ) {
      throw new Error('Conversation not found for this project.')
    }
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const searchable = [
      conversation.title,
      conversation.workingDirectory,
      ...conversation.messages.map((message) => message.content)
    ]
    return {
      id: conversation.id,
      provider: conversation.provider,
      title: conversation.title,
      workingDirectory: conversation.workingDirectory,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
      snippet: snippetFor(conversation, normalizedQuery),
      matchCount: normalizedQuery
        ? searchable.reduce(
            (total, value) => total + countMatches(value, normalizedQuery),
            0
          )
        : 0,
      messages: conversation.messages
    }
  }

  private indexAll(): ParsedConversation[] {
    const found: ParsedConversation[] = []
    const livePaths = new Set<string>()
    for (const root of this.roots) {
      for (const path of collectJsonlFiles(root.path)) {
        livePaths.add(path)
        const stat = statSync(path)
        const cached = this.cache.get(path)
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          if (cached.conversation) found.push(cached.conversation)
          continue
        }
        let conversation: ParsedConversation | null = null
        try {
          const source = readFileSync(path, 'utf8')
          const updatedAt = stat.mtime.toISOString()
          conversation =
            root.provider === 'codex'
              ? parseCodexConversation(path, source, updatedAt)
              : parseClaudeConversation(path, source, updatedAt)
        } catch {
          conversation = null
        }
        this.cache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, conversation })
        if (conversation) found.push(conversation)
      }
    }
    for (const path of this.cache.keys()) {
      if (!livePaths.has(path)) this.cache.delete(path)
    }
    return found
  }
}
