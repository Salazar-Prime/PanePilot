import { execFile } from 'node:child_process'
import { open, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { CodexSubagent, CodexSubagentOutput, CodexSubagentSnapshot, CodexSubagentSummary } from '../shared/types'

const execFileAsync = promisify(execFile)
const READ_BYTES = 256 * 1024
const MAX_AGENTS = 24
const MAX_ACTIVITY_AGENTS = 128
const MAX_FILES = 20_000

interface AgentHeader {
  id: string
  parentId: string | null
  cwd: string
  name: string
  path: string
  startedAt: string
}
interface ArchiveEntry { header: AgentHeader; tail: string; truncated: boolean; updatedAt: string }
interface ArchiveScan { entries: ArchiveEntry[]; rootFound: boolean; total: number; limited: boolean; running: boolean }
interface ReadResult extends CodexSubagentSnapshot { running: boolean }
type JsonObject = Record<string, any>

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}
function text(value: unknown): string { return typeof value === 'string' ? value : '' }

export function subagentHeader(line: string): AgentHeader | null {
  try {
    const record = JSON.parse(line)
    if (record.type !== 'session_meta') return null
    const p = object(record.payload)
    const spawn = object(object(object(p.source).subagent).thread_spawn)
    const parent = text(spawn.parent_thread_id) ||
      (p.thread_source === 'subagent' ? text(p.parent_thread_id) : '')
    const id = text(p.id) || text(p.session_id)
    if (!id || !text(p.cwd)) return null
    return {
      id, parentId: parent || null, cwd: p.cwd,
      name: (text(p.agent_nickname) || text(spawn.agent_nickname)).slice(0, 120),
      path: (text(p.agent_path) || text(spawn.agent_path)).slice(0, 300),
      startedAt: text(p.timestamp) || text(record.timestamp)
    }
  } catch { return null }
}

/** Never infer ownership from cwd, fork IDs, names, or timing. */
export function descendantHeaders(headers: AgentHeader[], rootId: string): AgentHeader[] {
  const related = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const header of headers) {
      if (header.parentId && related.has(header.parentId) && !related.has(header.id)) {
        related.add(header.id)
        changed = true
      }
    }
  }
  return headers.filter((header) => header.id !== rootId && related.has(header.id))
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.filter((item) => ['text', 'input_text', 'output_text'].includes(item?.type))
    .map((item) => text(item.text)).join('\n')
}

/** A status-only read never extracts messages, tool output, or inherited lifecycle events. */
export function subagentLifecycleState(tail: string, startedAt: string): CodexSubagent['state'] {
  let state: CodexSubagent['state'] = 'unknown'
  const started = Date.parse(startedAt)
  for (const line of tail.split('\n')) {
    if (!line.includes('"event_msg"')) continue
    let record: JsonObject
    try { record = object(JSON.parse(line)) } catch { continue }
    if (record.type !== 'event_msg') continue
    const timestamp = text(record.timestamp)
    const at = Date.parse(timestamp)
    if (Number.isFinite(started) && (!Number.isFinite(at) || at < started)) continue
    const kind = object(record.payload).type
    if (kind === 'task_started') state = 'working'
    if (kind === 'task_complete') state = 'finished'
    if (kind === 'turn_aborted') state = 'stopped'
  }
  return state
}

