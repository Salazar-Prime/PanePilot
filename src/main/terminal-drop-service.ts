import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Store } from './store'
import { droppedPathsText, type TerminalDropProgress, type TerminalDropResult } from '../shared/terminalDrops'

export const MAX_DROP_BYTES = 1024 * 1024 * 1024
export const MAX_DROP_FILES = 20

// Directory descriptors keep every mutation inside the canonical project even
// if a metadata directory is replaced by a symlink during the transfer.
export const RECEIVE_DROP_SCRIPT = String.raw`
import json, os, signal, sys, time
def interrupted(signum, frame):
    raise InterruptedError('Upload interrupted')
for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, interrupted)
p = json.loads(sys.stdin.buffer.readline())
root = os.path.realpath(os.path.expanduser(p['root']))
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
fds = [os.open(root, flags)]
batch = p['id']
name = p['name']
if not batch or any(c not in '0123456789abcdef-' for c in batch):
    raise ValueError('Invalid upload identity')
if name in ('', '.', '..') or '/' in name or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
    raise ValueError('Invalid upload filename')
created = False
complete = False
temporary = None
temporary_created = False
directory = p.get('directory')
try:
    if directory is not None:
        parts = [] if directory == '.' else directory.split('/')
        if any(part in ('', '.', '..') or '\\' in part or any(ord(c) < 32 or ord(c) == 127 for c in part) for part in parts):
            raise ValueError('Choose a folder inside the project')
        for part in parts:
            fds.append(os.open(part, flags, dir_fd=fds[-1]))
        final_path = os.path.join(root, *parts, name)
        temporary = '.panepilot-upload-' + batch + '.part'
    else:
        for part in ('.panepilot', 'dropped-assets'):
            try: os.mkdir(part, 0o700, dir_fd=fds[-1])
            except FileExistsError: pass
            fds.append(os.open(part, flags, dir_fd=fds[-1]))
        os.mkdir(batch, 0o700, dir_fd=fds[-1])
        created = True
        fds.append(os.open(batch, flags, dir_fd=fds[-1]))
        final_path = os.path.join(root, '.panepilot', 'dropped-assets', batch, name)
        temporary = '.upload-part'
    count = 0
    last = 0
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fds[-1])
    temporary_created = True
    with os.fdopen(fd, 'wb') as out:
        while True:
            data = sys.stdin.buffer.read(256 * 1024)
            if not data: break
            count += len(data)
            if count > p['size']: raise ValueError('File changed during upload')
            out.write(data)
            if time.monotonic() - last > 0.1:
                print(json.dumps({'bytes': count}), flush=True)
                last = time.monotonic()
        if count != p['size']: raise ValueError('Upload was interrupted or file changed')
        out.flush()
        os.fsync(out.fileno())
    # A hard link publishes the completed file atomically, without replacing
    # any existing file, folder or symlink (even if created mid-upload).
    try:
        os.link(temporary, name, src_dir_fd=fds[-1], dst_dir_fd=fds[-1], follow_symlinks=False)
    except FileExistsError:
        raise ValueError('A file or folder named ' + name + ' already exists. Rename it or choose another folder.') from None
    os.unlink(temporary, dir_fd=fds[-1])
    temporary_created = False
    complete = True
    print(json.dumps({'bytes': count, 'path': final_path}), flush=True)
finally:
    if temporary_created:
        try: os.unlink(temporary, dir_fd=fds[-1])
        except FileNotFoundError: pass
    if created and not complete and len(fds) == 4:
        os.rmdir(batch, dir_fd=fds[-2])
    for fd in reversed(fds): os.close(fd)
`

