import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, renameSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type {
  FileEntry,
  FileOpenResult,
  FilePreview,
  RemoteFolderListing
} from '../shared/types'

const MAX_FILE_BYTES = 1024 * 1024
const SEARCH_RESULT_LIMIT = 200
const SEARCH_SCAN_LIMIT = 20_000

export interface RemoteBinaryFile {
  dataBase64: string
  size: number
  modifiedAt: string
}

const LIST_FOLDERS_SCRIPT = String.raw`
import json, os, sys
payload = json.load(sys.stdin)
requested = payload.get("path") or os.path.expanduser("~")
current = os.path.realpath(os.path.expanduser(requested))
if not os.path.isdir(current):
    raise RuntimeError("The remote folder does not exist.")
entries = []
for item in os.scandir(current):
    try:
        if item.is_dir(follow_symlinks=True):
            entries.append({"name": item.name, "path": os.path.realpath(item.path), "kind": "directory", "size": None})
    except OSError:
        pass
entries.sort(key=lambda item: item["name"].lower())
parent = os.path.dirname(current)
print(json.dumps({"currentPath": current, "parentPath": None if parent == current else parent, "entries": entries}))
`

const LIST_FILES_SCRIPT = String.raw`
import json, os, sys
payload = json.load(sys.stdin)
root = os.path.realpath(os.path.expanduser(payload["root"]))
requested = payload.get("relativePath") or "."
target = os.path.realpath(os.path.join(root, requested))
if os.path.commonpath([root, target]) != root:
    raise RuntimeError("The requested path is outside the project folder.")
if not os.path.isdir(target):
    raise RuntimeError("The requested path is not a directory.")
entries = []
for item in os.scandir(target):
    if item.name in (".git", "node_modules"):
        continue
    try:
        real = os.path.realpath(item.path)
        if os.path.commonpath([root, real]) != root:
            continue
        stat = item.stat(follow_symlinks=True)
        is_dir = item.is_dir(follow_symlinks=True)
        entries.append({
            "name": item.name,
            "path": os.path.relpath(real, root),
            "kind": "directory" if is_dir else "file",
            "size": None if is_dir else stat.st_size,
        })
    except OSError:
        pass
entries.sort(key=lambda item: (item["kind"] != "directory", item["name"].lower()))
print(json.dumps(entries))
`

const PREVIEW_FILE_SCRIPT = String.raw`
import base64, json, os, sys
payload = json.load(sys.stdin)
root = os.path.realpath(os.path.expanduser(payload["root"]))
target = os.path.realpath(os.path.join(root, payload["relativePath"]))
if os.path.commonpath([root, target]) != root:
    raise RuntimeError("The requested path is outside the project folder.")
if not os.path.isfile(target):
    raise RuntimeError("The requested path is not a file.")
size = os.path.getsize(target)
with open(target, "rb") as handle:
    content = handle.read(1024 * 1024)
image_mimes = {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}
image_mime = image_mimes.get(os.path.splitext(target)[1].lower())
image_data = base64.b64encode(content).decode("ascii") if image_mime and size <= 1024 * 1024 else None
binary = image_mime is not None or b"\0" in content
print(json.dumps({
    "path": payload["relativePath"],
    "content": "" if binary else base64.b64encode(content).decode("ascii"),
    "truncated": size > 1024 * 1024,
    "binary": binary,
    "imageMimeType": image_mime,
    "imageDataUrl": None if image_data is None else "data:" + image_mime + ";base64," + image_data,
}))
`

