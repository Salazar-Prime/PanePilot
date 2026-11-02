import { constants, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import type { Connection, LatexSourceFile, LatexSourceSaveResult } from '../shared/types'
import { normalizeProjectRelativePath } from './latex-paths'
import { runRemotePythonAsync } from './remote-file-service'

const LIMIT = 1024 * 1024
const operations = new Map<string, Promise<unknown>>()

async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = operations.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(operation)
  operations.set(key, next)
  try { return await next } finally { if (operations.get(key) === next) operations.delete(key) }
}

async function localPath(root: string, path: string): Promise<string> {
  const canonicalRoot = await fs.realpath(root)
  const target = await fs.realpath(resolve(canonicalRoot, path))
  if (!target.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep) || target === canonicalRoot) throw Error('The requested path is outside the project folder.')
  return target
}

async function localRead(target: string, path: string, knownRevision?: string): Promise<LatexSourceFile> {
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile() || stat.size > BigInt(LIMIT)) throw Error('LaTeX source must be a regular UTF-8 file no larger than 1 MB.')
    const revision = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
    if (knownRevision === revision) return { path, revision, content: null }
    const bytes = Buffer.alloc(Number(stat.size) + 1)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    const after = await handle.stat({ bigint: true })
    if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs || bytesRead !== Number(stat.size)) {
      throw Error('The LaTeX source changed while it was being read. It will be checked again.')
    }
    if (bytes.subarray(0, bytesRead).includes(0)) throw Error('LaTeX source must be UTF-8 text.')
    return { path, revision, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)) }
  } finally { await handle.close() }
}

const REMOTE_SOURCE = String.raw`
import json, os, stat, sys, tempfile
p = json.load(sys.stdin)
root = os.path.realpath(os.path.expanduser(p['root']))
target = os.path.realpath(os.path.join(root, p['path']))
if os.path.commonpath([root, target]) != root or target == root:
    raise RuntimeError('The requested path is outside the project folder.')
def read(known=None):
    fd = os.open(target, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 1048576:
            raise RuntimeError('LaTeX source must be a regular UTF-8 file no larger than 1 MB.')
        revision = ':'.join(str(v) for v in [before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns])
        if known == revision:
            return dict(path=p['path'], revision=revision, content=None)
        with os.fdopen(os.dup(fd), 'rb') as f:
            data = f.read(1048577)
        after = os.fstat(fd)
        if (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (before.st_size, before.st_mtime_ns, before.st_ctime_ns) or len(data) != before.st_size:
            raise RuntimeError('The LaTeX source changed while it was being read. It will be checked again.')
        if b'\x00' in data:
            raise RuntimeError('LaTeX source must be UTF-8 text.')
        return dict(path=p['path'], revision=revision, content=data.decode('utf-8'))
    finally:
        os.close(fd)
if p['operation'] == 'read':
    result = read(p.get('knownRevision'))
else:
    current = read()
    if current['content'] == p['content']:
        result = dict(saved=True, file=current)
    elif current['content'] != p['expectedContent']:
        result = dict(saved=False, file=current)
    else:
        if not os.access(target, os.W_OK):
            raise RuntimeError('The LaTeX source is not writable.')
        mode = stat.S_IMODE(os.stat(target).st_mode)
        fd, temporary = tempfile.mkstemp(prefix='.panepilot-source-', suffix='.tmp', dir=os.path.dirname(target))
        try:
            with os.fdopen(fd, 'wb') as f:
                os.fchmod(f.fileno(), mode)
                f.write(p['content'].encode('utf-8'))
            latest = read()
            if latest['revision'] != current['revision']:
                result = dict(saved=False, file=latest)
            else:
                os.replace(temporary, target)
                result = dict(saved=True, file=dict(path=p['path'], revision='', content=p['content']))
        finally:
            if os.path.exists(temporary): os.unlink(temporary)
print(json.dumps(result))
`

export async function readLatexSource(root: string, connection: Connection, requested: string, knownRevision?: string): Promise<LatexSourceFile> {
  const path = normalizeProjectRelativePath(requested, 'LaTeX source', { extension: '.tex' })
  if (knownRevision !== undefined && (typeof knownRevision !== 'string' || knownRevision.length > 512)) throw Error('Invalid source revision.')
  if (connection.kind === 'ssh') {
    // Queue the whole canonical remote project so internal symlink aliases of
    // one source cannot bypass the same-process write guard.
    const key = `${connection.sshAlias ?? connection.name}\0${root}`
    return serialize(key, () => runRemotePythonAsync<LatexSourceFile>(connection.sshAlias ?? connection.name,
      REMOTE_SOURCE, { operation: 'read', root, path, knownRevision }, 8 * LIMIT))
  }
  const target = await localPath(root, path)
  return serialize(target, () => localRead(target, path, knownRevision))
}

export async function saveLatexSource(root: string, connection: Connection, requested: string, content: string, expectedContent: string): Promise<LatexSourceSaveResult> {
  const path = normalizeProjectRelativePath(requested, 'LaTeX source', { extension: '.tex' })
  if (typeof content !== 'string' || typeof expectedContent !== 'string' ||
    Buffer.byteLength(content, 'utf8') > LIMIT || Buffer.byteLength(expectedContent, 'utf8') > LIMIT || content.includes('\0')) {
    throw Error('PanePilot only edits UTF-8 source files up to 1 MB.')
  }
  if (connection.kind === 'ssh') {
    const key = `${connection.sshAlias ?? connection.name}\0${root}`
    return serialize(key, () => runRemotePythonAsync<LatexSourceSaveResult>(connection.sshAlias ?? connection.name,
      REMOTE_SOURCE, { operation: 'save', root, path, content, expectedContent }, 8 * LIMIT))
  }
  const target = await localPath(root, path)
  return serialize(target, async () => {
    const current = await localRead(target, path)
    if (current.content === content) return { saved: true, file: current }
    if (current.content !== expectedContent) return { saved: false, file: current }
    await fs.access(target, constants.W_OK)
    const temporary = join(dirname(target), `.panepilot-source-${randomUUID()}.tmp`)
    const mode = (await fs.stat(target)).mode & 0o777
    try {
      await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await fs.chmod(temporary, mode)
      const latest = await localRead(target, path)
      if (latest.revision !== current.revision) return { saved: false, file: latest }
      await fs.rename(temporary, target)
      // Force a fresh metadata/content check after saving: another writer may
      // replace the file again before the next UI poll.
      return { saved: true, file: { path, revision: '', content } }
    } finally { await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error }) }
  })
}
