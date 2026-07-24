import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import type {
  ConversationDetail,
  ConversationMessage,
  ConversationProvider,
  ConversationSummary
} from '../shared/types'

const execFileAsync = promisify(execFile)
const CACHE_MS = 5_000
const MAX_REMOTE_OUTPUT = 20 * 1024 * 1024

type RemoteMessage = Omit<ConversationMessage, 'id'>

interface RemoteConversation {
  provider: ConversationProvider
  providerSessionId: string | null
  title: string
  workingDirectory: string
  updatedAt: string
  messages: RemoteMessage[]
}

interface RemoteCodexSession {
  id: string
  workingDirectory: string
  startedAt: string
}

interface RemoteScanResult {
  conversations: RemoteConversation[]
  codexSessions: RemoteCodexSession[]
}

interface CachedScan {
  expiresAt: number
  result: RemoteScanResult
}

interface CachedCodexSessions {
  expiresAt: number
  sessions: RemoteCodexSession[]
}

export const REMOTE_SCAN_SCRIPT = String.raw`
import base64
import datetime
import json
import os
import sys

params = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
project_folder = os.path.normpath(os.path.expanduser(params["folder"]))
conversations = []
codex_sessions = []

def clean(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None

def content_text(value):
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, list):
        return ""
    parts = []
    for item in value:
        if not isinstance(item, dict):
            continue
        item_type = clean(item.get("type"))
        if item_type and item_type not in ("text", "input_text", "output_text"):
            continue
        text = clean(item.get("text"))
        if text:
            parts.append(text)
    return "\n\n".join(parts).strip()

def push(messages, role, content, timestamp):
    content = (content or "").strip()
    if not content:
        return
    if messages and messages[-1]["role"] == role and messages[-1]["content"] == content:
        return
    messages.append({"role": role, "content": content, "timestamp": timestamp})

def title_for(messages):
    first = next((item["content"] for item in messages if item["role"] == "user"), None)
    if not first:
        return "Untitled conversation"
    line = " ".join(first.split())
    return line if len(line) <= 78 else line[:77] + "…"

def mtime_iso(path):
    return datetime.datetime.fromtimestamp(
        os.path.getmtime(path), datetime.timezone.utc
    ).isoformat().replace("+00:00", "Z")

roots = [
    ("codex", os.path.expanduser("~/.codex/sessions")),
    ("claude", os.path.expanduser("~/.claude/projects")),
]

for provider, root in roots:
    if not os.path.isdir(root):
        continue
    for directory, _, filenames in os.walk(root):
        for filename in filenames:
            if not filename.endswith(".jsonl"):
                continue
            path = os.path.join(directory, filename)
            messages = []
            fallback_messages = []
            working_directory = ""
            archive_id = None
            summary = ""
            updated_at = mtime_iso(path)
            started_at = updated_at
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as source:
                    for line in source:
                        try:
                            record = json.loads(line)
                        except Exception:
                            continue
                        if not isinstance(record, dict):
                            continue
                        timestamp = clean(record.get("timestamp"))
                        if timestamp:
                            updated_at = timestamp

                        if provider == "codex":
                            payload = record.get("payload")
                            event_type = clean(record.get("type"))
                            if not isinstance(payload, dict) or not event_type:
                                continue
                            if event_type == "session_meta":
                                working_directory = clean(payload.get("cwd")) or working_directory
                                archive_id = (
                                    clean(payload.get("id"))
                                    or clean(payload.get("session_id"))
                                    or archive_id
                                )
                                started_at = (
                                    clean(payload.get("timestamp"))
                                    or timestamp
                                    or started_at
                                )
                            elif event_type == "response_item" and payload.get("type") == "message":
                                role = payload.get("role")
                                if role in ("user", "assistant"):
                                    push(
                                        fallback_messages,
                                        role,
                                        content_text(payload.get("content")),
                                        timestamp,
                                    )
                            elif event_type == "event_msg":
                                nested_type = clean(payload.get("type"))
                                if nested_type == "user_message":
                                    push(messages, "user", clean(payload.get("message")) or "", timestamp)
                                elif nested_type == "agent_message":
                                    push(messages, "assistant", clean(payload.get("message")) or "", timestamp)
                        else:
                            working_directory = clean(record.get("cwd")) or working_directory
                            archive_id = clean(record.get("sessionId")) or archive_id
                            event_type = clean(record.get("type"))
                            if event_type == "summary":
                                summary = clean(record.get("summary")) or summary
                            elif event_type in ("user", "assistant"):
                                message = record.get("message")
                                if isinstance(message, dict):
                                    push(
                                        messages,
                                        event_type,
                                        content_text(message.get("content")),
                                        timestamp,
                                    )
            except Exception:
                continue

            if not working_directory or os.path.normpath(working_directory) != project_folder:
                continue
            if provider == "codex" and archive_id:
                codex_sessions.append({
                    "id": archive_id,
                    "workingDirectory": working_directory,
                    "startedAt": started_at,
                })
            if provider == "codex" and not messages:
                messages = fallback_messages
            if not messages:
                continue
            conversations.append({
                "provider": provider,
                "providerSessionId": archive_id,
                "title": summary or title_for(messages),
                "workingDirectory": working_directory,
                "updatedAt": updated_at,
                "messages": messages,
            })

payload = json.dumps(
    {"conversations": conversations, "codexSessions": codex_sessions},
    ensure_ascii=False,
    separators=(",", ":"),
).encode("utf-8")
print(base64.b64encode(payload).decode("ascii"))
`