const READ_BINARY_FILE_SCRIPT = String.raw`
import base64, datetime, json, os, sys
payload = json.load(sys.stdin)
root = os.path.realpath(os.path.expanduser(payload["root"]))
target = os.path.realpath(os.path.join(root, payload["relativePath"]))
if os.path.commonpath([root, target]) != root:
    raise RuntimeError("The requested path is outside the project folder.")
if not os.path.isfile(target):
    raise RuntimeError("The requested file has not been built yet.")
size = os.path.getsize(target)
max_bytes = int(payload["maxBytes"])
if size > max_bytes:
    raise RuntimeError("The requested file is too large to preview in PanePilot.")
with open(target, "rb") as handle:
    content = handle.read()
modified = datetime.datetime.fromtimestamp(
    os.path.getmtime(target), datetime.timezone.utc
).isoformat().replace("+00:00", "Z")
print(json.dumps({
    "dataBase64": base64.b64encode(content).decode("ascii"),
    "size": size,
    "modifiedAt": modified,
}, separators=(",", ":")))
`

const OPEN_PATH_SCRIPT = String.raw`
import base64, json, os, sys
payload = json.load(sys.stdin)
root = os.path.realpath(os.path.expanduser(payload["root"]))
target = os.path.realpath(os.path.join(root, payload["relativePath"]))
if os.path.commonpath([root, target]) != root:
    raise RuntimeError("The requested path is outside the project folder.")

def relative(path):
    value = os.path.relpath(path, root).replace(os.sep, "/")
    return "." if value == "." else value

def list_entries(directory):
    entries = []
    for item in os.scandir(directory):
        if item.name in (".git", "node_modules"):
            continue
        try:
            real = os.path.realpath(item.path)
            if os.path.commonpath([root, real]) != root:
                continue
            stat = item.stat(follow_symlinks=True)
            is_dir = item.is_dir(follow_symlinks=True)
            entries.append({
                "name": item.name,
                "path": relative(real),
                "kind": "directory" if is_dir else "file",
                "size": None if is_dir else stat.st_size,
            })
        except OSError:
            pass
    entries.sort(key=lambda item: (item["kind"] != "directory", item["name"].lower()))
    return entries

if os.path.isdir(target):
    path = relative(target)
    print(json.dumps({
        "kind": "directory",
        "path": path,
        "directoryPath": path,
        "entries": list_entries(target),
        "preview": None,
    }))
elif os.path.isfile(target):
    size = os.path.getsize(target)
    with open(target, "rb") as handle:
        content = handle.read(1024 * 1024)
    image_mimes = {
        ".avif": "image/avif",
        ".bmp": "image/bmp",
        ".gif": "image/gif",
        ".jpeg": "image/jpeg",
        ".jpg": "image/jpeg",
        ".png": "image/png",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
    }
    image_mime = image_mimes.get(os.path.splitext(target)[1].lower())
    image_data = base64.b64encode(content).decode("ascii") if image_mime and size <= 1024 * 1024 else None
    binary = image_mime is not None or b"\0" in content
    path = relative(target)
    directory = os.path.dirname(target)
    print(json.dumps({
        "kind": "file",
        "path": path,
        "directoryPath": relative(directory),
        "entries": list_entries(directory),
        "preview": {
            "path": path,
            "content": "" if binary else base64.b64encode(content).decode("ascii"),
            "truncated": size > 1024 * 1024,
            "binary": binary,
            "imageMimeType": image_mime,
            "imageDataUrl": None if image_data is None else "data:" + image_mime + ";base64," + image_data,
        },
    }))
else:
    raise RuntimeError("The requested path is not a file or directory: " + payload["relativePath"])
`

const SEARCH_FILES_SCRIPT = String.raw`
import json, os, sys
payload = json.load(sys.stdin)
root = os.path.realpath(os.path.expanduser(payload["root"]))
query = (payload.get("query") or "").strip().lower()
max_results = int(payload.get("maxResults", 200))
max_scanned = int(payload.get("maxScanned", 20000))
if not os.path.isdir(root):
    raise RuntimeError("The remote project folder does not exist.")
results = []
scanned = 0
for directory, directories, filenames in os.walk(root, followlinks=False):
    directories[:] = sorted(
        name for name in directories
        if name not in (".git", "node_modules")
    )
    names = [(name, "directory") for name in directories]
    names.extend((name, "file") for name in sorted(filenames))
    for name, kind in names:
        if scanned >= max_scanned or len(results) >= max_results:
            break
        scanned += 1
        path = os.path.realpath(os.path.join(directory, name))
        if os.path.commonpath([root, path]) != root:
            continue
        relative = os.path.relpath(path, root).replace(os.sep, "/")
        if query not in relative.lower():
            continue
        try:
            size = None if kind == "directory" else os.path.getsize(path)
        except OSError:
            continue
        results.append({"name": name, "path": relative, "kind": kind, "size": size})
    if scanned >= max_scanned or len(results) >= max_results:
        break
results.sort(key=lambda item: (item["kind"] != "directory", item["path"].lower()))
print(json.dumps(results, separators=(",", ":")))
`

