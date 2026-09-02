import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import type {
  Connection,
  CreateProjectActionInput,
  LatexComment,
  Project,
  ProjectAction,
  ProjectNote,
  ProjectNoteSummary,
  UpdateProjectActionInput
} from '../shared/types'
import {
  Store,
  validatedActionCommand,
  validatedActionId,
  validatedActionName
} from './store'

const PANEPILOT_DIRECTORY = '.panepilot'
const NOTES_DIRECTORY = 'notes'
const ACTIONS_FILE = 'actions.json'
const LATEX_COMMENTS_FILE = 'latex-comments.json'
const LEGACY_NOTES_FILE = '.notes-panepilot'
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_SHARED_ACTIONS = 100
const MAX_SHARED_LATEX_COMMENTS = 1_000

interface SharedActionDefinition {
  id: string
  name: string
  command: string
}

interface SharedActionsFile {
  version: 1
  actions: SharedActionDefinition[]
}

type SharedLatexComment = Omit<LatexComment, 'projectId'>

interface SharedLatexCommentsFile {
  version: 1
  comments: SharedLatexComment[]
}

interface LocalMetadataPaths {
  root: string
  metadata: string
  notes: string
  actions: string
  latexComments: string
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function decodeUtf8(bytes: Buffer, label: string): string {
  if (bytes.includes(0)) throw new Error(`${label} must be UTF-8 text.`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${label} must be UTF-8 text.`)
  }
}

function checkedDirectory(path: string, label: string): void {
  const existing = lstatSync(path, { throwIfNoEntry: false })
  if (!existing) {
    mkdirSync(path, { mode: 0o700 })
    return
  }
  if (existing.isSymbolicLink() || !existing.isDirectory()) {
    throw new Error(`${label} must be a regular directory inside the project folder.`)
  }
}

function nextLegacyNotePath(notesDirectory: string): string {
  const initial = resolve(notesDirectory, 'Project notes.md')
  if (!existsSync(initial)) return initial
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = resolve(notesDirectory, `Project notes ${suffix}.md`)
    if (!existsSync(candidate)) return candidate
  }
  throw new Error('Could not migrate the legacy PanePilot notes file.')
}

function ensureLocalMetadata(root: string): LocalMetadataPaths {
  const realRoot = realpathSync(root)
  if (!statSync(realRoot).isDirectory()) {
    throw new Error('The project folder does not exist.')
  }
  const metadata = resolve(realRoot, PANEPILOT_DIRECTORY)
  const notes = resolve(metadata, NOTES_DIRECTORY)
  checkedDirectory(metadata, PANEPILOT_DIRECTORY)
  checkedDirectory(notes, `${PANEPILOT_DIRECTORY}/${NOTES_DIRECTORY}`)

  const legacy = resolve(realRoot, LEGACY_NOTES_FILE)
  const legacyStat = lstatSync(legacy, { throwIfNoEntry: false })
  if (legacyStat) {
    if (legacyStat.isSymbolicLink() || !legacyStat.isFile()) {
      throw new Error(`${LEGACY_NOTES_FILE} must be a regular file to migrate it.`)
    }
    renameSync(legacy, nextLegacyNotePath(notes))
  }

  return {
    root: realRoot,
    metadata,
    notes,
    actions: resolve(metadata, ACTIONS_FILE),
    latexComments: resolve(metadata, LATEX_COMMENTS_FILE)
  }
}

function validatedNoteName(value: string): string {
  const name = value.trim().replace(/\.md$/i, '').trim()
  if (!name) throw new Error('Note name cannot be empty.')
  if (name === '.' || name === '..') throw new Error('Choose another note name.')
  if (name.length > 80) throw new Error('Note names must be 80 characters or fewer.')
  if (/[/\\<>:"|?*\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('Note names cannot contain path separators or reserved characters.')
  }
  return name
}

function validatedNotePath(value: string): string {
  const path = value.trim()
  if (
    !path ||
    path.length > 100 ||
    !path.toLowerCase().endsWith('.md') ||
    /[/\\\u0000-\u001f\u007f]/.test(path) ||
    path === '.md' ||
    path === '..md'
  ) {
    throw new Error('The project note path is invalid.')
  }
  return path
}

function noteNameForPath(path: string): string {
  return path.replace(/\.md$/i, '')
}

function checkedNoteFile(notesDirectory: string, path: string): string {
  const safePath = validatedNotePath(path)
  const target = resolve(notesDirectory, safePath)
  const stat = lstatSync(target, { throwIfNoEntry: false })
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Project note not found.')
  }
  return target
}

function atomicWrite(path: string, content: string): void {
  const temporaryPath = resolve(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`
  )
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, path)
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

function noteFromLocalFile(
  notesDirectory: string,
  path: string
): ProjectNote {
  const target = checkedNoteFile(notesDirectory, path)
  const stat = statSync(target)
  if (stat.size > MAX_METADATA_BYTES) {
    throw new Error('Project notes must be 1 MB or smaller.')
  }
  return {
    path,
    name: noteNameForPath(path),
    updatedAt: stat.mtime.toISOString(),
    content: decodeUtf8(readFileSync(target), 'Project notes')
  }
}

function listLocalNotes(root: string): ProjectNoteSummary[] {
  const { notes } = ensureLocalMetadata(root)
  return readdirSync(notes)
    .filter((path) => path.toLowerCase().endsWith('.md'))
    .flatMap((path): ProjectNoteSummary[] => {
      const target = resolve(notes, path)
      const stat = lstatSync(target, { throwIfNoEntry: false })
      if (!stat || stat.isSymbolicLink() || !stat.isFile()) return []
      return [{
        path,
        name: noteNameForPath(path),
        updatedAt: stat.mtime.toISOString()
      }]
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function createLocalNote(root: string, rawName: string): ProjectNote {
  const { notes } = ensureLocalMetadata(root)
  const name = validatedNoteName(rawName)
  const path = `${name}.md`
  const target = resolve(notes, path)
  if (lstatSync(target, { throwIfNoEntry: false })) {
    throw new Error(`A note named “${name}” already exists.`)
  }
  atomicWrite(target, `# ${name}\n\n`)
  return noteFromLocalFile(notes, path)
}

function readLocalNote(root: string, path: string): ProjectNote {
  return noteFromLocalFile(ensureLocalMetadata(root).notes, validatedNotePath(path))
}

function writeLocalNote(root: string, path: string, content: string): ProjectNote {
  if (Buffer.byteLength(content, 'utf8') > MAX_METADATA_BYTES) {
    throw new Error('Project notes must be 1 MB or smaller.')
  }
  const { notes } = ensureLocalMetadata(root)
  const safePath = validatedNotePath(path)
  const target = checkedNoteFile(notes, safePath)
  atomicWrite(target, content)
  return noteFromLocalFile(notes, safePath)
}

function renameLocalNote(
  root: string,
  path: string,
  rawName: string
): ProjectNote {
  const { notes } = ensureLocalMetadata(root)
  const currentPath = validatedNotePath(path)
  const current = checkedNoteFile(notes, currentPath)
  const name = validatedNoteName(rawName)
  const nextPath = `${name}.md`
  if (nextPath !== currentPath) {
    const next = resolve(notes, nextPath)
    if (lstatSync(next, { throwIfNoEntry: false })) {
      throw new Error(`A note named “${name}” already exists.`)
    }
    renameSync(current, next)
  }
  return noteFromLocalFile(notes, nextPath)
}

function deleteLocalNote(root: string, path: string): void {
  const { notes } = ensureLocalMetadata(root)
  unlinkSync(checkedNoteFile(notes, validatedNotePath(path)))
}

function parseSharedActions(value: unknown): SharedActionsFile {
  if (!value || typeof value !== 'object') {
    throw new Error(`${PANEPILOT_DIRECTORY}/${ACTIONS_FILE} is invalid.`)
  }
  const candidate = value as { version?: unknown; actions?: unknown }
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.actions) ||
    candidate.actions.length > MAX_SHARED_ACTIONS
  ) {
    throw new Error(`${PANEPILOT_DIRECTORY}/${ACTIONS_FILE} is invalid.`)
  }
  const ids = new Set<string>()
  const actions = candidate.actions.map((action): SharedActionDefinition => {
    if (!action || typeof action !== 'object') {
      throw new Error(`${PANEPILOT_DIRECTORY}/${ACTIONS_FILE} is invalid.`)
    }
    const input = action as { id?: unknown; name?: unknown; command?: unknown }
    if (
      typeof input.id !== 'string' ||
      typeof input.name !== 'string' ||
      typeof input.command !== 'string'
    ) {
      throw new Error(`${PANEPILOT_DIRECTORY}/${ACTIONS_FILE} is invalid.`)
    }
    const id = validatedActionId(input.id)
    if (ids.has(id)) {
      throw new Error(`${PANEPILOT_DIRECTORY}/${ACTIONS_FILE} contains duplicate action IDs.`)
    }
    ids.add(id)
    return {
      id,
      name: validatedActionName(input.name),
      command: validatedActionCommand(input.command)
    }
  })
  return { version: 1, actions }
}

function readLocalActions(root: string): SharedActionsFile | null {
  const { actions } = ensureLocalMetadata(root)
  const stat = lstatSync(actions, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${PANEPILOT_DIRECTORY}/${ACTIONS_FILE} must be a regular file.`)
  }
  if (stat.size > MAX_METADATA_BYTES) {
    throw new Error(`${PANEPILOT_DIRECTORY}/${ACTIONS_FILE} must be 1 MB or smaller.`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(readFileSync(actions), 'Shared actions'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${PANEPILOT_DIRECTORY}/${ACTIONS_FILE} is not valid JSON.`)
    }
    throw error
  }
  return parseSharedActions(parsed)
}

