import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { previewLocalFile, writeLocalFile } from '../src/main/file-service'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('local file editing', () => {
  it('writes an existing UTF-8 file inside the project folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-files-'))
    temporaryRoots.push(root)
    const file = join(root, 'notes.md')
    writeFileSync(file, 'before')

    writeLocalFile(root, 'notes.md', 'after\n')

    expect(readFileSync(file, 'utf8')).toBe('after\n')
    expect(previewLocalFile(root, 'notes.md').content).toBe('after\n')
  })

  it('does not read or write through project-folder traversal', () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-bounds-'))
    temporaryRoots.push(root)
    const project = join(root, 'project')
    mkdirSync(project)
    writeFileSync(join(root, 'outside.txt'), 'private')

    expect(() => previewLocalFile(project, '../outside.txt')).toThrow(
      'outside the project folder'
    )
    expect(() => writeLocalFile(project, '../outside.txt', 'changed')).toThrow(
      'outside the project folder'
    )
  })
})