const WRITE_FILE_SCRIPT = String.raw`
import json, os, sys
payload = json.load(sys.stdin)
root = os.path.realpath(os.path.expanduser(payload["root"]))
target = os.path.realpath(os.path.join(root, payload["relativePath"]))
if os.path.commonpath([root, target]) != root:
    raise RuntimeError("The requested path is outside the project folder.")
if not os.path.isfile(target):
    raise RuntimeError("The requested path is not a file.")
content = payload["content"].encode("utf-8")
if len(content) > 1024 * 1024:
    raise RuntimeError("PanePilot only edits files up to 1 MB.")
with open(target, "wb") as handle:
    handle.write(content)
print("{}")
`

const DOWNLOAD_FILE_SCRIPT = String.raw`
import json, os, sys
payload = json.load(sys.stdin)
root = os.path.realpath(os.path.expanduser(payload["root"]))
target = os.path.realpath(os.path.join(root, payload["relativePath"]))
if os.path.commonpath([root, target]) != root:
    raise RuntimeError("The requested path is outside the project folder.")
if not os.path.isfile(target):
    raise RuntimeError("The requested path is not a file.")
with open(target, "rb") as handle:
    while True:
        chunk = handle.read(1024 * 1024)
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
`

const READ_TEXT_FILES_SCRIPT = String.raw`
import base64, json, os, sys
payload = json.load(sys.stdin)
root = os.path.realpath(os.path.expanduser(payload["root"]))
extension = payload.get("extension", "")
max_files = int(payload.get("maxFiles", 256))
max_total = int(payload.get("maxTotalBytes", 8 * 1024 * 1024))
files = {}
total = 0
if not os.path.isdir(root):
    raise RuntimeError("The remote project folder does not exist.")
for directory, directories, filenames in os.walk(root):
    directories[:] = [
        name for name in directories
        if name not in (".git", "node_modules") and not name.startswith(".")
    ]
    for filename in sorted(filenames):
        if extension and not filename.lower().endswith(extension.lower()):
            continue
        path = os.path.realpath(os.path.join(directory, filename))
        if os.path.commonpath([root, path]) != root or not os.path.isfile(path):
            continue
        size = os.path.getsize(path)
        if size > 1024 * 1024 or total + size > max_total:
            continue
        with open(path, "rb") as handle:
            content = handle.read()
        if b"\0" in content:
            continue
        relative = os.path.relpath(path, root).replace(os.sep, "/")
        files[relative] = base64.b64encode(content).decode("ascii")
        total += size
        if len(files) >= max_files:
            break
    if len(files) >= max_files:
        break
print(json.dumps(files, separators=(",", ":")))
`

const DIRECTORY_EXISTS_SCRIPT = String.raw`
import json, os, sys
payload = json.load(sys.stdin)
root = os.path.realpath(os.path.expanduser(payload["root"]))
target = os.path.realpath(os.path.join(root, payload["relativePath"]))
inside = os.path.commonpath([root, target]) == root
print(json.dumps({"exists": inside and os.path.isdir(target)}))
`

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function runRemotePython<T>(
  sshAlias: string,
  script: string,
  payload: Record<string, unknown>,
  maxBuffer = 4 * 1024 * 1024
): T {
  const encodedScript = Buffer.from(script, 'utf8').toString('base64')
  const loader = `import base64;exec(base64.b64decode('${encodedScript}'))`
  const command = `python3 -c ${quote(loader)}`
  const result = spawnSync(
    'ssh',
    ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshAlias, command],
    {
      encoding: 'utf8',
      input: JSON.stringify(payload),
      maxBuffer,
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
      detail || `Could not browse ${sshAlias}. Make sure SSH key authentication is available.`
    )
  }
  try {
    return JSON.parse(result.stdout ?? '') as T
  } catch {
    throw new Error(`The response from ${sshAlias} was not valid JSON.`)
  }
}