function writeLocalActions(root: string, file: SharedActionsFile): void {
  const { actions } = ensureLocalMetadata(root)
  const content = `${JSON.stringify(parseSharedActions(file), null, 2)}\n`
  if (Buffer.byteLength(content, 'utf8') > MAX_METADATA_BYTES) {
    throw new Error(`${PANEPILOT_DIRECTORY}/${ACTIONS_FILE} must be 1 MB or smaller.`)
  }
  atomicWrite(actions, content)
}

function parseSharedLatexComments(
  value: unknown,
  projectId: string
): LatexComment[] {
  const label = `${PANEPILOT_DIRECTORY}/${LATEX_COMMENTS_FILE}`
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} is invalid.`)
  }
  const file = value as { version?: unknown; comments?: unknown }
  if (
    file.version !== 1 ||
    !Array.isArray(file.comments) ||
    file.comments.length > MAX_SHARED_LATEX_COMMENTS
  ) {
    throw new Error(`${label} is invalid.`)
  }
  const ids = new Set<string>()
  return file.comments.map((value): LatexComment => {
    if (!value || typeof value !== 'object') throw new Error(`${label} is invalid.`)
    const comment = value as Record<string, unknown>
    const coordinates = [
      comment.startLine,
      comment.startColumn,
      comment.endLine,
      comment.endColumn
    ]
    if (
      typeof comment.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(comment.id) ||
      ids.has(comment.id) ||
      typeof comment.path !== 'string' ||
      !comment.path.toLowerCase().endsWith('.tex') ||
      comment.path.startsWith('/') ||
      comment.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      /[\\\u0000-\u001f\u007f]/.test(comment.path) ||
      typeof comment.body !== 'string' ||
      !comment.body.trim() ||
      comment.body.length > 10_000 ||
      typeof comment.selectedText !== 'string' ||
      !comment.selectedText ||
      comment.selectedText.length > 20_000 ||
      typeof comment.prefixContext !== 'string' ||
      comment.prefixContext.length > 240 ||
      typeof comment.suffixContext !== 'string' ||
      comment.suffixContext.length > 240 ||
      coordinates.some(
        (coordinate) =>
          typeof coordinate !== 'number' ||
          !Number.isSafeInteger(coordinate) ||
          coordinate < 1
      ) ||
      (comment.endLine as number) < (comment.startLine as number) ||
      typeof comment.createdAt !== 'string' ||
      typeof comment.updatedAt !== 'string'
    ) {
      throw new Error(`${label} contains an invalid comment.`)
    }
    ids.add(comment.id)
    return {
      id: comment.id,
      projectId,
      path: comment.path,
      body: comment.body,
      selectedText: comment.selectedText,
      startLine: comment.startLine as number,
      startColumn: comment.startColumn as number,
      endLine: comment.endLine as number,
      endColumn: comment.endColumn as number,
      prefixContext: comment.prefixContext,
      suffixContext: comment.suffixContext,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt
    }
  })
}

function sharedLatexCommentsFile(
  projectId: string,
  comments: LatexComment[]
): SharedLatexCommentsFile {
  const parsed = parseSharedLatexComments({
    version: 1,
    comments: comments.map(({ projectId: _projectId, ...comment }) => comment)
  }, projectId)
  return {
    version: 1,
    comments: parsed.map(({ projectId: _projectId, ...comment }) => comment)
  }
}

function readLocalLatexComments(root: string): unknown | null {
  const { latexComments } = ensureLocalMetadata(root)
  const stat = lstatSync(latexComments, { throwIfNoEntry: false })
  if (!stat) return null
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      `${PANEPILOT_DIRECTORY}/${LATEX_COMMENTS_FILE} must be a regular file.`
    )
  }
  if (stat.size > MAX_METADATA_BYTES) {
    throw new Error(
      `${PANEPILOT_DIRECTORY}/${LATEX_COMMENTS_FILE} must be 1 MB or smaller.`
    )
  }
  try {
    return JSON.parse(decodeUtf8(readFileSync(latexComments), 'LaTeX comments'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `${PANEPILOT_DIRECTORY}/${LATEX_COMMENTS_FILE} is not valid UTF-8 JSON.`
      )
    }
    throw error
  }
}

function writeLocalLatexComments(
  root: string,
  file: SharedLatexCommentsFile
): void {
  const { latexComments } = ensureLocalMetadata(root)
  const content = `${JSON.stringify(file, null, 2)}\n`
  if (Buffer.byteLength(content, 'utf8') > MAX_METADATA_BYTES) {
    throw new Error(
      `${PANEPILOT_DIRECTORY}/${LATEX_COMMENTS_FILE} must be 1 MB or smaller.`
    )
  }
  atomicWrite(latexComments, content)
}

const REMOTE_METADATA_SCRIPT = String.raw`
import datetime, json, os, re, sys, tempfile