/** Only public messages and tool I/O; never reasoning, encrypted content, or inherited prompts. */
export function parseSubagent(entry: ArchiveEntry): CodexSubagent {
  const { header } = entry
  const output: CodexSubagentOutput[] = []
  const state = subagentLifecycleState(entry.tail, header.startedAt)
  let clipped = entry.truncated
  const started = Date.parse(header.startedAt)
  const push = (kind: CodexSubagentOutput['kind'], value: string, timestamp: string | null) => {
    if (!value.trim()) return
    if (value.length > 8_000) clipped = true
    const message = value.length > 8_000 ? `${value.slice(0, 8_000)}\n… [output shortened]` : value
    // Codex can write both response_item and event_msg for the same public message.
    if (output.at(-1)?.text === message) return
    output.push({ kind, text: message, timestamp })
  }
  for (const line of entry.tail.split('\n')) {
    let record: JsonObject
    try { record = object(JSON.parse(line)) } catch { continue }
    const timestamp = text(record.timestamp) || null
    if (Number.isFinite(started) && (!timestamp || Date.parse(timestamp) < started)) continue
    const p = object(record.payload)
    if (record.type === 'event_msg') {
      if (p.type === 'task_complete') {
        push('message', text(p.last_agent_message), timestamp)
      }
      if (p.type === 'agent_message') push('message', text(p.message), timestamp)
    }
    if (record.type !== 'response_item') continue
    if (p.type === 'message' && p.role === 'assistant' && p.phase !== 'analysis') push('message', contentText(p.content), timestamp)
    if (p.type === 'agent_message' && p.author === header.path) push('message', contentText(p.content), timestamp)
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      push('tool', `${text(p.name)}\n${text(p.arguments) || text(p.input)}`, timestamp)
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      push('result', contentText(p.output), timestamp)
    }
  }
  if (output.length > 60) clipped = true
  return {
    id: header.id, parentId: header.parentId!,
    name: header.name || header.path.split('/').filter(Boolean).at(-1) || 'Sub-agent',
    path: header.path, state, updatedAt: entry.updatedAt, output: output.slice(-60), truncated: clipped
  }
}

export class CodexSubagentReader {
  private readonly headers = new Map<string, { identity: string; header: AgentHeader | null }>()
  private readonly pending = new Map<string, Promise<ReadResult>>()
  private readonly cache = new Map<string, { at: number; snapshot: ReadResult }>()
  private readonly activity = new Map<string, { revision: string; running: boolean }>()