export async function streamRemoteDrop(
  alias: string, root: string, name: string, size: number, file: FileHandle,
  signal: AbortSignal, progress: (bytes: number) => void, directory?: string
): Promise<string> {
  if (!alias || alias.startsWith('-') || /[\x00-\x20\x7f]/.test(alias)) throw new Error('Invalid SSH alias.')
  const script = Buffer.from(RECEIVE_DROP_SCRIPT).toString('base64')
  const command = `python3 -c "import base64;exec(base64.b64decode('${script}'))"`
  const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', alias, command],
  { stdio: ['pipe', 'pipe', 'pipe'], signal })
  let errorText = ''
  let pending = ''
  let remotePath = ''
  child.stderr.on('data', (chunk) => { errorText = (errorText + chunk.toString()).slice(-4096) })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    pending += chunk
    if (pending.length > 64 * 1024) { child.kill(); return }
    let newline: number
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      try {
        const event = JSON.parse(line)
        if (Number.isSafeInteger(event.bytes) && event.bytes >= 0 && event.bytes <= size) progress(event.bytes)
        if (typeof event.path === 'string') remotePath = event.path
      } catch { /* SSH banners are not upload acknowledgements. */ }
    }
  })
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(errorText.trim() || 'SSH upload failed.')))
  })
  const source = file.createReadStream({ autoClose: false, start: 0 })
  async function* input() {
    yield Buffer.from(JSON.stringify({ root, name, size, id: randomUUID(), directory }) + '\n')
    for await (const chunk of source) yield chunk
  }
  try {
    await Promise.all([pipeline(Readable.from(input()), child.stdin, { signal }), exit])
    if (!remotePath) throw new Error('The remote host did not confirm the upload.')
    droppedPathsText([remotePath])
    return remotePath
  } finally {
    source.destroy()
    if (child.exitCode === null) child.kill()
  }
}

function validateDropDirectory(directory: string): void {
  if (typeof directory !== 'string' || !directory || directory.length > 8192 ||
    /[\\\x00-\x1f\x7f]/.test(directory) ||
    (directory !== '.' && directory.split('/').some((part) => !part || part === '.' || part === '..'))) {
    throw new Error('Choose a folder inside the project.')
  }
}

// Stream rather than buffering file contents in the Electron main process.
export async function copyLocalDrop(
  root: string, directory: string, name: string, size: number, file: FileHandle,
  signal: AbortSignal, progress: (bytes: number) => void
): Promise<string> {
  validateDropDirectory(directory)
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid file name.')
  const canonicalRoot = await realpath(root)
  let parent = canonicalRoot
  for (const part of directory === '.' ? [] : directory.split('/')) {
    parent = join(parent, part)
    const entry = await lstat(parent)
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Choose a project folder, not a symbolic link.')
  }
  const checkParent = async () => {
    if (await realpath(parent) !== parent) throw new Error('The destination folder changed during the copy.')
  }
  await checkParent()
  const target = join(parent, name)
  const temporary = join(parent, `.panepilot-upload-${randomUUID()}.part`)
  const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  let count = 0
  let last = 0
  try {
    const buffer = Buffer.alloc(256 * 1024)
    while (true) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(buffer, 0, buffer.length, count)
      if (!bytesRead) break
      count += bytesRead
      if (count > size) throw new Error('File changed during the copy.')
      for (let offset = 0; offset < bytesRead;) {
        const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset)
        offset += bytesWritten
      }
      if (Date.now() - last >= 100) { progress(count); last = Date.now() }
    }
    if (count !== size) throw new Error('File changed during the copy.')
    await output.sync()
    signal.throwIfAborted()
    await checkParent()
    try {
      await link(temporary, target) // Atomic publication; never overwrites an existing entry.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`A file or folder named ${name} already exists. Rename it or choose another folder.`)
      throw error
    }
    progress(count)
    return target
  } finally {
    await output.close()
    await checkParent()
    await unlink(temporary)
  }
}

export class TerminalDropService {
  private active = new Set<AbortController>()
  private history = new Map<string, TerminalDropProgress>()
  constructor(
    private store: Pick<Store, 'getSession' | 'getProjectForRuntime' | 'getConnection'>,
    private notify: (progress: TerminalDropProgress) => void,
    private upload = streamRemoteDrop
  ) {}

  list(): TerminalDropProgress[] { return [...this.history.values()] }
  shutdown(): void { for (const controller of this.active) controller.abort() }

  async drop(sessionId: string, paths: string[]): Promise<TerminalDropResult> {
    if (typeof sessionId !== 'string') throw new Error('Invalid target terminal.')
    const session = this.store.getSession(sessionId)
    if (!session || session.archived || ['completed', 'error'].includes(session.state)) {
      throw new Error('The target terminal is no longer available.')
    }
    return this.transfer(session.projectId, paths, sessionId)
  }

