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
import { localLatexSourceRevision } from '../src/main/latex-project-service'
import {
  loadLatexAutoCompile,
  saveLatexAutoCompile
} from '../src/renderer/src/lib/latexAutoCompile'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('LaTeX auto compile', () => {
  it('is off by default and stores an independent preference per project', () => {
    const storage = new MemoryStorage()
    expect(loadLatexAutoCompile('paper-a', storage)).toBe(false)

    saveLatexAutoCompile('paper-a', true, storage)
    expect(loadLatexAutoCompile('paper-a', storage)).toBe(true)
    expect(loadLatexAutoCompile('paper-b', storage)).toBe(false)

    saveLatexAutoCompile('paper-a', false, storage)
    expect(loadLatexAutoCompile('paper-a', storage)).toBe(false)
  })

  it('changes its revision only for visible LaTeX source files', () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-latex-revision-'))
    temporaryDirectories.push(root)
    writeFileSync(join(root, 'main.tex'), '\\documentclass{article}')
    const initial = localLatexSourceRevision(root)

    writeFileSync(join(root, 'notes.md'), 'not part of the manuscript')
    expect(localLatexSourceRevision(root)).toBe(initial)

    mkdirSync(join(root, 'sections'))
    writeFileSync(join(root, 'sections', 'intro.tex'), 'Introduction')
    expect(localLatexSourceRevision(root)).not.toBe(initial)

    const withSection = localLatexSourceRevision(root)
    mkdirSync(join(root, '.drafts'))
    writeFileSync(join(root, '.drafts', 'hidden.tex'), 'Ignored draft')
    expect(localLatexSourceRevision(root)).toBe(withSection)
  })

  it('reloads the PDF only through initial, manual, or enabled-auto paths', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'src',
        'renderer',
        'src',
        'components',
        'LatexPdfPreview.tsx'
      ),
      'utf8'
    )

    expect(source).toContain('const pdfSnapshotCache = new Map')
    expect(source).toContain('loadLatexAutoCompile(projectId)')
    expect(source).toContain('previous != null && previous !== revision')
    expect(source).toContain('window.projectConsole.latex.compile(projectId)')
    expect(source).not.toContain('Reload from disk')
    expect(source).not.toContain('Reload compiled PDF from disk')
  })
})