  constructor(private readonly root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')) {}

  async summary(rootId: string, folder: string, alias?: string): Promise<CodexSubagentSummary> {
    const snapshot = await this.read(rootId, folder, alias, false)
    return { count: snapshot.total, running: snapshot.running, rootFound: snapshot.rootFound, limited: snapshot.limited }
  }

  async read(rootId: string, folder: string, alias?: string, includeOutput = true): Promise<ReadResult> {
    if (!rootId || rootId.length > 200) throw new Error('This terminal has no linked Codex thread yet.')
    const key = JSON.stringify([alias ?? '', folder, rootId, includeOutput])
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at < 2_500) return cached.snapshot
    const pending = this.pending.get(key)
    if (pending) return pending
    const request = (async () => {
      const scan = alias ? await this.remote(rootId, folder, alias, includeOutput) : await this.local(rootId, folder, includeOutput)
      const snapshot = { ...scan, agents: scan.entries.map(parseSubagent) }
      const result: ReadResult = {
        agents: snapshot.agents, total: scan.total, rootFound: scan.rootFound, limited: scan.limited, running: scan.running
      }
      if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, { at: Date.now(), snapshot: result })
      return result
    })()
    this.pending.set(key, request)
    try { return await request } finally { this.pending.delete(key) }
  }

  private async local(rootId: string, folder: string, includeOutput: boolean): Promise<ArchiveScan> {
    const candidates: { header: AgentHeader; file: string; updatedAt: string; revision: string }[] = []
    let count = 0
    let limited = false
    const deadline = Date.now() + 8_000
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
        if (++count > MAX_FILES || Date.now() > deadline) { limited = true; return }
        const file = join(directory, entry.name)
        if (entry.isDirectory()) { await walk(file); continue }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
        const handle = await open(file, 'r').catch(() => null)
        if (!handle) continue
        try {
          const stat = await handle.stat()
          const identity = `${stat.dev}:${stat.ino}`
          let cached = this.headers.get(file)
          if (!cached || cached.identity !== identity || !cached.header) {
            const buffer = Buffer.alloc(Math.min(READ_BYTES, stat.size))
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
            cached = { identity, header: subagentHeader(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]) }
            if (this.headers.size >= MAX_FILES) this.headers.clear()
            this.headers.set(file, cached)
          }
          if (cached.header) candidates.push({ header: cached.header, file, updatedAt: stat.mtime.toISOString(), revision: `${identity}:${stat.size}:${stat.mtimeMs}` })
        } finally { await handle.close() }
      }
    }
    await walk(this.root)
    const canonical = await realpath(folder).catch(() => resolve(folder))
    const root = candidates.find(({ header }) => header.id === rootId)
    const rootFound = Boolean(root && (await realpath(root.header.cwd).catch(() => resolve(root.header.cwd))) === canonical)
    if (!rootFound) return { entries: [], rootFound: false, total: 0, limited, running: false }
    const descendants = new Set(descendantHeaders(candidates.map((c) => c.header), rootId).map((h) => h.id))
    const matches = candidates.filter(({ header }) => descendants.has(header.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const entries: ArchiveEntry[] = []
    let running = false
    for (const candidate of matches.slice(0, includeOutput ? MAX_AGENTS : MAX_ACTIVITY_AGENTS)) {
      if (Date.now() > deadline) { limited = true; break }
      const activity = this.activity.get(candidate.file)
      if (!includeOutput && activity?.revision === candidate.revision) {
        if (activity.running) { running = true; break }
        continue
      }
      const handle = await open(candidate.file, 'r').catch(() => null)
      if (!handle) continue
      try {
        const { size } = await handle.stat()
        const buffer = Buffer.alloc(Math.min(size, READ_BYTES))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - READ_BYTES))
        let tail = buffer.subarray(0, bytesRead).toString('utf8')
        if (size > READ_BYTES) tail = tail.slice(tail.indexOf('\n') + 1)
        const working = subagentLifecycleState(tail, candidate.header.startedAt) === 'working'
        if (this.activity.size >= 512) this.activity.delete(this.activity.keys().next().value!)
        this.activity.set(candidate.file, { revision: candidate.revision, running: working })
        running ||= working
        if (includeOutput) entries.push({ header: candidate.header, updatedAt: candidate.updatedAt, tail, truncated: size > READ_BYTES })
        else if (running) break
      } finally { await handle.close() }
    }
    return { entries, rootFound, total: matches.length, limited: limited || matches.length > MAX_AGENTS, running }
  }

  private async remote(rootId: string, folder: string, alias: string, includeOutput: boolean): Promise<ArchiveScan> {
    if (!alias || alias.startsWith('-') || /[\r\n\0]/.test(alias)) throw new Error('Invalid SSH connection.')
    const encodedScript = Buffer.from(REMOTE_SUBAGENT_SCRIPT).toString('base64')
    const params = Buffer.from(JSON.stringify({ rootId, folder, includeOutput })).toString('base64')
    const command = `python3 -c 'import base64;exec(base64.b64decode("${encodedScript}"))' '${params}'`
    let stdout: string
    try {
      const result = await execFileAsync('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', alias, command], {
        timeout: 15_000, maxBuffer: 12 * 1024 * 1024, encoding: 'utf8'
      })
      stdout = result.stdout
    } catch (error) {
      // Do not expose the encoded script/parameters from execFile's default error message.
      const detail = text(object(error).stderr).trim().slice(-1_200)
      throw new Error(detail || 'Could not read sub-agents on this host. Check SSH access and Python 3; the request may have timed out.')
    }
    let result: ArchiveScan
    try {
      result = JSON.parse(Buffer.from(stdout.trim().split(/\r?\n/).at(-1) || '', 'base64').toString('utf8'))
      if (!result || !Array.isArray(result.entries) || result.entries.length > MAX_AGENTS ||
        typeof result.rootFound !== 'boolean' || typeof result.total !== 'number' || typeof result.running !== 'boolean' ||
        !result.entries.every((entry) => entry && typeof entry.tail === 'string' && entry.tail.length <= READ_BYTES &&
          entry.header && typeof entry.header.id === 'string' && typeof entry.header.parentId === 'string' &&
          typeof entry.header.path === 'string' && typeof entry.header.name === 'string')) throw new Error()
    } catch { throw new Error('The host returned an invalid sub-agent archive response.') }
    return result
  }
}