payload = json.load(sys.stdin)
operation = payload["operation"]
root = os.path.realpath(os.path.expanduser(payload["root"]))
if not os.path.isdir(root):
    raise RuntimeError("The remote project folder does not exist.")

def checked_directory(path, label):
    if not os.path.lexists(path):
        os.mkdir(path, 0o700)
        return
    if os.path.islink(path) or not os.path.isdir(path):
        raise RuntimeError(label + " must be a regular directory inside the project folder.")

metadata = os.path.join(root, ".panepilot")
notes = os.path.join(metadata, "notes")
actions_path = os.path.join(metadata, "actions.json")
latex_comments_path = os.path.join(metadata, "latex-comments.json")
checked_directory(metadata, ".panepilot")
checked_directory(notes, ".panepilot/notes")

legacy = os.path.join(root, ".notes-panepilot")
if os.path.lexists(legacy):
    if os.path.islink(legacy) or not os.path.isfile(legacy):
        raise RuntimeError(".notes-panepilot must be a regular file to migrate it.")
    suffix = 1
    while True:
        label = "Project notes" if suffix == 1 else "Project notes " + str(suffix)
        destination = os.path.join(notes, label + ".md")
        if not os.path.lexists(destination):
            os.replace(legacy, destination)
            break
        suffix += 1
        if suffix >= 1000:
            raise RuntimeError("Could not migrate the legacy PanePilot notes file.")