  async copyToProject(projectId: string, directory: string, paths: string[]): Promise<TerminalDropResult> {
    validateDropDirectory(directory)
    return this.transfer(projectId, paths, null, directory)
  }

  private async transfer(projectId: string, paths: string[], sessionId: string | null, directory?: string): Promise<TerminalDropResult> {
    if (typeof projectId !== 'string' || !Array.isArray(paths) || !paths.length || paths.length > MAX_DROP_FILES ||
      paths.some((path) => typeof path !== 'string' || !isAbsolute(path) || path.length > 8192)) {
      throw new Error(`Drop up to ${MAX_DROP_FILES} files from your computer.`)
    }
    droppedPathsText(paths)
    const project = this.store.getProjectForRuntime(projectId)
    const connection = project && this.store.getConnection(project.connectionId)
    if (!project || project.archived || !connection) throw new Error('The target project is no longer available.')
    if (this.active.size >= 2) throw new Error('Two file drops are already in progress. Try again when one finishes.')
    const controller = new AbortController()
    this.active.add(controller)
    const timer = setTimeout(() => controller.abort(), 15 * 60_000)
    const files: Array<{ path: string; file: FileHandle; size: number }> = []
    let event: TerminalDropProgress | null = null
    const publish = () => {
      if (!event) return
      event.updatedAt = Date.now()
      const snapshot = { ...event, paths: [...event.paths] }
      this.history.set(event.id, snapshot)
      for (const [id, item] of this.history) {
        if (this.history.size <= 10) break
        if (item.state !== 'uploading') this.history.delete(id)
      }
      this.notify(snapshot)
    }
    try {
      let total = 0
      for (const path of paths) {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        files.push({ path, file, size: 0 })
        const stat = await file.stat()
        if (!stat.isFile()) throw new Error('Drop files or images, not folders or special files.')
        total += stat.size
        if (total > MAX_DROP_BYTES) throw new Error('Each drop is limited to 1 GB in total.')
        files[files.length - 1] = { path: await realpath(path), file, size: stat.size }
      }
      if (connection.kind === 'local' && directory === undefined) {
        const localPaths = files.map((item) => item.path)
        droppedPathsText(localPaths)
        return { paths: localPaths }
      }
      event = {
        id: randomUUID(), sessionId, projectId: project.id,
        operation: connection.kind === 'local' ? 'copy' : 'upload',
        target: `${project.name} · ${connection.name}${directory === undefined ? '' : ` · ${directory}`}`,
        fileName: '', completedFiles: 0, totalFiles: files.length, transferredBytes: 0,
        totalBytes: total, state: 'uploading', paths: [], updatedAt: Date.now()
      }
      publish()
      let completedBytes = 0
      for (const item of files) {
        controller.signal.throwIfAborted()
        event.fileName = basename(item.path)
        publish()
        const progress = (bytes: number) => {
          event!.transferredBytes = completedBytes + bytes
          publish()
        }
        const path = connection.kind === 'local'
          ? await copyLocalDrop(project.folder, directory!, basename(item.path), item.size, item.file, controller.signal, progress)
          : await this.upload(connection.sshAlias ?? connection.name, project.folder,
            basename(item.path), item.size, item.file, controller.signal, progress, directory)
        event.paths.push(path)
        event.completedFiles++
        completedBytes += item.size
        event.transferredBytes = completedBytes
        publish()
      }
      event.state = 'completed'
      publish()
      return { transferId: event.id, paths: event.paths }
    } catch (error) {
      if (!event) throw error
      event.state = 'failed'
      event.error = controller.signal.aborted ? `${event.operation === 'copy' ? 'Copy' : 'Upload'} timed out or was cancelled.` : error instanceof Error ? error.message : String(error)
      publish()
      return { transferId: event.id, paths: event.paths, error: event.error }
    } finally {
      clearTimeout(timer)
      this.active.delete(controller)
      await Promise.all(files.map(({ file }) => file.close().catch(() => {})))
    }
  }
}
