import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readLocalProjectNotes,
  writeLocalProjectNotes
} from '../src/main/file-service'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('project notes', () => {
  it('creates and reads Markdown notes in the project folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-notes-'))
    temporaryRoots.push(root)

    expect(readLocalProjectNotes(root)).toEqual({
      path: '.notes-panepilot',
      content: '',
      exists: false
    })

    const content = '# Project notes\n\n- Follow up with the agent\n'
    expect(writeLocalProjectNotes(root, content)).toEqual({
      path: '.notes-panepilot',
      content,
      exists: true
    })
    expect(readFileSync(join(root, '.notes-panepilot'), 'utf8')).toBe(content)
    expect(readLocalProjectNotes(root).content).toBe(content)
  })

  it('refuses to follow a notes symlink outside the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-notes-bounds-'))
    const outside = mkdtempSync(join(tmpdir(), 'panepilot-notes-outside-'))
    temporaryRoots.push(root, outside)
    const outsideFile = join(outside, 'notes.md')
    symlinkSync(outsideFile, join(root, '.notes-panepilot'))

    expect(() => writeLocalProjectNotes(root, 'private')).toThrow(
      'must be a regular file'
    )
    expect(existsSync(outsideFile)).toBe(false)
  })
})
