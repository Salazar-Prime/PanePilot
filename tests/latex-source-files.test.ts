import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Connection } from '../src/shared/types'
import { readLatexSource, saveLatexSource } from '../src/main/latex-source-files'

const directories: string[] = []
const originalPath = process.env.PATH
afterEach(() => {
  process.env.PATH = originalPath
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture(remote: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'panepilot-latex-source-'))
  directories.push(directory)
  const root = join(directory, 'project'); mkdirSync(root)
  writeFileSync(join(root, 'main.tex'), 'Original source.\n')
  const connection: Connection = { id: 'local', name: 'Fixture', kind: 'local', sshAlias: null }
  if (remote) {
    const bin = join(directory, 'bin'); mkdirSync(bin)
    const ssh = join(bin, 'ssh')
    // Execute only the fixture's bounded Python script locally. Never SSH.
    writeFileSync(ssh, '#!/bin/sh\n/bin/sleep 0.03\nfor panepilot_argument in "$@"; do panepilot_command="$panepilot_argument"; done\nexec /bin/sh -c "$panepilot_command"\n')
    chmodSync(ssh, 0o700)
    process.env.PATH = `${bin}:${originalPath}`
    connection.kind = 'ssh'; connection.sshAlias = 'fixture-only'
  }
  return { root, directory, connection }
}

for (const remote of [false, true]) describe(`LaTeX single-source sync (${remote ? 'SSH fixture' : 'local'})`, () => {
  it('returns content initially and metadata only when unchanged, then detects atomic replacement', async () => {
    const { root, connection } = fixture(remote)
    const first = await readLatexSource(root, connection, 'main.tex')
    expect(first.content).toBe('Original source.\n')
    expect((await readLatexSource(root, connection, 'main.tex', first.revision)).content).toBeNull()
    writeFileSync(join(root, 'main.tex'), 'Changed by a backend agent.\n')
    const next = await readLatexSource(root, connection, 'main.tex', first.revision)
    expect(next.content).toBe('Changed by a backend agent.\n'); expect(next.revision).not.toBe(first.revision)
  })
  it('saves the exact expected baseline and leaves no temporary files', async () => {
    const { root, connection } = fixture(remote)
    chmodSync(join(root, 'main.tex'), 0o660)
    const result = await saveLatexSource(root, connection, 'main.tex', 'New source.\n', 'Original source.\n')
    expect(result.saved).toBe(true)
    expect(readFileSync(join(root, 'main.tex'), 'utf8')).toBe('New source.\n')
    expect(readdirSync(root)).toEqual(['main.tex'])
    expect(statSync(join(root, 'main.tex')).mode & 0o777).toBe(0o660)
    expect((await saveLatexSource(root, connection, 'main.tex', 'New source.\n', 'old baseline')).saved).toBe(true)
  })
  it('rejects stale autosaves without changing either version', async () => {
    const { root, connection } = fixture(remote)
    writeFileSync(join(root, 'main.tex'), 'External version.\n')
    const result = await saveLatexSource(root, connection, 'main.tex', 'My draft.\n', 'Original source.\n')
    expect(result.saved).toBe(false); expect(result.file.content).toBe('External version.\n')
    expect(readFileSync(join(root, 'main.tex'), 'utf8')).toBe('External version.\n')
    // Explicit conflict resolution still checks that the disk did not change again.
    expect((await saveLatexSource(root, connection, 'main.tex', 'My draft.\n', result.file.content!)).saved).toBe(true)
  })
  it('serializes same-file PanePilot writes so a second stale draft cannot overwrite the first', async () => {
    const { root, connection } = fixture(remote)
    const results = await Promise.all([
      saveLatexSource(root, connection, 'main.tex', 'First writer.\n', 'Original source.\n'),
      saveLatexSource(root, connection, 'main.tex', 'Second writer.\n', 'Original source.\n')
    ])
    // Canonical path resolution is asynchronous; either call may acquire the
    // queue first, but exactly one stale-baseline write may succeed.
    expect(results.filter((result) => result.saved)).toHaveLength(1)
    expect(readFileSync(join(root, 'main.tex'), 'utf8')).toBe(results[0].saved ? 'First writer.\n' : 'Second writer.\n')
  })
  it('enforces project boundaries, symlinks, source type, UTF-8, and byte limits', async () => {
    const { root, directory, connection } = fixture(remote)
    writeFileSync(join(directory, 'outside.tex'), 'outside')
    symlinkSync(join(directory, 'outside.tex'), join(root, 'escape.tex'))
    await expect(readLatexSource(root, connection, '../outside.tex')).rejects.toThrow('inside')
    await expect(readLatexSource(root, connection, 'escape.tex')).rejects.toThrow('outside')
    await expect(readLatexSource(root, connection, 'other.txt')).rejects.toThrow('.tex')
    writeFileSync(join(root, 'binary.tex'), Buffer.from([0x61, 0, 0x62]))
    await expect(readLatexSource(root, connection, 'binary.tex')).rejects.toThrow('UTF-8')
    writeFileSync(join(root, 'binary.tex'), Buffer.from([0xc3, 0x28]))
    await expect(readLatexSource(root, connection, 'binary.tex')).rejects.toThrow()
    writeFileSync(join(root, 'large.tex'), 'x'.repeat(1024 * 1024 + 1))
    await expect(readLatexSource(root, connection, 'large.tex')).rejects.toThrow('1 MB')
    await expect(saveLatexSource(root, connection, 'main.tex', 'x'.repeat(1024 * 1024 + 1), '')).rejects.toThrow('1 MB')
  })
  it('yields the event loop for reads and guarded saves', async () => {
    const { root, connection } = fixture(remote)
    let settled = false
    const work = readLatexSource(root, connection, 'main.tex').then(() => { settled = true })
    // Local IO may finish before a 0 ms timer on a fast filesystem. Both paths
    // must yield; the delayed SSH fixture additionally proves timer progress.
    if (remote) await new Promise((done) => setTimeout(done, 0))
    else await Promise.resolve()
    expect(settled).toBe(false); await work
    settled = false
    const saving = saveLatexSource(root, connection, 'main.tex', 'Saved', 'Original source.\n').then(() => { settled = true })
    if (remote) await new Promise((done) => setTimeout(done, 0))
    else await Promise.resolve()
    expect(settled).toBe(false); await saving
  })
})