def note_name(value):
    name = str(value).strip()
    if name.lower().endswith(".md"):
        name = name[:-3].strip()
    if not name or name in (".", ".."):
        raise RuntimeError("Note name cannot be empty.")
    if len(name) > 80:
        raise RuntimeError("Note names must be 80 characters or fewer.")
    if re.search(r'[/\\<>:"|?*\x00-\x1f\x7f]', name):
        raise RuntimeError("Note names cannot contain path separators or reserved characters.")
    return name

def note_path(value):
    path = str(value).strip()
    if (
        not path
        or len(path) > 100
        or not path.lower().endswith(".md")
        or "/" in path
        or "\\" in path
        or any(ord(character) < 32 or ord(character) == 127 for character in path)
        or path in (".md", "..md")
    ):
        raise RuntimeError("The project note path is invalid.")
    return path

def iso_time(timestamp):
    return datetime.datetime.fromtimestamp(
        timestamp, datetime.timezone.utc
    ).isoformat().replace("+00:00", "Z")

def checked_note(path):
    safe = note_path(path)
    target = os.path.join(notes, safe)
    if os.path.islink(target) or not os.path.isfile(target):
        raise RuntimeError("Project note not found.")
    return safe, target

def note_result(path, include_content):
    safe, target = checked_note(path)
    stat = os.stat(target)
    result = {
        "path": safe,
        "name": safe[:-3],
        "updatedAt": iso_time(stat.st_mtime),
    }
    if include_content:
        if stat.st_size > 1024 * 1024:
            raise RuntimeError("Project notes must be 1 MB or smaller.")
        with open(target, "rb") as handle:
            raw = handle.read()
        if b"\0" in raw:
            raise RuntimeError("Project notes must be UTF-8 text.")
        try:
            result["content"] = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise RuntimeError("Project notes must be UTF-8 text.")
    return result