const REMOTE_CODEX_SESSION_SCRIPT = String.raw`
import base64
import json
import os
import sys

params = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
project_folder = os.path.normpath(os.path.expanduser(params["folder"]))
sessions = []
root = os.path.expanduser("~/.codex/sessions")

if os.path.isdir(root):
    for directory, _, filenames in os.walk(root):
        for filename in filenames:
            if not filename.endswith(".jsonl"):
                continue
            path = os.path.join(directory, filename)
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as source:
                    record = json.loads(source.readline())
                payload = record.get("payload")
                if record.get("type") != "session_meta" or not isinstance(payload, dict):
                    continue
                working_directory = payload.get("cwd")
                session_id = payload.get("id") or payload.get("session_id")
                if (
                    not isinstance(working_directory, str)
                    or os.path.normpath(working_directory) != project_folder
                    or not isinstance(session_id, str)
                ):
                    continue
                sessions.append({
                    "id": session_id,
                    "workingDirectory": working_directory,
                    "startedAt": (
                        payload.get("timestamp")
                        or record.get("timestamp")
                        or ""
                    ),
                })
            except Exception:
                continue

encoded = json.dumps(sessions, separators=(",", ":")).encode("utf-8")
print(base64.b64encode(encoded).decode("ascii"))
`

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function stableId(provider: ConversationProvider, providerSessionId: string | null): string {
  return createHash('sha256')
    .update(`${provider}:${providerSessionId ?? ''}`)
    .digest('hex')
    .slice(0, 24)
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

function snippetFor(conversation: RemoteConversation, query: string): string {
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

function summaryFor(conversation: RemoteConversation, query: string): ConversationSummary {
  const searchable = [
    conversation.title,
    conversation.workingDirectory,
    ...conversation.messages.map((message) => message.content)
  ]
  return {
    id: stableId(conversation.provider, conversation.providerSessionId),
    provider: conversation.provider,
    providerSessionId: conversation.providerSessionId,
    title: conversation.title,
    workingDirectory: conversation.workingDirectory,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    snippet: snippetFor(conversation, query),
    matchCount: query
      ? searchable.reduce((total, value) => total + countMatches(value, query), 0)
      : 0
  }
}

export function decodeRemoteScan(encoded: string): RemoteScanResult {
  const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RemoteScanResult
  if (!Array.isArray(parsed.conversations) || !Array.isArray(parsed.codexSessions)) {
    throw new Error('The remote archive response was malformed.')
  }
  return parsed
}

async function executeRemoteScript(
  alias: string,
  scriptSource: string,
  projectFolder: string,
  maxBuffer: number,
  timeout: number
): Promise<string> {
  const params = Buffer.from(JSON.stringify({ folder: projectFolder }), 'utf8').toString(
    'base64'
  )
  const script = Buffer.from(scriptSource, 'utf8').toString('base64')
  const command = [
    'python3',
    '-c',
    shellQuote(
      `import base64;exec(compile(base64.b64decode(${JSON.stringify(script)}), "<panepilot-archive-scan>", "exec"))`
    ),
    shellQuote(params)
  ].join(' ')

  try {
    const result = await execFileAsync(
      'ssh',
      ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', alias, command],
      {
        encoding: 'utf8',
        timeout,
        maxBuffer
      }
    )
    const encoded = result.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .at(-1)
    if (!encoded) throw new Error('The remote host returned no LLM archive data.')
    return encoded
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr).trim()
        : error instanceof Error
          ? error.message
          : String(error)
    throw new Error(
      detail ||
        'Could not read remote LLM archives. Verify SSH key access and Python 3 on the host.'
    )
  }
}

export class RemoteConversationIndexer {
  private readonly cache = new Map<string, CachedScan>()
  private readonly codexSessionCache = new Map<string, CachedCodexSessions>()

  async list(alias: string, projectFolder: string, query = ''): Promise<ConversationSummary[]> {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    const scan = await this.scan(alias, projectFolder)
    return scan.conversations
      .map((conversation) => summaryFor(conversation, normalizedQuery))
      .filter((conversation) => !normalizedQuery || conversation.matchCount > 0)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  }

  async get(
    alias: string,
    projectFolder: string,
    id: string,
    query = ''
  ): Promise<ConversationDetail> {
    const scan = await this.scan(alias, projectFolder)
    const conversation = scan.conversations.find(
      (candidate) => stableId(candidate.provider, candidate.providerSessionId) === id
    )
    if (!conversation) throw new Error('Conversation not found for this remote project.')
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return {
      ...summaryFor(conversation, normalizedQuery),
      messages: conversation.messages.map((message, index) => ({
        ...message,
        id: createHash('sha256')
          .update(
            `${conversation.provider}:${conversation.providerSessionId ?? ''}:${index}:${message.role}`
          )
          .digest('hex')
          .slice(0, 24)
      }))
    }
  }

  async findCodexSessionId(
    alias: string,
    projectFolder: string,
    terminalCreatedAt: string,
    excludedIds: Set<string>
  ): Promise<string | null> {
    const sessions = await this.listCodexSessions(alias, projectFolder)
    const terminalTime = Date.parse(terminalCreatedAt)
    const earliest = Number.isFinite(terminalTime) ? terminalTime - 10_000 : 0
    return (
      sessions
        .filter((session) => {
          const startedAt = Date.parse(session.startedAt)
          return !excludedIds.has(session.id) && (!Number.isFinite(startedAt) || startedAt >= earliest)
        })
        .sort((a, b) => {
          const aTime = Date.parse(a.startedAt)
          const bTime = Date.parse(b.startedAt)
          return Math.abs(aTime - terminalTime) - Math.abs(bTime - terminalTime)
        })[0]?.id ?? null
    )
  }

  private async listCodexSessions(
    alias: string,
    projectFolder: string
  ): Promise<RemoteCodexSession[]> {
    const key = `${alias}\u0000${projectFolder}`
    const cached = this.codexSessionCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.sessions
    const encoded = await executeRemoteScript(
      alias,
      REMOTE_CODEX_SESSION_SCRIPT,
      projectFolder,
      2 * 1024 * 1024,
      10_000
    )
    const sessions = JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf8')
    ) as RemoteCodexSession[]
    if (!Array.isArray(sessions)) {
      throw new Error('The remote Codex session response was malformed.')
    }
    this.codexSessionCache.set(key, {
      expiresAt: Date.now() + 2_000,
      sessions
    })
    return sessions
  }

  private async scan(
    alias: string,
    projectFolder: string,
    force = false
  ): Promise<RemoteScanResult> {
    const key = `${alias}\u0000${projectFolder}`
    const cached = this.cache.get(key)
    if (!force && cached && cached.expiresAt > Date.now()) return cached.result

    const encoded = await executeRemoteScript(
      alias,
      REMOTE_SCAN_SCRIPT,
      projectFolder,
      MAX_REMOTE_OUTPUT,
      20_000
    )
    const result = decodeRemoteScan(encoded)
    this.cache.set(key, { expiresAt: Date.now() + CACHE_MS, result })
    return result
  }
}
