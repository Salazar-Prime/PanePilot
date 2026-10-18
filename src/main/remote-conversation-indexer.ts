import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { matchingConversations } from '../shared/conversation-hierarchy'
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
  parentProviderSessionId?: string | null
  agentName?: string | null
  archiveIdentity?: string
  title: string
  workingDirectory: string
  updatedAt: string
  messages: RemoteMessage[]
}

interface RemoteCodexSession {
  id: string
  workingDirectory: string
  startedAt: string
  name?: string | null
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

def obj(value):
    return value if isinstance(value, dict) else {}

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
            parent_id = None
            agent_name = None
            agent_path = None
            agent_id = None
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

                        if provider == "codex" and parent_id and (not timestamp or timestamp < started_at):
                            continue

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
                                spawn = obj(obj(obj(payload.get("source")).get("subagent")).get("thread_spawn"))
                                parent_id = clean(spawn.get("parent_thread_id")) or (
                                    clean(payload.get("parent_thread_id")) if payload.get("thread_source") == "subagent" else None
                                )
                                agent_path = clean(payload.get("agent_path")) or clean(spawn.get("agent_path"))
                                agent_name = clean(payload.get("agent_nickname")) or clean(spawn.get("agent_nickname")) or (
                                    agent_path.rstrip("/").split("/")[-1] if agent_path else None
                                )
                                if not parent_id:
                                    agent_name = None
                            elif event_type == "response_item" and payload.get("type") == "message":
                                role = payload.get("role")
                                if role in ("user", "assistant") and payload.get("phase") != "analysis":
                                    push(
                                        fallback_messages,
                                        role,
                                        content_text(payload.get("content")),
                                        timestamp,
                                    )
                            elif event_type == "response_item" and payload.get("type") == "agent_message" and parent_id and agent_path and payload.get("author") == agent_path:
                                push(fallback_messages, "assistant", content_text(payload.get("content")), timestamp)
                            elif event_type == "event_msg":
                                nested_type = clean(payload.get("type"))
                                if nested_type == "user_message":
                                    push(messages, "user", clean(payload.get("message")) or "", timestamp)
                                elif nested_type == "agent_message":
                                    push(messages, "assistant", clean(payload.get("message")) or "", timestamp)
                        else:
                            working_directory = clean(record.get("cwd")) or working_directory
                            archive_id = clean(record.get("sessionId")) or archive_id
                            agent_id = clean(record.get("agentId")) or agent_id
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

            if not working_directory:
                continue
            if provider == "codex" and archive_id and not parent_id and os.path.normpath(working_directory) == project_folder:
                codex_sessions.append({
                    "id": archive_id,
                    "workingDirectory": working_directory,
                    "startedAt": started_at,
                })
            if provider == "codex" and not messages:
                messages = fallback_messages
            if not messages:
                continue
            identity = archive_id
            if provider == "claude" and os.path.basename(directory) == "subagents":
                parent_id = os.path.basename(os.path.dirname(directory))
                archive_id = agent_id or filename[:-6]
                if not agent_id and archive_id.startswith("agent-"):
                    archive_id = archive_id[6:]
                identity = parent_id + ":agent:" + archive_id
            # Only subagents can cross project folders through explicit links.
            # Do not retain all unrelated main transcripts while resolving them.
            if not parent_id and os.path.normpath(working_directory) != project_folder:
                continue
            conversations.append({
                "provider": provider,
                "providerSessionId": archive_id,
                "parentProviderSessionId": parent_id,
                "agentName": agent_name,
                "archiveIdentity": identity,
                "title": summary or title_for(messages),
                "workingDirectory": working_directory,
                "updatedAt": updated_at,
                "messages": messages,
            })

# A subagent may work in a different worktree. Include only explicit descendants
# of this project's chats, not unrelated conversations that share another cwd.
children = {}
for conversation in conversations:
    if conversation["parentProviderSessionId"]:
        key = (conversation["provider"], conversation["parentProviderSessionId"])
        children.setdefault(key, []).append(conversation)
pending = [c for c in conversations if os.path.normpath(c["workingDirectory"]) == project_folder]
included = set()
while pending:
    conversation = pending.pop()
    identity = id(conversation)
    if identity in included:
        continue
    included.add(identity)
    key = (conversation["provider"], conversation["providerSessionId"])
    pending.extend(children.get(key, []))
conversations = [c for c in conversations if id(c) in included]

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
session_names = {}
index_path = os.path.expanduser("~/.codex/session_index.jsonl")

if os.path.isfile(index_path):
    try:
        with open(index_path, "r", encoding="utf-8", errors="replace") as source:
            for line in source:
                try:
                    record = json.loads(line)
                except Exception:
                    continue
                session_id = record.get("id")
                session_name = record.get("thread_name")
                if isinstance(session_id, str) and isinstance(session_name, str):
                    session_names[session_id] = session_name
    except Exception:
        pass

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
                    "name": session_names.get(session_id),
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
    conversation.agentName ?? '',
    conversation.workingDirectory,
    ...conversation.messages.map((message) => message.content)
  ]
  return {
    id: stableId(conversation.provider, conversation.archiveIdentity ?? conversation.providerSessionId),
    provider: conversation.provider,
    providerSessionId: conversation.providerSessionId,
    parentProviderSessionId: conversation.parentProviderSessionId ?? null,
    agentName: conversation.agentName ?? null,
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
    const summaries = scan.conversations
      .map((conversation) => summaryFor(conversation, normalizedQuery))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return normalizedQuery ? matchingConversations(summaries) : summaries
  }

  async get(
    alias: string,
    projectFolder: string,
    id: string,
    query = ''
  ): Promise<ConversationDetail> {
    const scan = await this.scan(alias, projectFolder)
    const conversation = scan.conversations.find(
      (candidate) => stableId(candidate.provider, candidate.archiveIdentity ?? candidate.providerSessionId) === id
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
    excludedIds: Set<string>,
    providerSessionHint: string | null = null
  ): Promise<string | null> {
    const sessions = await this.listCodexSessions(alias, projectFolder)
    const terminalTime = Date.parse(terminalCreatedAt)
    const earliest = Number.isFinite(terminalTime) ? terminalTime - 10_000 : 0
    const candidates = sessions.filter((session) => {
      const startedAt = Date.parse(session.startedAt)
      return (
        !excludedIds.has(session.id) &&
        (!Number.isFinite(startedAt) || startedAt >= earliest)
      )
    })
    const exact = providerSessionHint
      ? candidates.find(
          (session) =>
            session.id === providerSessionHint ||
            session.id.startsWith(providerSessionHint) ||
            session.name === providerSessionHint
        )
      : null
    return exact?.id ?? null
  }

  async findProviderSessionId(
    provider: ConversationProvider,
    alias: string,
    projectFolder: string,
    terminalCreatedAt: string,
    excludedIds: Set<string>,
    providerSessionHint: string | null = null
  ): Promise<string | null> {
    if (provider === 'codex') {
      return this.findCodexSessionId(
        alias,
        projectFolder,
        terminalCreatedAt,
        excludedIds,
        providerSessionHint
      )
    }
    const terminalTime = Date.parse(terminalCreatedAt)
    const earliest = Number.isFinite(terminalTime) ? terminalTime - 10_000 : 0
    const scan = await this.scan(alias, projectFolder, true)
    return (
      scan.conversations
        .filter((conversation) => {
          const timestamp = Date.parse(conversation.updatedAt)
          return (
            conversation.provider === provider &&
            !conversation.parentProviderSessionId &&
            Boolean(conversation.providerSessionId) &&
            !excludedIds.has(conversation.providerSessionId!) &&
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