def atomic_write(path, content):
    temporary = None
    try:
        handle = tempfile.NamedTemporaryFile(
            mode="wb",
            dir=os.path.dirname(path),
            prefix="." + os.path.basename(path) + ".",
            suffix=".tmp",
            delete=False,
        )
        temporary = handle.name
        with handle:
            os.chmod(temporary, 0o600)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)

if operation == "note-list":
    result = []
    for path in sorted(os.listdir(notes), key=str.lower):
        if not path.lower().endswith(".md"):
            continue
        target = os.path.join(notes, path)
        if os.path.islink(target) or not os.path.isfile(target):
            continue
        stat = os.stat(target)
        result.append({
            "path": path,
            "name": path[:-3],
            "updatedAt": iso_time(stat.st_mtime),
        })
    print(json.dumps(result))
elif operation == "note-create":
    name = note_name(payload["name"])
    path = name + ".md"
    target = os.path.join(notes, path)
    if os.path.lexists(target):
        raise RuntimeError("A note named “" + name + "” already exists.")
    atomic_write(target, ("# " + name + "\n\n").encode("utf-8"))
    print(json.dumps(note_result(path, True)))
elif operation == "note-read":
    print(json.dumps(note_result(payload["path"], True)))
elif operation == "note-write":
    safe, target = checked_note(payload["path"])
    content = payload["content"].encode("utf-8")
    if len(content) > 1024 * 1024:
        raise RuntimeError("Project notes must be 1 MB or smaller.")
    atomic_write(target, content)
    print(json.dumps(note_result(safe, True)))
elif operation == "note-rename":
    current_path, current = checked_note(payload["path"])
    name = note_name(payload["name"])
    next_path = name + ".md"
    if next_path != current_path:
        target = os.path.join(notes, next_path)
        if os.path.lexists(target):
            raise RuntimeError("A note named “" + name + "” already exists.")
        os.replace(current, target)
    print(json.dumps(note_result(next_path, True)))
elif operation == "note-delete":
    _, target = checked_note(payload["path"])
    os.unlink(target)
    print("{}")
elif operation == "actions-read":
    if not os.path.lexists(actions_path):
        print("null")
    else:
        if os.path.islink(actions_path) or not os.path.isfile(actions_path):
            raise RuntimeError(".panepilot/actions.json must be a regular file.")
        if os.path.getsize(actions_path) > 1024 * 1024:
            raise RuntimeError(".panepilot/actions.json must be 1 MB or smaller.")
        with open(actions_path, "rb") as handle:
            raw = handle.read()
        try:
            decoded = raw.decode("utf-8")
            json.loads(decoded)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise RuntimeError(".panepilot/actions.json is not valid UTF-8 JSON.")
        print(decoded)
elif operation == "actions-write":
    content = json.dumps(payload["file"], indent=2, ensure_ascii=False) + "\n"
    encoded = content.encode("utf-8")
    if len(encoded) > 1024 * 1024:
        raise RuntimeError(".panepilot/actions.json must be 1 MB or smaller.")
    atomic_write(actions_path, encoded)
    print("{}")