// SSH scans execute on the project host, never against this laptop's archives.
export const REMOTE_SUBAGENT_SCRIPT = String.raw`
import base64, datetime, json, os, sys, time
p = json.loads(base64.b64decode(sys.argv[1]))
root = os.path.join(os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex"), "sessions")
limit = 256 * 1024
deadline = time.monotonic() + 8
candidates = []
count = 0
limited = False
def text(value):
    return value if isinstance(value, str) else ""
for directory, dirs, files in os.walk(root):
    dirs[:] = sorted([d for d in dirs if not os.path.islink(os.path.join(directory, d))], reverse=True)
    for name in sorted(files, reverse=True):
        count += 1
        if count > 20000 or time.monotonic() > deadline:
            limited = True
            break
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(directory, name)
        if os.path.islink(path):
            continue
        try:
            with open(path, "rb") as source:
                record = json.loads(source.readline(limit))
            if record.get("type") != "session_meta":
                continue
            m = record["payload"]
            source_info = m.get("source")
            spawn = source_info.get("subagent", {}).get("thread_spawn", {}) if isinstance(source_info, dict) else {}
            parent = text(spawn.get("parent_thread_id")) or (text(m.get("parent_thread_id")) if m.get("thread_source") == "subagent" else "")
            ident = text(m.get("id")) or text(m.get("session_id"))
            if not ident or not text(m.get("cwd")):
                continue
            header = {"id": ident, "parentId": parent or None, "cwd": m["cwd"],
                "name": (text(m.get("agent_nickname")) or text(spawn.get("agent_nickname")))[:120],
                "path": (text(m.get("agent_path")) or text(spawn.get("agent_path")))[:300],
                "startedAt": text(m.get("timestamp")) or text(record.get("timestamp"))}
            candidates.append((header, path, os.path.getmtime(path)))
        except (OSError, ValueError, TypeError, AttributeError, KeyError):
            continue
    if limited:
        break
root_found = any(h["id"] == p["rootId"] and os.path.realpath(h["cwd"]) == os.path.realpath(os.path.expanduser(p["folder"])) for h, _, _ in candidates)
related = {p["rootId"]}
if root_found:
    while True:
        more = {h["id"] for h, _, _ in candidates if h["parentId"] in related}
        if more.issubset(related):
            break
        related.update(more)
matches = sorted([c for c in candidates if c[0]["id"] != p["rootId"] and c[0]["id"] in related], key=lambda c: c[2], reverse=True)
entries = []
running = False
include_output = p.get("includeOutput", True)
def lifecycle_state(raw, started_at):
    state = "unknown"
    def timestamp(value):
        try:
            return datetime.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except (ValueError, TypeError, AttributeError):
            return None
    started = timestamp(started_at)
    for line in raw.splitlines():
        if b'"event_msg"' not in line:
            continue
        try:
            record = json.loads(line)
            if not isinstance(record, dict) or record.get("type") != "event_msg":
                continue
            at = timestamp(record.get("timestamp"))
            if started is not None and (at is None or at < started):
                continue
            payload = record.get("payload")
            kind = payload.get("type") if isinstance(payload, dict) else None
            if kind == "task_started":
                state = "working"
            elif kind == "task_complete":
                state = "finished"
            elif kind == "turn_aborted":
                state = "stopped"
        except (ValueError, TypeError):
            continue
    return state
for header, path, updated in matches[:24 if include_output else 128]:
    if time.monotonic() > deadline:
        limited = True
        break
    try:
        with open(path, "rb") as source:
            size = os.fstat(source.fileno()).st_size
            source.seek(max(0, size - limit))
            raw = source.read(limit)
            if size > limit:
                raw = raw.partition(b"\n")[2]
        running = running or lifecycle_state(raw, header["startedAt"]) == "working"
        if include_output:
            entries.append({"header": header, "tail": raw.decode("utf-8", errors="replace"), "truncated": size > limit,
                "updatedAt": datetime.datetime.fromtimestamp(updated, datetime.timezone.utc).isoformat()})
        elif running:
            break
    except OSError:
        continue
print(base64.b64encode(json.dumps({"entries": entries, "rootFound": root_found, "total": len(matches), "limited": limited or len(matches) > 24, "running": running}).encode()).decode())
`
