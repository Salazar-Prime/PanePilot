import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { conversationsWithDescendants, matchingConversations } from '../shared/conversation-hierarchy'
import { conversationDisplayWindow } from '../shared/conversation-messages'
import { subagentHeader } from './codex-subagents'
import type {
  ConversationDetail,
  ConversationMessage,
  ConversationProvider,
  ConversationSummary
} from '../shared/types'

interface ParsedConversation {
  id: string
  provider: ConversationProvider
  providerSessionId: string | null
  parentProviderSessionId: string | null
  agentName: string | null
  agentPath: string | null
  title: string
  workingDirectory: string
  updatedAt: string
  messages: ConversationMessage[]
}

export interface ConversationRoot { provider: ConversationProvider; path: string }
export interface ConversationCacheOptions { maxDetailBytes?: number; maxDetailEntries?: number }
interface CacheEntry {
  fingerprint: string
  provider: ConversationProvider
  summary: ConversationSummary | null
}
interface DetailEntry { conversation: ParsedConversation; bytes: number }

export const MAX_CONVERSATION_DETAIL_BYTES = 16 * 1024 * 1024
export const MAX_CONVERSATION_DETAIL_ENTRIES = 8

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

function readFirstJsonlLine(path: string): string {
  const descriptor = openSync(path, 'r')
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (total < 1024 * 1024) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, 1024 * 1024 - total))
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, total)
      if (!bytesRead) break
      const chunk = buffer.subarray(0, bytesRead)
      const newline = chunk.indexOf(10)
      chunks.push(newline >= 0 ? chunk.subarray(0, newline) : chunk)
      total += newline >= 0 ? newline : bytesRead
      if (newline >= 0) break
    }
  } finally {
    closeSync(descriptor)
  }
  return Buffer.concat(chunks).toString('utf8')
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
  let parentProviderSessionId: string | null = null
  let agentName: string | null = null
  let agentPath: string | null = null
  let subagentStartedAt = NaN
  let updatedAt = fileUpdatedAt

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record: JsonRecord
    try {
      const parsed = object(JSON.parse(line))
      if (!parsed) continue
      record = parsed
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
      archiveId = string(payload.id) ?? string(payload.session_id) ?? archiveId
      const header = subagentHeader(line)
      parentProviderSessionId = header?.parentId ?? null
      agentPath = header?.path || null
      agentName = parentProviderSessionId ? header?.name || agentPath?.split('/').filter(Boolean).at(-1) || null : null
      subagentStartedAt = parentProviderSessionId ? Date.parse(header?.startedAt ?? '') : NaN
      continue
    }

    if (Number.isFinite(subagentStartedAt) && (!timestamp || Date.parse(timestamp) < subagentStartedAt)) continue

    if (type === 'response_item' && payload.type === 'message') {
      const role = payload.role
      if ((role === 'user' || role === 'assistant') && payload.phase !== 'analysis') {
        pushMessage(responseMessages, role, contentText(payload.content), timestamp)
      }
      continue
    }
    if (type === 'response_item' && payload.type === 'agent_message' && parentProviderSessionId && agentPath && payload.author === agentPath) {
      pushMessage(responseMessages, 'assistant', contentText(payload.content), timestamp)
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
    providerSessionId: archiveId,
    parentProviderSessionId,
    agentName,
    agentPath: parentProviderSessionId ? agentPath : null,
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
  let agentId: string | null = null
  let summary = ''
  let updatedAt = fileUpdatedAt

  for (const line of source.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record: JsonRecord
    try {
      const parsed = object(JSON.parse(line))
      if (!parsed) continue
      record = parsed
    } catch {
      continue
    }
    const timestamp = string(record.timestamp)
    if (timestamp) updatedAt = timestamp
    workingDirectory = string(record.cwd) ?? workingDirectory
    archiveId = string(record.sessionId) ?? archiveId
    agentId = string(record.agentId) ?? agentId
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
  // Claude stores child transcripts below <parent-session>/subagents/agent-<id>.jsonl.
  // Their sessionId is the parent's, so it cannot identify the child's archive.
  const isSubagent = basename(dirname(path)) === 'subagents'
  const parentProviderSessionId = isSubagent ? basename(dirname(dirname(path))) : null
  const providerSessionId = isSubagent ? agentId || basename(path, '.jsonl').replace(/^agent-/, '') : archiveId
  return {
    id: stableId('claude', path, isSubagent ? `${parentProviderSessionId}:agent:${providerSessionId}` : archiveId),
    provider: 'claude',
    providerSessionId,
    parentProviderSessionId,
    agentName: null,
    agentPath: null,
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

function snippetFor(conversation: { messages: readonly Pick<ConversationMessage, 'content'>[] }, query: string): string {
  const fallback = conversation.messages[0]?.content ?? ''
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
  // The catalog retains compact summaries, never full transcripts. This
  // synchronous engine runs in the archive worker in the desktop application.
  private readonly cache = new Map<string, CacheEntry>()
  private readonly details = new Map<string, DetailEntry>()
  private detailBytes = 0
  private readonly maxDetailBytes: number
  private readonly maxDetailEntries: number
  constructor(private readonly roots: ConversationRoot[] = [
    { provider: 'codex', path: join(homedir(), '.codex', 'sessions') },
    { provider: 'claude', path: join(homedir(), '.claude', 'projects') }
  ], options: ConversationCacheOptions = {}) {
    this.maxDetailBytes = Math.max(0, options.maxDetailBytes ?? MAX_CONVERSATION_DETAIL_BYTES)
    this.maxDetailEntries = Math.max(0, options.maxDetailEntries ?? MAX_CONVERSATION_DETAIL_ENTRIES)
  }

  diagnostics() {
    return { catalogFiles: this.cache.size, detailEntries: this.details.size,
      detailBytes: this.detailBytes, maxDetailBytes: this.maxDetailBytes,
      maxDetailEntries: this.maxDetailEntries, heapUsed: process.memoryUsage().heapUsed }
  }

  list(projectFolder: string, query = '', hiddenCount = 0): ConversationSummary[] {
    const normalizedFolder = resolve(projectFolder)
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const summaries = this.projectEntries(normalizedFolder)
      .flatMap(({ path, summary }): ConversationSummary[] => {
        if (!normalizedQuery && !hiddenCount) return [summary]
        const conversation = this.readConversation(path)
        return conversation ? [this.summaryFor(conversation, normalizedQuery, hiddenCount)] : []
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return normalizedQuery ? matchingConversations(summaries) : summaries
  }

  get(projectFolder: string, id: string, query = ''): ConversationDetail {
    const entry = this.projectEntries(projectFolder).find((candidate) => candidate.summary.id === id)
    const conversation = entry ? this.readConversation(entry.path) : null
    if (!conversation) {
      throw new Error('Conversation not found for this project.')
    }
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const searchable = [
      conversation.title,
      conversation.agentName ?? '',
      conversation.agentPath ?? '',
      conversation.workingDirectory,
      ...conversation.messages.map((message) => message.content)
    ]
    return {
      id: conversation.id,
      provider: conversation.provider,
      providerSessionId: conversation.providerSessionId,
      parentProviderSessionId: conversation.parentProviderSessionId,
      agentName: conversation.agentName,
      agentPath: conversation.agentPath,
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

  findCodexSessionId(
    projectFolder: string,
    terminalCreatedAt: string,
    excludedIds: Set<string>,
    providerSessionHint: string | null = null
  ): string | null {
    const normalizedFolder = resolve(projectFolder)
    const terminalTime = Date.parse(terminalCreatedAt)
    const earliest = Number.isFinite(terminalTime) ? terminalTime - 10_000 : 0
    const candidates: Array<{ id: string; timestamp: number }> = []

    for (const path of this.roots.filter((root) => root.provider === 'codex').flatMap((root) => collectJsonlFiles(root.path))) {
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (stat.mtimeMs < earliest) continue
      try {
        const firstLine = readFirstJsonlLine(path)
        const record = object(JSON.parse(firstLine))
        const payload = object(record?.payload)
        if (string(record?.type) !== 'session_meta' || !payload) continue
        const id = string(payload.id) ?? string(payload.session_id)
        const cwd = string(payload.cwd)
        if (!id || !cwd || excludedIds.has(id) || resolve(cwd) !== normalizedFolder) continue
        const timestamp =
          Date.parse(string(payload.timestamp) ?? string(record?.timestamp) ?? '') ||
          stat.birthtimeMs ||
          stat.mtimeMs
        if (timestamp < earliest) continue
        candidates.push({ id, timestamp })
      } catch {
        continue
      }
    }

    if (providerSessionHint) {
      const exact = candidates.find(
        (candidate) =>
          candidate.id === providerSessionHint ||
          candidate.id.startsWith(providerSessionHint)
      )
      if (exact) return exact.id

      for (const root of this.roots.filter((root) => root.provider === 'codex')) {
        try {
          const indexPath = join(dirname(root.path), 'session_index.jsonl')
          const indexedId = readFileSync(indexPath, 'utf8')
            .split(/\r?\n/)
            .flatMap((line): string[] => {
              if (!line.includes(providerSessionHint)) return []
              try {
                const record = object(JSON.parse(line))
                return string(record?.thread_name) === providerSessionHint
                  ? [string(record?.id)].filter((id): id is string => Boolean(id))
                  : []
              } catch {
                return []
              }
            })
            .at(-1)
          const exact = candidates.find((candidate) => candidate.id === indexedId)
          if (exact) return exact.id
        } catch {
          // Older Codex versions may not have a session index.
        }
      }
    }
    return null
  }

  findProviderSessionId(
    provider: ConversationProvider,
    projectFolder: string,
    terminalCreatedAt: string,
    excludedIds: Set<string>,
    providerSessionHint: string | null = null
  ): string | null {
    if (provider === 'codex') {
      return this.findCodexSessionId(
        projectFolder,
        terminalCreatedAt,
        excludedIds,
        providerSessionHint
      )
    }
    const normalizedFolder = resolve(projectFolder)
    const terminalTime = Date.parse(terminalCreatedAt)
    const earliest = Number.isFinite(terminalTime) ? terminalTime - 10_000 : 0
    return (
      this.indexAll()
        .filter((conversation) => {
          const timestamp = Date.parse(conversation.updatedAt)
          return (
            conversation.provider === provider &&
            !conversation.parentProviderSessionId &&
            Boolean(conversation.providerSessionId) &&
            !excludedIds.has(conversation.providerSessionId!) &&
            resolve(conversation.workingDirectory) === normalizedFolder &&
            (!Number.isFinite(timestamp) || timestamp >= earliest)
          )
        })
        .sort((a, b) => {
          const aTime = Date.parse(a.updatedAt)
          const bTime = Date.parse(b.updatedAt)
          return Math.abs(aTime - terminalTime) - Math.abs(bTime - terminalTime)
        })[0]?.providerSessionId ?? null
    )
  }

  private summaryFor(conversation: ParsedConversation, query = '', hiddenCount = 0): ConversationSummary {
    const display = conversationDisplayWindow(conversation, hiddenCount)
    const searchable = [conversation.title, conversation.agentName ?? '', conversation.agentPath ?? '',
      conversation.workingDirectory, ...conversation.messages.map((message) => message.content)]
    return {
      id: conversation.id, provider: conversation.provider,
      providerSessionId: conversation.providerSessionId,
      parentProviderSessionId: conversation.parentProviderSessionId,
      agentName: conversation.agentName, agentPath: conversation.agentPath,
      // Copy truncated strings so a short V8 slice cannot pin a multi-megabyte
      // first message after its parsed detail is evicted.
      title: Buffer.from(display.title).toString(), workingDirectory: conversation.workingDirectory,
      updatedAt: conversation.updatedAt, messageCount: conversation.messages.length,
      snippet: Buffer.from(snippetFor({ messages: display.messages }, query)).toString(),
      matchCount: query ? searchable.reduce((total, value) => total + countMatches(value, query), 0) : 0
    }
  }

  private dropDetail(path: string): void {
    const entry = this.details.get(path)
    if (entry) this.detailBytes -= entry.bytes
    this.details.delete(path)
  }

  private rememberDetail(path: string, conversation: ParsedConversation): void {
    this.dropDetail(path)
    // Charge UTF-16 storage plus message/metadata overhead conservatively. A
    // single oversized archive can be opened/searched but is never retained.
    const bytes = 1024 + Object.values(conversation).reduce<number>((sum, value) =>
      sum + (typeof value === 'string' ? value.length * 2 : 0), 0) +
      conversation.messages.reduce((sum, message) => sum + 256 +
        2 * (message.id.length + message.content.length + (message.timestamp?.length ?? 0)), 0)
    if (!this.maxDetailEntries || bytes > this.maxDetailBytes) return
    while (this.details.size >= this.maxDetailEntries || this.detailBytes + bytes > this.maxDetailBytes) {
      const oldest = this.details.keys().next().value
      if (oldest === undefined) break
      this.dropDetail(oldest)
    }
    this.details.set(path, { conversation, bytes })
    this.detailBytes += bytes
  }

  private readConversation(path: string): ParsedConversation | null {
    const entry = this.cache.get(path)
    if (!entry) return null
    const cached = this.details.get(path)
    if (cached) {
      this.details.delete(path)
      this.details.set(path, cached)
      return cached.conversation
    }
    try {
      const source = readFileSync(path, 'utf8')
      const updatedAt = statSync(path).mtime.toISOString()
      const conversation = entry.provider === 'codex'
        ? parseCodexConversation(path, source, updatedAt)
        : parseClaudeConversation(path, source, updatedAt)
      if (conversation) this.rememberDetail(path, conversation)
      return conversation
    } catch { return null }
  }

  private indexAll(): ConversationSummary[] {
    const found: ConversationSummary[] = []
    const livePaths = new Set<string>()
    for (const root of this.roots) {
      for (const path of collectJsonlFiles(root.path)) {
        let stat
        try { stat = statSync(path) } catch { continue }
        livePaths.add(path)
        // ctime + inode also catch equal-size rewrites with restored mtime and
        // atomic replacement. Truncation/append invalidate the same entry.
        const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
        const cached = this.cache.get(path)
        if (cached?.fingerprint === fingerprint) {
          if (cached.summary) found.push(cached.summary)
          continue
        }
        this.dropDetail(path)
        this.cache.set(path, { fingerprint, provider: root.provider, summary: null })
        const conversation = this.readConversation(path)
        const summary = conversation ? this.summaryFor(conversation) : null
        this.cache.set(path, { fingerprint, provider: root.provider, summary })
        if (summary) found.push(summary)
      }
    }
    for (const path of this.cache.keys()) {
      if (!livePaths.has(path)) { this.cache.delete(path); this.dropDetail(path) }
    }
    return found
  }

  private projectEntries(projectFolder: string): Array<{ path: string; summary: ConversationSummary }> {
    const normalizedFolder = resolve(projectFolder)
    const selected = new Set(conversationsWithDescendants(this.indexAll(), (conversation) =>
      resolve(conversation.workingDirectory) === normalizedFolder))
    return [...this.cache].flatMap(([path, entry]) =>
      entry.summary && selected.has(entry.summary) ? [{ path, summary: entry.summary }] : [])
  }
}
