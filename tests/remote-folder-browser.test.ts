import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  listRemoteFoldersAsync,
  verifyRemoteDirectory
} from '../src/main/remote-file-service'
import { testSshConnection } from '../src/main/port-forward-manager'
import { projectTypeServices } from '../src/main/project-type-services'
import { Store } from '../src/main/store'

let fixtureRoot: string | null = null
const originalPath = process.env.PATH

function fixture(sshBody?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'panepilot-folder-browser-'))
  fixtureRoot = root
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const ssh = join(bin, 'ssh')
  // Only fixture commands run locally; this executable never invokes SSH.
  writeFileSync(ssh, `#!/bin/sh
/bin/sleep 0.2
${sshBody ?? `for panepilot_argument in "$@"; do
  panepilot_command="$panepilot_argument"
done
exec /bin/sh -c "$panepilot_command"`}
`)
  chmodSync(ssh, 0o700)
  process.env.PATH = `${bin}:${originalPath ?? ''}`
  return root
}

async function whileMainLoopIsAvailable<T>(operation: () => Promise<T>): Promise<T> {
  let settled = false
  const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(settled), 0))
  const pending = operation().finally(() => { settled = true })
  try {
    // A synchronous child would settle before this timer could run.
    expect(await timer).toBe(false)
  } finally {
    await pending
  }
  return pending
}

afterEach(() => {
  if (originalPath == null) delete process.env.PATH
  else process.env.PATH = originalPath
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = null
})

describe('asynchronous SSH folder browsing and verification', () => {
  it('yields during delayed folder browsing and returns canonical entries', async () => {
    const root = fixture()
    const folder = join(root, 'project')
    mkdirSync(folder)
    mkdirSync(join(folder, 'nested'))
    writeFileSync(join(folder, 'README.md'), '# Fixture')
    const alias = join(root, 'linked-project')
    symlinkSync(folder, alias)

    const listing = await whileMainLoopIsAvailable(() =>
      listRemoteFoldersAsync('fixture-only', alias)
    )
    expect(listing.currentPath).toBe(realpathSync(folder))
    expect(listing.entries.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'nested', kind: 'directory' },
      { name: 'README.md', kind: 'file' }
    ])
    expect(listing.entries[0].path).toBe(realpathSync(join(folder, 'nested')))
  })

  it('yields during directory verification and rejects files or missing paths', async () => {
    const root = fixture()
    const folder = join(root, 'project')
    mkdirSync(folder)
    const alias = join(root, 'linked-project')
    symlinkSync(folder, alias)
    writeFileSync(join(folder, 'main.tex'), 'document')

    expect(await whileMainLoopIsAvailable(() => verifyRemoteDirectory('fixture-only', alias)))
      .toBe(realpathSync(folder))
    await expect(verifyRemoteDirectory('fixture-only', join(root, 'missing')))
      .rejects.toThrow('The remote folder does not exist.')
    await expect(verifyRemoteDirectory('fixture-only', join(folder, 'main.tex')))
      .rejects.toThrow('The remote folder does not exist.')
  })

  it('creates an existing SSH LaTeX project asynchronously and preserves preview guards', async () => {
    const root = fixture()
    const folder = join(root, 'project')
    const appData = join(root, 'app-data')
    mkdirSync(folder)
    mkdirSync(appData)
    writeFileSync(join(folder, 'main.tex'), String.raw`\documentclass{article}`)
    const store = new Store(appData)
    store.syncConnections(['fixture-only'])
    const connection = store.getConnection('ssh:fixture-only')!
    const input = {
      type: 'latex' as const, name: 'Fixture', connectionId: connection.id,
      folder, latex: { mainFile: 'main.tex', contextFolder: 'context' }
    }
    try {
      const project = await whileMainLoopIsAvailable(() =>
        projectTypeServices.get('latex')!.create(store, input, connection)
      )
      expect(project.folder).toBe(realpathSync(folder))
      expect(project.latex?.mainFile).toBe('main.tex')

      writeFileSync(join(root, 'outside.tex'), 'outside')
      symlinkSync(join(root, 'outside.tex'), join(folder, 'escape.tex'))
      await expect(projectTypeServices.get('latex')!.create(store, {
        ...input, latex: { ...input.latex, mainFile: 'escape.tex' }
      }, connection)).rejects.toThrow('was not found')
      expect(store.listProjects()).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('reports malformed, failed, and oversized remote responses', async () => {
    const root = fixture('printf "invalid JSON"')
    await expect(listRemoteFoldersAsync('fixture-only', root)).rejects.toThrow('not valid JSON')
    writeFileSync(join(root, 'bin', 'ssh'), '#!/bin/sh\nprintf "Permission denied\\n" >&2\nexit 255\n')
    await expect(listRemoteFoldersAsync('fixture-only', root)).rejects.toThrow('Permission denied')
    writeFileSync(join(root, 'bin', 'ssh'), '#!/bin/sh\nexec /usr/bin/head -c 4194305 /dev/zero\n')
    await expect(listRemoteFoldersAsync('fixture-only', root)).rejects.toThrow('too large')
  })

  it('connection checks yield during slow SSH and preserve success/error details', async () => {
    const root = fixture()
    expect(await whileMainLoopIsAvailable(() => testSshConnection('fixture-only')))
      .toMatchObject({ ok: true, message: 'Connected to fixture-only.' })

    writeFileSync(join(root, 'bin', 'ssh'), '#!/bin/sh\nprintf "First line\\nPermission denied\\n" >&2\nexit 255\n')
    expect(await testSshConnection('fixture-only'))
      .toMatchObject({ ok: false, message: 'Permission denied' })
  })
})
