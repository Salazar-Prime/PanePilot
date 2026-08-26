import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createLocalDirectory,
  createLocalFile,
  openLocalPath,
  previewLocalFile,
  renameLocalEntry,
  resolveLocalFilePath,
  searchLocalFiles,
  writeLocalFile
} from '../src/main/file-service'

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

  it('returns a bounded data URL for supported image files', () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-images-'))
    temporaryRoots.push(root)
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
    writeFileSync(join(root, 'pixel.png'), png)

    const preview = previewLocalFile(root, 'pixel.png')

    expect(preview.binary).toBe(true)
    expect(preview.imageMimeType).toBe('image/png')
    expect(preview.imageDataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`)
  })

  it('allows image previews up to 5 MB while keeping text previews at 1 MB', () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-image-limit-'))
    temporaryRoots.push(root)
    const twoMegabytes = Buffer.alloc(2 * 1024 * 1024, 0x61)
    writeFileSync(join(root, 'figure.png'), twoMegabytes)
    writeFileSync(join(root, 'large.txt'), twoMegabytes)
    writeFileSync(
      join(root, 'too-large.png'),
      Buffer.alloc(5 * 1024 * 1024 + 1, 0x62)
    )

    const image = previewLocalFile(root, 'figure.png')
    const text = previewLocalFile(root, 'large.txt')
    const tooLarge = previewLocalFile(root, 'too-large.png')

    expect(image.truncated).toBe(false)
    expect(image.imageDataUrl).toContain('data:image/png;base64,')
    expect(text.truncated).toBe(true)
    expect(Buffer.byteLength(text.content)).toBe(1024 * 1024)
    expect(tooLarge.truncated).toBe(true)
    expect(tooLarge.imageDataUrl).toBeNull()
  })

  it('opens project directories with their file listing', () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-directory-links-'))
    temporaryRoots.push(root)
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'index.ts'), 'export {}')

    const result = openLocalPath(root, 'src')

    expect(result.kind).toBe('directory')
    expect(result.directoryPath).toBe('src')
    expect(result.preview).toBeNull()
    expect(result.entries.map((entry) => entry.path)).toEqual([
      join('src', 'index.ts')
    ])
  })

  it('resolves only existing files for desktop reveal actions', () => {
    const container = mkdtempSync(join(tmpdir(), 'panepilot-reveal-'))
    temporaryRoots.push(container)
    const root = join(container, 'project')
    mkdirSync(root)
    mkdirSync(join(root, 'src'))
    const file = join(root, 'src', 'index.ts')
    writeFileSync(file, 'export {}')
    writeFileSync(join(container, 'outside.txt'), 'private')

    expect(resolveLocalFilePath(root, 'src/index.ts')).toBe(realpathSync(file))
    expect(() => resolveLocalFilePath(root, 'src')).toThrow(
      'requested path is not a file'
    )
    expect(() => resolveLocalFilePath(root, '../outside.txt')).toThrow(
      'outside the project folder'
    )
  })

  it('creates and renames project files and folders without overwriting', () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-file-mutations-'))
    temporaryRoots.push(root)

    expect(createLocalDirectory(root, '.', 'docs')).toBe('docs')
    expect(createLocalFile(root, 'docs', 'draft.md')).toBe(
      join('docs', 'draft.md')
    )
    writeLocalFile(root, 'docs/draft.md', '# Draft\n')
    expect(renameLocalEntry(root, 'docs/draft.md', 'README.md')).toBe(
      join('docs', 'README.md')
    )
    expect(readFileSync(join(root, 'docs', 'README.md'), 'utf8')).toBe(
      '# Draft\n'
    )
    expect(renameLocalEntry(root, 'docs', 'guide')).toBe('guide')
    expect(readFileSync(join(root, 'guide', 'README.md'), 'utf8')).toBe(
      '# Draft\n'
    )
    expect(() => createLocalFile(root, 'guide', 'README.md')).toThrow(
      'already exists'
    )
  })

  it('rejects unsafe mutation names, traversal, and symbolic-link renames', () => {
    const container = mkdtempSync(join(tmpdir(), 'panepilot-file-mutation-bounds-'))
    temporaryRoots.push(container)
    const root = join(container, 'project')
    mkdirSync(root)
    const outside = join(container, 'outside.txt')
    writeFileSync(outside, 'outside')
    symlinkSync(outside, join(root, 'outside-link'))

    expect(() => createLocalFile(root, '.', '../outside.txt')).toThrow(
      'without path separators'
    )
    expect(() => renameLocalEntry(root, '../outside.txt', 'inside.txt')).toThrow(
      'outside the project folder'
    )
    expect(() => renameLocalEntry(root, 'outside-link', 'renamed.txt')).toThrow(
      'Symbolic links'
    )
    expect(readFileSync(outside, 'utf8')).toBe('outside')
  })
})

describe('local file search', () => {
  it('finds matching project paths while ignoring dependency and Git folders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-search-'))
    temporaryRoots.push(root)
    mkdirSync(join(root, 'src', 'components'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'matching-package'), { recursive: true })
    mkdirSync(join(root, '.git'), { recursive: true })
    writeFileSync(join(root, 'src', 'components', 'FilesPanel.tsx'), 'export {}')
    writeFileSync(join(root, 'node_modules', 'matching-package', 'index.js'), '')
    writeFileSync(join(root, '.git', 'matching-config'), '')

    const results = await searchLocalFiles(root, 'filespanel')

    expect(results.map((entry) => entry.path)).toEqual([
      join('src', 'components', 'FilesPanel.tsx')
    ])
  })
})