function runRemotePythonAsync<T>(
  sshAlias: string,
  script: string,
  payload: Record<string, unknown>,
  maxBuffer = 4 * 1024 * 1024,
  timeoutMs = 15_000
): Promise<T> {
  const encodedScript = Buffer.from(script, 'utf8').toString('base64')
  const loader = `import base64;exec(base64.b64decode('${encodedScript}'))`
  const command = `python3 -c ${quote(loader)}`

  return new Promise<T>((resolve, reject) => {
    const child = spawn(
      'ssh',
      ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshAlias, command],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const stdout: Buffer[] = []
    let stdoutLength = 0
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      child.kill()
      finish(new Error(`Timed out connecting to ${sshAlias}.`))
    }, timeoutMs)

    function finish(error?: Error, value?: T): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value as T)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutLength += chunk.length
      if (stdoutLength > maxBuffer) {
        child.kill()
        finish(new Error(`The response from ${sshAlias} was too large.`))
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
            detail ||
              `Could not browse ${sshAlias}. Make sure SSH key authentication is available.`
          )
        )
        return
      }
      try {
        finish(undefined, JSON.parse(Buffer.concat(stdout).toString('utf8')) as T)
      } catch {
        finish(new Error(`The response from ${sshAlias} was not valid JSON.`))
      }
    })
    child.stdin.on('error', () => {
      // A remote validation or SSH failure can close stdin before the payload
      // finishes. The process close handler reports the useful error.
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

export function listRemoteFolders(
  sshAlias: string,
  path?: string
): RemoteFolderListing {
  return runRemotePython<RemoteFolderListing>(sshAlias, LIST_FOLDERS_SCRIPT, { path })
}

export function listRemoteFiles(
  sshAlias: string,
  root: string,
  relativePath = '.'
): FileEntry[] {
  return runRemotePython<FileEntry[]>(sshAlias, LIST_FILES_SCRIPT, { root, relativePath })
}

export function listRemoteFilesAsync(
  sshAlias: string,
  root: string,
  relativePath = '.'
): Promise<FileEntry[]> {
  return runRemotePythonAsync<FileEntry[]>(sshAlias, LIST_FILES_SCRIPT, {
    root,
    relativePath
  })
}

export function searchRemoteFiles(
  sshAlias: string,
  root: string,
  query: string
): Promise<FileEntry[]> {
  if (!query.trim()) return Promise.resolve([])
  return runRemotePythonAsync<FileEntry[]>(sshAlias, SEARCH_FILES_SCRIPT, {
    root,
    query,
    maxResults: SEARCH_RESULT_LIMIT,
    maxScanned: SEARCH_SCAN_LIMIT
  })
}

export function previewRemoteFile(
  sshAlias: string,
  root: string,
  relativePath: string
): FilePreview {
  const preview = runRemotePython<FilePreview>(sshAlias, PREVIEW_FILE_SCRIPT, {
    root,
    relativePath
  })
  if (!preview.binary) preview.content = Buffer.from(preview.content, 'base64').toString('utf8')
  return preview
}

export async function previewRemoteFileAsync(
  sshAlias: string,
  root: string,
  relativePath: string
): Promise<FilePreview> {
  const preview = await runRemotePythonAsync<FilePreview>(
    sshAlias,
    PREVIEW_FILE_SCRIPT,
    { root, relativePath }
  )
  if (!preview.binary) {
    preview.content = Buffer.from(preview.content, 'base64').toString('utf8')
  }
  return preview
}

export function readRemoteBinaryFile(
  sshAlias: string,
  root: string,
  relativePath: string,
  maxBytes: number
): Promise<RemoteBinaryFile> {
  const encodedBytes = Math.ceil(maxBytes / 3) * 4
  return runRemotePythonAsync<RemoteBinaryFile>(
    sshAlias,
    READ_BINARY_FILE_SCRIPT,
    { root, relativePath, maxBytes },
    encodedBytes + 256 * 1024,
    30_000
  )
}

export async function openRemotePath(
  sshAlias: string,
  root: string,
  relativePath: string
): Promise<FileOpenResult> {
  const result = await runRemotePythonAsync<FileOpenResult>(
    sshAlias,
    OPEN_PATH_SCRIPT,
    { root, relativePath },
    8 * 1024 * 1024
  )
  if (result.preview && !result.preview.binary) {
    result.preview.content = Buffer.from(
      result.preview.content,
      'base64'
    ).toString('utf8')
  }
  return result
}

export function writeRemoteFile(
  sshAlias: string,
  root: string,
  relativePath: string,
  content: string
): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('PanePilot only edits files up to 1 MB.')
  }
  runRemotePython<Record<string, never>>(sshAlias, WRITE_FILE_SCRIPT, {
    root,
    relativePath,
    content
  })
}

