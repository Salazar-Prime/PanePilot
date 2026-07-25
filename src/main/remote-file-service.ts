import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, renameSync, unlinkSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type {
  FileEntry,
  FilePreview,
  RemoteFolderListing
} from '../shared/types'

const MAX_FILE_BYTES = 1024 * 1024

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
binary = b"\0" in content
print(json.dumps({
    "path": payload["relativePath"],
    "content": "" if binary else base64.b64encode(content).decode("ascii"),
    "truncated": size > 1024 * 1024,
    "binary": binary,
}))
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