elif operation == "latex-comments-read":
    if not os.path.lexists(latex_comments_path):
        print("null")
    else:
        if os.path.islink(latex_comments_path) or not os.path.isfile(latex_comments_path):
            raise RuntimeError(".panepilot/latex-comments.json must be a regular file.")
        if os.path.getsize(latex_comments_path) > 1024 * 1024:
            raise RuntimeError(".panepilot/latex-comments.json must be 1 MB or smaller.")
        with open(latex_comments_path, "rb") as handle:
            raw = handle.read()
        try:
            decoded = raw.decode("utf-8")
            json.loads(decoded)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise RuntimeError(".panepilot/latex-comments.json is not valid UTF-8 JSON.")
        print(decoded)
elif operation == "latex-comments-write":
    content = json.dumps(payload["file"], indent=2, ensure_ascii=False) + "\n"
    encoded = content.encode("utf-8")
    if len(encoded) > 1024 * 1024:
        raise RuntimeError(".panepilot/latex-comments.json must be 1 MB or smaller.")
    atomic_write(latex_comments_path, encoded)
    print("{}")
else:
    raise RuntimeError("Unsupported PanePilot metadata operation.")
`

function runRemoteMetadata<T>(
  sshAlias: string,
  root: string,
  operation: string,
  payload: Record<string, unknown> = {}
): T {
  const encodedScript = Buffer.from(REMOTE_METADATA_SCRIPT, 'utf8').toString('base64')
  const loader = `import base64;exec(base64.b64decode('${encodedScript}'))`
  const result = spawnSync(
    'ssh',
    [
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      sshAlias,
      `python3 -c ${quote(loader)}`
    ],
    {
      encoding: 'utf8',
      input: JSON.stringify({ ...payload, root, operation }),
      maxBuffer: 4 * 1024 * 1024,
      timeout: 15_000
    }
  )
  if (result.error) {
    throw new Error(
      result.error.message.includes('ETIMEDOUT')
        ? `Timed out connecting to ${sshAlias}.`
        : result.error.message
    )
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split(/\r?\n/).at(-1)
    throw new Error(
      detail || `Could not update project metadata on ${sshAlias}.`
    )
  }
  try {
    return JSON.parse(result.stdout || 'null') as T
  } catch {
    throw new Error(`The metadata response from ${sshAlias} was not valid JSON.`)
  }
}

function runRemoteMetadataAsync<T>(
  sshAlias: string,
  root: string,
  operation: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const encodedScript = Buffer.from(REMOTE_METADATA_SCRIPT, 'utf8').toString('base64')
  const loader = `import base64;exec(base64.b64decode('${encodedScript}'))`
  return new Promise<T>((resolve, reject) => {
    const child = spawn(
      'ssh',
      [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        sshAlias,
        `python3 -c ${quote(loader)}`
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const stdout: Buffer[] = []
    let stdoutLength = 0
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`Timed out connecting to ${sshAlias}.`))
    }, 15_000)

    function finish(error?: Error, value?: T): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value as T)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLength += chunk.length
      if (stdoutLength > 4 * 1024 * 1024) {
        child.kill()
        finish(new Error(`The metadata response from ${sshAlias} was too large.`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-64 * 1024)
    })
    child.once('error', (error) => finish(error))
    child.once('close', (code) => {
      if (settled) return
      if (code !== 0) {
        const detail = stderr.trim().split(/\r?\n/).at(-1)
        finish(
          new Error(
            detail || `Could not update project metadata on ${sshAlias}.`
          )
        )
        return
      }
      try {
        finish(
          undefined,
          JSON.parse(Buffer.concat(stdout).toString('utf8') || 'null') as T
        )
      } catch {
        finish(new Error(`The metadata response from ${sshAlias} was not valid JSON.`))
      }
    })
    child.stdin.on('error', () => {
      // The SSH process close handler reports the actionable failure.
    })
    child.stdin.end(JSON.stringify({ ...payload, root, operation }))
  })
}

function definitions(actions: ProjectAction[]): SharedActionDefinition[] {
  return actions.map(({ id, name, command }) => ({ id, name, command }))
}

export class ProjectMetadataService {
  constructor(private readonly store: Store) {}

  private target(projectId: string): {
    project: Project
    connection: Connection
  } {
    const project = this.store.getProjectWithoutOutput(projectId)
    if (!project) throw new Error('Project not found.')
    const connection = this.store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return { project, connection }
  }

  listNotes(projectId: string): ProjectNoteSummary[] {
    const { project, connection } = this.target(projectId)
    return connection.kind === 'local'
      ? listLocalNotes(project.folder)
      : runRemoteMetadata<ProjectNoteSummary[]>(
          connection.sshAlias!,
          project.folder,
          'note-list'
        )
  }

  createNote(projectId: string, name: string): ProjectNote {
    const { project, connection } = this.target(projectId)
    return connection.kind === 'local'
      ? createLocalNote(project.folder, name)
      : runRemoteMetadata<ProjectNote>(
          connection.sshAlias!,
          project.folder,
          'note-create',
          { name }
        )
  }

  readNote(projectId: string, path: string): ProjectNote {
    const { project, connection } = this.target(projectId)
    return connection.kind === 'local'
      ? readLocalNote(project.folder, path)
      : runRemoteMetadata<ProjectNote>(
          connection.sshAlias!,
          project.folder,
          'note-read',
          { path }
        )
  }

  writeNote(projectId: string, path: string, content: string): ProjectNote {
    const { project, connection } = this.target(projectId)
    return connection.kind === 'local'
      ? writeLocalNote(project.folder, path, content)
      : runRemoteMetadata<ProjectNote>(
          connection.sshAlias!,
          project.folder,
          'note-write',
          { path, content }
        )
  }

  renameNote(projectId: string, path: string, name: string): ProjectNote {
    const { project, connection } = this.target(projectId)
    return connection.kind === 'local'
      ? renameLocalNote(project.folder, path, name)
      : runRemoteMetadata<ProjectNote>(
          connection.sshAlias!,
          project.folder,
          'note-rename',
          { path, name }
        )
  }

  deleteNote(projectId: string, path: string): void {
    const { project, connection } = this.target(projectId)
    if (connection.kind === 'local') {
      deleteLocalNote(project.folder, path)
    } else {
      runRemoteMetadata<Record<string, never>>(
        connection.sshAlias!,
        project.folder,
        'note-delete',
        { path }
      )
    }
  }

  private async readLatexComments(
    project: Project,
    connection: Connection
  ): Promise<unknown | null> {
    return connection.kind === 'local'
      ? readLocalLatexComments(project.folder)
      : runRemoteMetadataAsync<unknown>(
          connection.sshAlias!,
          project.folder,
          'latex-comments-read'
        )
  }

  private async writeLatexComments(
    project: Project,
    connection: Connection,
    comments: LatexComment[]
  ): Promise<void> {
    const file = sharedLatexCommentsFile(project.id, comments)
    if (connection.kind === 'local') {
      writeLocalLatexComments(project.folder, file)
      return
    }
    await runRemoteMetadataAsync<Record<string, never>>(
      connection.sshAlias!,
      project.folder,
      'latex-comments-write',
      { file }
    )
  }

  async listLatexComments(
    projectId: string,
    legacyComments: LatexComment[] = []
  ): Promise<LatexComment[]> {
    const { project, connection } = this.target(projectId)
    if (project.type !== 'latex') throw new Error('LaTeX project not found.')
    const raw = await this.readLatexComments(project, connection)
    if (raw == null) {
      const migrated = parseSharedLatexComments(
        sharedLatexCommentsFile(project.id, legacyComments),
        project.id
      )
      await this.writeLatexComments(project, connection, migrated)
      return migrated
    }
    return parseSharedLatexComments(raw, project.id).sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.startLine - right.startLine ||
        left.startColumn - right.startColumn ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
    )
  }

  async createLatexComment(
    projectId: string,
    input: Omit<LatexComment, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>,
    legacyComments: LatexComment[] = []
  ): Promise<LatexComment> {
    const current = await this.listLatexComments(projectId, legacyComments)
    if (current.length >= MAX_SHARED_LATEX_COMMENTS) {
      throw new Error('This project already has the maximum of 1,000 LaTeX comments.')
    }
    const timestamp = new Date().toISOString()
    const comment: LatexComment = {
      ...input,
      id: randomUUID(),
      projectId,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    const { project, connection } = this.target(projectId)
    await this.writeLatexComments(project, connection, [...current, comment])
    return comment
  }

  async deleteLatexComment(
    projectId: string,
    commentId: string,
    legacyComments: LatexComment[] = []
  ): Promise<void> {
    const current = await this.listLatexComments(projectId, legacyComments)
    if (!current.some((comment) => comment.id === commentId)) return
    const { project, connection } = this.target(projectId)
    await this.writeLatexComments(
      project,
      connection,
      current.filter((comment) => comment.id !== commentId)
    )
  }

  private readActions(project: Project, connection: Connection): SharedActionsFile | null {
    const raw =
      connection.kind === 'local'
        ? readLocalActions(project.folder)
        : runRemoteMetadata<unknown>(
            connection.sshAlias!,
            project.folder,
            'actions-read'
          )
    return raw == null ? null : parseSharedActions(raw)
  }

  private writeActions(
    project: Project,
    connection: Connection,
    actions: SharedActionDefinition[]
  ): void {
    const file = parseSharedActions({ version: 1, actions })
    if (connection.kind === 'local') {
      writeLocalActions(project.folder, file)
    } else {
      runRemoteMetadata<Record<string, never>>(
        connection.sshAlias!,
        project.folder,
        'actions-write',
        { file }
      )
    }
  }

  syncActions(projectId: string): ProjectAction[] {
    const { project, connection } = this.target(projectId)
    const shared = this.readActions(project, connection)
    if (!shared) {
      this.writeActions(project, connection, definitions(project.actions))
      return project.actions
    }

    for (const action of shared.actions) {
      this.store.upsertSharedProjectAction(projectId, action)
    }
    const sharedIds = new Set(shared.actions.map((action) => action.id))
    const local = this.store.getProjectWithoutOutput(projectId)?.actions ?? []
    for (const action of local) {
      if (sharedIds.has(action.id)) continue
      const session = action.lastSessionId
        ? this.store.getSession(action.lastSessionId)
        : null
      if (session && !['completed', 'error'].includes(session.state)) continue
      this.store.deleteProjectAction(action.id)
    }
    return this.store.getProjectWithoutOutput(projectId)?.actions ?? []
  }

  createAction(input: CreateProjectActionInput): ProjectAction {
    const current = this.syncActions(input.projectId)
    const { project, connection } = this.target(input.projectId)
    const next: SharedActionDefinition = {
      id: randomUUID(),
      name: validatedActionName(input.name),
      command: validatedActionCommand(input.command)
    }
    this.writeActions(project, connection, [...definitions(current), next])
    return this.store.createProjectAction({ ...next, projectId: input.projectId })
  }

  updateAction(input: UpdateProjectActionInput): ProjectAction {
    const currentAction = this.store.getProjectAction(input.actionId)
    if (!currentAction) throw new Error('Action not found.')
    const current = this.syncActions(currentAction.projectId)
    const action = current.find((candidate) => candidate.id === input.actionId)
    if (!action) throw new Error('Action not found.')
    const next: SharedActionDefinition = {
      id: action.id,
      name: validatedActionName(input.name),
      command: validatedActionCommand(input.command)
    }
    const { project, connection } = this.target(action.projectId)
    this.writeActions(
      project,
      connection,
      definitions(current).map((candidate) =>
        candidate.id === next.id ? next : candidate
      )
    )
    return this.store.updateProjectAction(action.id, next)
  }

  deleteAction(actionId: string): void {
    const initial = this.store.getProjectAction(actionId)
    if (!initial) throw new Error('Action not found.')
    const current = this.syncActions(initial.projectId)
    const action = current.find((candidate) => candidate.id === actionId)
    if (!action) return
    const session = action.lastSessionId
      ? this.store.getSession(action.lastSessionId)
      : null
    if (session && !['completed', 'error'].includes(session.state)) {
      throw new Error('Stop the current action run before deleting it.')
    }
    const { project, connection } = this.target(action.projectId)
    this.writeActions(
      project,
      connection,
      definitions(current).filter((candidate) => candidate.id !== actionId)
    )
    this.store.deleteProjectAction(actionId)
  }
}