export async function writeRemoteFileAsync(
  sshAlias: string,
  root: string,
  relativePath: string,
  content: string
): Promise<void> {
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('PanePilot only edits files up to 1 MB.')
  }
  await runRemotePythonAsync<Record<string, never>>(
    sshAlias,
    WRITE_FILE_SCRIPT,
    { root, relativePath, content }
  )
}

export async function downloadRemoteFile(
  sshAlias: string,
  root: string,
  relativePath: string,
  destination: string
): Promise<void> {
  const encodedScript = Buffer.from(DOWNLOAD_FILE_SCRIPT, 'utf8').toString('base64')
  const loader = `import base64;exec(base64.b64decode('${encodedScript}'))`
  const command = `python3 -c ${quote(loader)}`
  const temporaryPath = join(
    dirname(destination),
    `.${basename(destination)}.${randomUUID()}.panepilot-download`
  )
  const child = spawn(
    'ssh',
    ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshAlias, command],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-64 * 1024)
  })
  child.stdin.on('error', () => {
    // A remote validation or SSH failure can close stdin before the payload
    // finishes. The process exit below reports the useful error.
  })
  child.stdin.end(JSON.stringify({ root, relativePath }))

  try {
    const output = createWriteStream(temporaryPath, { flags: 'wx' })
    const exitCode = new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code ?? 1))
    })
    const [, code] = await Promise.all([
      pipeline(child.stdout, output),
      exitCode
    ])
    if (code !== 0) {
      const detail = stderr.trim().split(/\r?\n/).at(-1)
      throw new Error(
        detail ||
          `Could not download from ${sshAlias}. Make sure SSH key authentication is available.`
      )
    }
    renameSync(temporaryPath, destination)
  } catch (error) {
    child.kill()
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The temporary output may not have been created yet.
    }
    throw error
  }
}

export function readRemoteTextFiles(
  sshAlias: string,
  root: string,
  extension: string,
  maxFiles = 256,
  maxTotalBytes = 8 * 1024 * 1024
): Record<string, string> {
  const encoded = runRemotePython<Record<string, string>>(
    sshAlias,
    READ_TEXT_FILES_SCRIPT,
    { root, extension, maxFiles, maxTotalBytes },
    16 * 1024 * 1024
  )
  return Object.fromEntries(
    Object.entries(encoded).map(([path, content]) => [
      path,
      Buffer.from(content, 'base64').toString('utf8')
    ])
  )
}

export function remoteDirectoryExists(
  sshAlias: string,
  root: string,
  relativePath: string
): boolean {
  return runRemotePython<{ exists: boolean }>(
    sshAlias,
    DIRECTORY_EXISTS_SCRIPT,
    { root, relativePath }
  ).exists
}
