import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { posix, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type {
  Connection,
  CreateLatexCommentInput,
  LatexChangeHighlight,
  LatexChangeSet,
  LatexComment,
  LatexFileChanges,
  LatexInlineEditHistory,
  LatexPdfDocument,
  LatexProjectDetails,
  LatexSection,
  LatexSourceSelection,
  LatexWorkspace,
  SendLatexInlineEditInput,
  StartLatexChatInput,
  TerminalSession,
  UpdateLatexProjectInput
} from '../shared/types'
import {
  LATEX_INLINE_OUTPUT_END,
  LATEX_INLINE_OUTPUT_START,
  latexSelectionLastLine
} from '../shared/latex-inline-edit'
import {
  normalizeOptionalWebUrl,
  normalizeProjectRelativePath
} from './latex-paths'
import {
  createLocalFile,
  deleteLocalFileIfUnchanged,
  writeLocalFile
} from './file-service'
import {
  createRemoteFile,
  deleteRemoteFileIfUnchanged,
  previewRemoteFile,
  readRemoteBinaryFile,
  readRemoteSourceRevision,
  readRemoteTextFiles,
  remoteDirectoryExists,
  writeRemoteFileAsync
} from './remote-file-service'
import type { ParsedLatexSection, Store } from './store'
import type { TerminalManager } from './terminal-manager'

const MAX_LATEX_FILES = 256
const MAX_LATEX_SCAN_ENTRIES = 20_000
const MAX_LATEX_BYTES = 8 * 1024 * 1024
const MAX_PDF_BYTES = 32 * 1024 * 1024
const MAX_COMPILE_OUTPUT = 2 * 1024 * 1024
const COMPILE_TIMEOUT_MS = 180_000
const MAX_PROMPT_LENGTH = 50_000
const MAX_INLINE_INSTRUCTION_LENGTH = 10_000
const MAX_INLINE_SELECTION_LENGTH = 20_000
const MAX_COMMENT_LENGTH = 10_000
const execFileAsync = promisify(execFile)
const LOCAL_TEX_PATHS = [
  '/Library/TeX/texbin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin'
]
const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6
}

interface LatexCommand {
  kind: 'section' | 'include'
  name: string
  argument: string
  start: number
  end: number
  line: number
}

interface DiffOperation {
  kind: 'equal' | 'add' | 'delete'
  text: string
}

export function extractLatexSelection(
  source: string,
  selection: Pick<
    LatexSourceSelection,
    'startLine' | 'startColumn' | 'endLine' | 'endColumn'
  >
): string {
  const normalized = source.replace(/\r\n?/g, '\n')
  const { start, end } = latexSelectionOffsets(normalized, selection)
  return normalized.slice(start, end)
}

export function latexSelectionOffsets(
  source: string,
  selection: Pick<
    LatexSourceSelection,
    'startLine' | 'startColumn' | 'endLine' | 'endColumn'
  >
): { start: number; end: number } {
  const values = [
    selection.startLine,
    selection.startColumn,
    selection.endLine,
    selection.endColumn
  ]
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('The inline edit selection has invalid source coordinates.')
  }
  if (
    selection.endLine < selection.startLine ||
    (selection.endLine === selection.startLine &&
      selection.endColumn <= selection.startColumn)
  ) {
    throw new Error('Select some source text before asking for an inline edit.')
  }

  const normalized = source.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  function offsetAt(line: number, column: number): number {
    const content = lines[line - 1]
    if (content == null || column > content.length + 1) {
      throw new Error('The inline edit selection no longer matches the saved file.')
    }
    let offset = column - 1
    for (let index = 0; index < line - 1; index += 1) {
      offset += lines[index].length + 1
    }
    return offset
  }

  const start = offsetAt(selection.startLine, selection.startColumn)
  const end = offsetAt(selection.endLine, selection.endColumn)
  if (end <= start) {
    throw new Error('Select some source text before asking for an inline edit.')
  }
  return { start, end }
}

export function codexExecModelOutput(output: string): string {
  const withoutAnsi = output
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[()][A-Z0-9]/g, '')
  const markerPattern = new RegExp(
    `${LATEX_INLINE_OUTPUT_START}([A-Za-z0-9+/=\\s]*)${LATEX_INLINE_OUTPUT_END}`,
    'g'
  )
  let encodedMessage = ''
  for (const match of withoutAnsi.matchAll(markerPattern)) {
    encodedMessage = match[1].replace(/\s/g, '')
  }
  if (encodedMessage) {
    const decoded = Buffer.from(encodedMessage, 'base64').toString('utf8').trim()
    if (decoded) return decoded.slice(0, 50_000)
  }

  const messages: string[] = []
  for (const line of withoutAnsi.replace(/\r/g, '').split('\n')) {
    const candidate = line.trim()
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) continue
    try {
      const event = JSON.parse(candidate) as {
        type?: string
        item?: { type?: string; text?: string; content?: string }
        message?: string
      }
      if (
        event.type === 'item.completed' &&
        event.item?.type === 'agent_message'
      ) {
        const text = event.item.text ?? event.item.content
        if (typeof text === 'string' && text.trim()) messages.push(text.trim())
      }
    } catch {
      // `codex exec --json` may share the PTY with a small amount of startup
      // text. Only complete JSON events are candidates for saved model output.
    }
  }
  return messages.at(-1)?.slice(0, 50_000) ?? ''
}

export interface LatexInlineParagraph {
  startLine: number
  endLine: number
  text: string
}

export interface LatexInlineParagraphContext {
  before: LatexInlineParagraph | null
  selected: LatexInlineParagraph
  after: LatexInlineParagraph | null
}

export function latexInlineParagraphContext(
  source: string,
  selection: Pick<LatexSourceSelection, 'startLine' | 'endLine' | 'endColumn'>
): LatexInlineParagraphContext {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const paragraphs: LatexInlineParagraph[] = []
  let start = -1
  for (let index = 0; index <= lines.length; index += 1) {
    const content = lines[index] ?? ''
    if (index < lines.length && content.trim()) {
      if (start < 0) start = index
      continue
    }
    if (start < 0) continue
    paragraphs.push({
      startLine: start + 1,
      endLine: index,
      text: lines.slice(start, index).join('\n')
    })
    start = -1
  }

  const lastLine = latexSelectionLastLine(selection)
  const firstIndex = paragraphs.findIndex(
    (paragraph) =>
      paragraph.endLine >= selection.startLine &&
      paragraph.startLine <= lastLine
  )
  if (firstIndex < 0) {
    let previousIndex = -1
    for (let index = 0; index < paragraphs.length; index += 1) {
      if (paragraphs[index].endLine < selection.startLine) {
        previousIndex = index
      }
    }
    return {
      before: previousIndex >= 0 ? paragraphs[previousIndex] : null,
      selected: {
        startLine: selection.startLine,
        endLine: lastLine,
        text: lines.slice(selection.startLine - 1, lastLine).join('\n')
      },
      after: paragraphs.find(
        (paragraph) => paragraph.startLine > lastLine
      ) ?? null
    }
  }
  let lastIndex = firstIndex
  while (
    lastIndex + 1 < paragraphs.length &&
    paragraphs[lastIndex + 1].startLine <= lastLine
  ) {
    lastIndex += 1
  }
  const first = paragraphs[firstIndex]
  const last = paragraphs[lastIndex]
  return {
    before: paragraphs[firstIndex - 1] ?? null,
    selected: {
      startLine: first.startLine,
      endLine: last.endLine,
      text: lines.slice(first.startLine - 1, last.endLine).join('\n')
    },
    after: paragraphs[lastIndex + 1] ?? null
  }
}

function stripComments(source: string): string {
  return source
    .split(/\r?\n/)
    .map((line) => {
      for (let index = 0; index < line.length; index += 1) {
        if (line[index] !== '%') continue
        let slashes = 0
        for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor -= 1) {
          slashes += 1
        }
        if (slashes % 2 === 0) return `${line.slice(0, index)}${' '.repeat(line.length - index)}`
      }
      return line
    })
    .join('\n')
}

function bracedArgument(
  source: string,
  from: number
): { value: string; end: number } | null {
  let cursor = from
  while (/\s/.test(source[cursor] ?? '')) cursor += 1
  if (source[cursor] === '*') {
    cursor += 1
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
  }
  if (source[cursor] === '[') {
    let depth = 1
    cursor += 1
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '[') depth += 1
      if (source[cursor] === ']') depth -= 1
      cursor += 1
    }
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
  }
  if (source[cursor] !== '{') return null
  const start = ++cursor
  let depth = 1
  while (cursor < source.length) {
    if (source[cursor] === '{' && source[cursor - 1] !== '\\') depth += 1
    if (source[cursor] === '}' && source[cursor - 1] !== '\\') {
      depth -= 1
      if (depth === 0) {
        return { value: source.slice(start, cursor).trim(), end: cursor + 1 }
      }
    }
    cursor += 1
  }
  return null
}

function scanLatexCommands(source: string): LatexCommand[] {
  const cleaned = stripComments(source)
  const commands: LatexCommand[] = []
  const pattern =
    /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph|input|include)\b/g
  for (const match of cleaned.matchAll(pattern)) {
    if (match.index == null) continue
    const argument = bracedArgument(cleaned, match.index + match[0].length)
    if (!argument?.value) continue
    const name = match[1]
    commands.push({
      kind: name === 'input' || name === 'include' ? 'include' : 'section',
      name,
      argument: argument.value.replace(/\s+/g, ' ').trim(),
      start: match.index,
      end: argument.end,
      line: cleaned.slice(0, match.index).split('\n').length
    })
  }
  return commands
}

function includePath(ownerFile: string, rawTarget: string): string | null {
  const target = rawTarget.trim().replaceAll('\\', '/')
  if (!target || target.includes('\0')) return null
  const withExtension = posix.extname(target) ? target : `${target}.tex`
  const normalized = posix.normalize(posix.join(posix.dirname(ownerFile), withExtension))
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return null
  }
  return normalized.replace(/^\.\//, '')
}

function meaningfulBetween(source: string, start: number, end: number): boolean {
  return stripComments(source.slice(start, end))
    .replace(/\\(?:label|index|hypertarget)\s*\{[^}]*\}/g, '')
    .trim().length > 0
}

export function parseLatexOutline(
  files: Record<string, string>,
  mainFile: string
): ParsedLatexSection[] {
  const sections: ParsedLatexSection[] = []
  const visiting = new Set<string>()

  function visit(file: string): void {
    if (visiting.has(file)) return
    const source = files[file]
    if (source == null) return
    visiting.add(file)
    const commands = scanLatexCommands(source)
    const sectionCommands = commands.filter((command) => command.kind === 'section')
    const lineCount = Math.max(1, source.split(/\r?\n/).length)

    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index]
      if (command.kind === 'section') {
        const nextSection = commands
          .slice(index + 1)
          .find((candidate) => candidate.kind === 'section')
        const section: ParsedLatexSection = {
          title: command.argument,
          level: SECTION_LEVELS[command.name],
          sourceFile: file,
          startLine: command.line,
          endLine: nextSection ? Math.max(command.line, nextSection.line - 1) : lineCount,
          ordinal: sections.length
        }
        sections.push(section)

        const followingInclude = commands
          .slice(index + 1)
          .find(
            (candidate) =>
              candidate.kind === 'include' &&
              (!nextSection || candidate.start < nextSection.start)
          )
        if (followingInclude) {
          const included = includePath(file, followingInclude.argument)
          const includedSource = included ? files[included] : null
          if (
            included &&
            includedSource != null &&
            !scanLatexCommands(includedSource).some((item) => item.kind === 'section') &&
            !meaningfulBetween(source, command.end, followingInclude.start)
          ) {
            section.sourceFile = included
            section.startLine = 1
            section.endLine = Math.max(1, includedSource.split(/\r?\n/).length)
          }
        }
        continue
      }

      const included = includePath(file, command.argument)
      if (!included || files[included] == null) continue
      const previousSection = [...commands.slice(0, index)]
        .reverse()
        .find((candidate) => candidate.kind === 'section')
      const nextSection = commands
        .slice(index + 1)
        .find((candidate) => candidate.kind === 'section')
      const belongsToPrevious =
        previousSection &&
        (!nextSection || previousSection.start < command.start) &&
        !meaningfulBetween(source, previousSection.end, command.start) &&
        !scanLatexCommands(files[included]).some((item) => item.kind === 'section')
      if (!belongsToPrevious) visit(included)
    }

    // A file can be included more than once in TeX, but one stable outline entry per
    // source is considerably more useful for attaching chats.
    visiting.delete(file)
    if (!sectionCommands.length) return
  }

  visit(mainFile)
  return sections.map((section, ordinal) => ({ ...section, ordinal }))
}

function localLatexFiles(root: string): Record<string, string> {
  const realRoot = realpathSync(root)
  const files: Record<string, string> = {}
  let totalBytes = 0

  function visit(directory: string): void {
    if (Object.keys(files).length >= MAX_LATEX_FILES) return
    for (const name of readdirSync(directory).sort()) {
      if (name === '.git' || name === 'node_modules' || name.startsWith('.')) continue
      let target: string
      try {
        target = realpathSync(resolve(directory, name))
      } catch {
        continue
      }
      if (target !== realRoot && !target.startsWith(`${realRoot}${sep}`)) continue
      let stat
      try {
        stat = lstatSync(target)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        visit(target)
        continue
      }
      if (!stat.isFile() || !name.toLocaleLowerCase().endsWith('.tex')) continue
      if (stat.size > 1024 * 1024 || totalBytes + stat.size > MAX_LATEX_BYTES) continue
      const content = readFileSync(target)
      if (content.includes(0)) continue
      const path = relative(realRoot, target).split(sep).join('/')
      files[path] = content.toString('utf8')
      totalBytes += stat.size
      if (Object.keys(files).length >= MAX_LATEX_FILES) return
    }
  }

  visit(realRoot)
  return files
}

export function localLatexSourceRevision(root: string): string {
  const realRoot = realpathSync(root)
  const entries: string[] = []
  const visitedDirectories = new Set<string>()
  let scannedEntries = 0

  function visit(directory: string): void {
    if (
      entries.length >= MAX_LATEX_FILES ||
      scannedEntries >= MAX_LATEX_SCAN_ENTRIES ||
      visitedDirectories.has(directory)
    ) {
      return
    }
    visitedDirectories.add(directory)
    for (const name of readdirSync(directory).sort()) {
      scannedEntries += 1
      if (scannedEntries > MAX_LATEX_SCAN_ENTRIES) return
      if (name === '.git' || name === 'node_modules' || name.startsWith('.')) {
        continue
      }
      let target: string
      try {
        target = realpathSync(resolve(directory, name))
      } catch {
        continue
      }
      if (target !== realRoot && !target.startsWith(`${realRoot}${sep}`)) continue
      let stat
      try {
        stat = lstatSync(target, { bigint: true })
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        visit(target)
        continue
      }
      if (!stat.isFile() || !name.toLocaleLowerCase().endsWith('.tex')) continue
      const path = relative(realRoot, target).split(sep).join('/')
      entries.push(`${path}\0${stat.size}\0${stat.mtimeNs}`)
      if (entries.length >= MAX_LATEX_FILES) return
    }
  }

  visit(realRoot)
  return createHash('sha256').update(entries.sort().join('\0')).digest('hex')
}

function localDirectoryExists(root: string, requested: string): boolean {
  try {
    const realRoot = realpathSync(root)
    const target = realpathSync(resolve(realRoot, requested))
    return (
      (target === realRoot || target.startsWith(`${realRoot}${sep}`)) &&
      statSync(target).isDirectory()
    )
  } catch {
    return false
  }
}

export function latexPdfPath(mainFile: string): string {
  return mainFile.replace(/\.tex$/i, '.pdf')
}

export function latexCompileArguments(mainFile: string): string[] {
  return [
    '-pdf',
    '-interaction=nonstopmode',
    '-file-line-error',
    '-halt-on-error',
    '-cd',
    mainFile
  ]
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function compilePath(): string {
  const entries = [process.env.PATH, ...LOCAL_TEX_PATHS]
    .flatMap((value) => value?.split(':') ?? [])
    .filter(Boolean)
  return [...new Set(entries)].join(':')
}

function compilationError(caught: unknown): Error {
  const failure = caught as {
    code?: string | number
    killed?: boolean
    stdout?: string | Buffer
    stderr?: string | Buffer
    message?: string
  }
  const output = [failure.stdout, failure.stderr]
    .flatMap((value) => value == null ? [] : [String(value).trim()])
    .filter(Boolean)
    .join('\n')
  if (
    failure.code === 'ENOENT' ||
    /(?:command not found|not found).*latexmk|latexmk.*(?:command not found|not found)/i.test(
      output || failure.message || ''
    )
  ) {
    return new Error(
      'PanePilot could not find latexmk on this project machine. Install latexmk with TeX Live or MacTeX, then recompile again.'
    )
  }
  const reason = failure.killed
    ? 'LaTeX compilation exceeded the three-minute limit.'
    : 'LaTeX compilation failed.'
  const tail = output.slice(-6_000)
  return new Error(tail ? `${reason}\n\n${tail}` : reason)
}

function readLocalPdf(root: string, requested: string): LatexPdfDocument {
  let realRoot: string
  let target: string
  try {
    realRoot = realpathSync(root)
    target = realpathSync(resolve(realRoot, requested))
  } catch {
    throw new Error(`Compiled PDF “${requested}” was not found.`)
  }
  if (target !== realRoot && !target.startsWith(`${realRoot}${sep}`)) {
    throw new Error('The requested PDF is outside the project folder.')
  }
  const stat = statSync(target)
  if (!stat.isFile()) throw new Error(`Compiled PDF “${requested}” was not found.`)
  if (stat.size > MAX_PDF_BYTES) {
    throw new Error('PanePilot previews compiled PDFs up to 32 MB.')
  }
  const content = readFileSync(target)
  if (!content.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error(`“${requested}” is not a valid PDF file.`)
  }
  return {
    path: requested,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    dataBase64: content.toString('base64')
  }
}

function lineOperations(before: string[], after: string[]): DiffOperation[] {
  let prefix = 0
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const oldMiddle = before.slice(prefix, before.length - suffix)
  const newMiddle = after.slice(prefix, after.length - suffix)
  const operations: DiffOperation[] = before
    .slice(0, prefix)
    .map((text) => ({ kind: 'equal', text }))

  if (!oldMiddle.length) {
    operations.push(...newMiddle.map((text): DiffOperation => ({ kind: 'add', text })))
  } else if (!newMiddle.length) {
    operations.push(...oldMiddle.map((text): DiffOperation => ({ kind: 'delete', text })))
  } else if (oldMiddle.length * newMiddle.length <= 2_000_000) {
    const width = newMiddle.length + 1
    const matrix = new Uint32Array((oldMiddle.length + 1) * width)
    for (let oldIndex = oldMiddle.length - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = newMiddle.length - 1; newIndex >= 0; newIndex -= 1) {
        const offset = oldIndex * width + newIndex
        matrix[offset] =
          oldMiddle[oldIndex] === newMiddle[newIndex]
            ? matrix[(oldIndex + 1) * width + newIndex + 1] + 1
            : Math.max(
                matrix[(oldIndex + 1) * width + newIndex],
                matrix[oldIndex * width + newIndex + 1]
              )
      }
    }
    let oldIndex = 0
    let newIndex = 0
    while (oldIndex < oldMiddle.length || newIndex < newMiddle.length) {
      if (
        oldIndex < oldMiddle.length &&
        newIndex < newMiddle.length &&
        oldMiddle[oldIndex] === newMiddle[newIndex]
      ) {
        operations.push({ kind: 'equal', text: oldMiddle[oldIndex] })
        oldIndex += 1
        newIndex += 1
      } else if (
        newIndex < newMiddle.length &&
        (oldIndex >= oldMiddle.length ||
          matrix[oldIndex * width + newIndex + 1] >=
            matrix[(oldIndex + 1) * width + newIndex])
      ) {
        operations.push({ kind: 'add', text: newMiddle[newIndex++] })
      } else {
        operations.push({ kind: 'delete', text: oldMiddle[oldIndex++] })
      }
    }
  } else {
    operations.push(...oldMiddle.map((text): DiffOperation => ({ kind: 'delete', text })))
    operations.push(...newMiddle.map((text): DiffOperation => ({ kind: 'add', text })))
  }

  operations.push(
    ...before
      .slice(before.length - suffix)
      .map((text): DiffOperation => ({ kind: 'equal', text }))
  )
  return operations
}

function modifiedColumns(before: string, after: string): [number, number] {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const start = prefix + 1
  const end = Math.max(start + 1, after.length - suffix + 1)
  return [start, end]
}

export function diffLatexFile(
  path: string,
  beforeSource: string,
  afterSource: string
): LatexFileChanges | null {
  if (beforeSource === afterSource) return null
  const before = beforeSource.split(/\r?\n/)
  const after = afterSource.split(/\r?\n/)
  const operations = lineOperations(before, after)
  const highlights: LatexChangeHighlight[] = []
  let currentLine = 1
  let cursor = 0

  while (cursor < operations.length) {
    const operation = operations[cursor]
    if (operation.kind === 'equal') {
      currentLine += 1
      cursor += 1
      continue
    }
    const deletes: string[] = []
    const additions: string[] = []
    while (cursor < operations.length && operations[cursor].kind !== 'equal') {
      const changed = operations[cursor++]
      if (changed.kind === 'delete') deletes.push(changed.text)
      if (changed.kind === 'add') additions.push(changed.text)
    }
    const paired = Math.min(deletes.length, additions.length)
    for (let index = 0; index < paired; index += 1) {
      const [startColumn, endColumn] = modifiedColumns(deletes[index], additions[index])
      highlights.push({
        kind: 'modified',
        startLine: currentLine,
        endLine: currentLine,
        startColumn,
        endColumn,
        originalText: deletes[index],
        currentText: additions[index]
      })
      currentLine += 1
    }
    for (const added of additions.slice(paired)) {
      highlights.push({
        kind: 'added',
        startLine: currentLine,
        endLine: currentLine,
        startColumn: 1,
        endColumn: Math.max(2, added.length + 1),
        originalText: '',
        currentText: added
      })
      currentLine += 1
    }
    if (deletes.length > paired) {
      highlights.push({
        kind: 'deleted',
        startLine: Math.max(1, Math.min(Math.max(1, after.length), currentLine)),
        endLine: Math.max(1, Math.min(Math.max(1, after.length), currentLine)),
        startColumn: 1,
        endColumn: 1,
        originalText: deletes.slice(paired).join('\n'),
        currentText: ''
      })
    }
  }

  return {
    path,
    additions: highlights.filter((change) => change.kind === 'added').length,
    modifications: highlights.filter((change) => change.kind === 'modified').length,
    deletions: highlights
      .filter((change) => change.kind === 'deleted')
      .reduce((total, change) => total + Math.max(1, change.originalText.split('\n').length), 0),
    highlights
  }
}

export class LatexProjectService {
  constructor(
    private readonly store: Store,
    private readonly terminals: TerminalManager
  ) {}

  getWorkspace(projectId: string): LatexWorkspace {
    const { project, connection, details } = this.requireProject(projectId)
    const files = this.readFiles(project.folder, connection)
    if (files[details.mainFile] == null) {
      throw new Error(`Main LaTeX file “${details.mainFile}” was not found.`)
    }
    const parsed = parseLatexOutline(files, details.mainFile)
    const sections = this.store.syncLatexSections(projectId, parsed)
    return {
      details,
      sections,
      contextAvailable:
        connection.kind === 'local'
          ? localDirectoryExists(project.folder, details.contextFolder)
          : remoteDirectoryExists(
              connection.sshAlias ?? connection.name,
              project.folder,
              details.contextFolder
            )
    }
  }

  async sourceRevision(projectId: string): Promise<string> {
    const { project, connection } = this.requireProject(projectId)
    if (connection.kind === 'local') {
      return localLatexSourceRevision(project.folder)
    }
    return readRemoteSourceRevision(
      connection.sshAlias ?? connection.name,
      project.folder,
      '.tex',
      MAX_LATEX_FILES,
      MAX_LATEX_SCAN_ENTRIES
    )
  }

  async getPdf(projectId: string): Promise<LatexPdfDocument> {
    const { project, connection, details } = this.requireProject(projectId)
    const path = latexPdfPath(details.mainFile)
    if (connection.kind === 'local') return readLocalPdf(project.folder, path)

    const remote = await readRemoteBinaryFile(
      connection.sshAlias ?? connection.name,
      project.folder,
      path,
      MAX_PDF_BYTES
    )
    const signature = Buffer.from(remote.dataBase64.slice(0, 8), 'base64')
    if (!signature.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error(`“${path}” is not a valid PDF file.`)
    }
    return { path, ...remote }
  }

  async compile(projectId: string): Promise<LatexPdfDocument> {
    // Reuse the workspace read to verify the configured source still exists
    // inside the canonical local/remote project before starting a compiler.
    this.getWorkspace(projectId)
    const { project, connection, details } = this.requireProject(projectId)
    const mainFile = normalizeProjectRelativePath(
      details.mainFile,
      'Main LaTeX file',
      { extension: '.tex' }
    )
    try {
      if (connection.kind === 'local') {
        const source = resolve(project.folder, mainFile)
        await execFileAsync('latexmk', latexCompileArguments(source), {
          cwd: project.folder,
          encoding: 'utf8',
          env: { ...process.env, PATH: compilePath() },
          timeout: COMPILE_TIMEOUT_MS,
          maxBuffer: MAX_COMPILE_OUTPUT
        })
      } else {
        const source = posix.join(project.folder, mainFile)
        const compileCommand = [
          'latexmk',
          ...latexCompileArguments(source).map(quoteShell)
        ].join(' ')
        const remoteCommand =
          `cd ${quoteShell(project.folder)} && ` +
          `exec "\${SHELL:-/bin/sh}" -lic ${quoteShell(compileCommand)}`
        await execFileAsync(
          'ssh',
          [
            '-T',
            '-o',
            'BatchMode=yes',
            '-o',
            'ConnectTimeout=8',
            connection.sshAlias ?? connection.name,
            remoteCommand
          ],
          {
            encoding: 'utf8',
            timeout: COMPILE_TIMEOUT_MS,
            maxBuffer: MAX_COMPILE_OUTPUT
          }
        )
      }
    } catch (caught) {
      throw compilationError(caught)
    }
    return this.getPdf(projectId)
  }

  update(input: UpdateLatexProjectInput): LatexWorkspace {
    const { project, connection } = this.requireProject(input.projectId)
    const mainFile = normalizeProjectRelativePath(input.mainFile, 'Main LaTeX file', {
      extension: '.tex'
    })
    const contextFolder = normalizeProjectRelativePath(
      input.contextFolder || 'context',
      'Context folder'
    )
    const overleafUrl = normalizeOptionalWebUrl(input.overleafUrl, 'Overleaf URL')
    if (connection.kind === 'local') {
      const files = localLatexFiles(project.folder)
      if (files[mainFile] == null) throw new Error(`Main LaTeX file “${mainFile}” was not found.`)
    } else {
      const preview = previewRemoteFile(
        connection.sshAlias ?? connection.name,
        project.folder,
        mainFile
      )
      if (preview.binary || preview.truncated) {
        throw new Error('The main LaTeX file must be UTF-8 text no larger than 1 MB.')
      }
    }
    this.store.updateLatexProject(input.projectId, {
      mainFile,
      overleafUrl,
      contextFolder
    })
    return this.getWorkspace(input.projectId)
  }

  startChat(input: StartLatexChatInput): TerminalSession {
    const workspace = this.getWorkspace(input.projectId)
    if (!['codex', 'claude'].includes(input.provider)) {
      throw new Error('Choose Codex or Claude for a LaTeX chat.')
    }
    if (input.scope === 'section') {
      const section = input.sectionId
        ? workspace.sections.find((candidate) => candidate.id === input.sectionId)
        : null
      if (!section) throw new Error('Choose a section for this chat.')
    }
    return this.terminals.startLatexChat(
      {
        projectId: input.projectId,
        name: input.name,
        profile: input.provider,
        dangerousMode: input.dangerousMode
      },
      {
        scope: input.scope,
        sectionId: input.scope === 'section' ? input.sectionId ?? null : null,
        mode: input.mode
      }
    )
  }

  setChatMode(sessionId: string, mode: 'ask' | 'edit'): void {
    this.store.setLatexChatMode(sessionId, mode)
    void this.terminals.syncSessionMetadata(sessionId)
  }

  private preparedPrompt(sessionId: string, rawPrompt: string): string {
    const session = this.store.getSession(sessionId)
    const chat = this.store.getLatexChat(sessionId)
    if (!session || !chat) throw new Error('LaTeX chat not found.')
    const { project, connection, details } = this.requireProject(chat.projectId)
    const prompt = rawPrompt.trim()
    if (!prompt) throw new Error('Enter a message for the agent.')
    if (prompt.length > MAX_PROMPT_LENGTH || /[\u0000\u0003\u0004]/.test(prompt)) {
      throw new Error('The message is too large or contains unsupported control characters.')
    }
    let section: LatexSection | null = null
    if (chat.scope === 'section') {
      this.getWorkspace(chat.projectId)
      section = chat.sectionId ? this.store.getLatexSection(chat.sectionId) : null
      if (!section) throw new Error('The section attached to this chat no longer exists.')
    }
    if (chat.mode === 'edit' && this.store.getLatexSnapshots(sessionId).length === 0) {
      this.store.replaceLatexSnapshots(
        sessionId,
        this.readFiles(project.folder, connection)
      )
    }
    const scope =
      section == null
        ? `the whole LaTeX project (main file: ${details.mainFile})`
        : `the section “${section.title}” in ${section.sourceFile}, lines ${section.startLine}-${section.endLine}`
    const context =
      `The optional research context is in ${details.contextFolder}/. ` +
      'You may read other LaTeX sections when cross-document context is useful.'
    const instruction =
      chat.mode === 'ask'
        ? `ASK mode: answer the request without modifying any files. Your scope is ${scope}.`
        : `EDIT mode: make the requested source changes. Your scope is ${scope}. ` +
          (section
            ? `Do not edit outside ${section.sourceFile} lines ${section.startLine}-${section.endLine} unless the user explicitly asks to widen the scope.`
            : 'You may edit files inside this project as needed.')
    return `[PanePilot LaTeX] ${instruction} ${context}\n\nUser request: ${prompt}`
  }

  sendPrompt(sessionId: string, rawPrompt: string): void {
    this.terminals.sendPrompt(
      sessionId,
      this.preparedPrompt(sessionId, rawPrompt)
    )
  }

  async sendInlineEdit(
    input: SendLatexInlineEditInput
  ): Promise<LatexInlineEditHistory> {
    if (!input?.selection) throw new Error('Select some LaTeX source to edit.')
    const instruction = input.instruction.trim()
    if (!instruction) throw new Error('Describe the change you want to make.')
    if (
      instruction.length > MAX_INLINE_INSTRUCTION_LENGTH ||
      /[\u0000\u0003\u0004]/.test(instruction)
    ) {
      throw new Error('The inline edit instruction is too large or contains unsupported control characters.')
    }

    const path = normalizeProjectRelativePath(
      input.selection.path,
      'Selected LaTeX file',
      { extension: '.tex' }
    )
    const selection: LatexSourceSelection = { ...input.selection, path }
    if (
      !selection.text ||
      selection.text.length > MAX_INLINE_SELECTION_LENGTH ||
      /[\u0000\u0003\u0004]/.test(selection.text)
    ) {
      throw new Error('Select between 1 and 20,000 characters for an inline edit.')
    }

    const { project, connection } = this.requireProject(input.projectId)
    const files = this.readFiles(project.folder, connection)
    const source = files[path]
    if (source == null) throw new Error(`LaTeX source file “${path}” was not found.`)
    const savedSelection = extractLatexSelection(source, selection)
    if (savedSelection !== selection.text.replace(/\r\n?/g, '\n')) {
      throw new Error(
        'The selected source changed before the inline edit was sent. Select it again and retry.'
      )
    }
    const paragraphs = latexInlineParagraphContext(source, selection)
    const request = JSON.stringify({
      file: path,
      range: {
        startLine: selection.startLine,
        startColumn: selection.startColumn,
        endLine: selection.endLine,
        endColumn: selection.endColumn,
        lastSelectedLine: latexSelectionLastLine(selection)
      },
      selectedSource: savedSelection,
      paragraphBefore: paragraphs.before,
      selectedParagraph: paragraphs.selected,
      paragraphAfter: paragraphs.after,
      instruction
    })
    if (request.length > MAX_PROMPT_LENGTH - 1_200) {
      throw new Error(
        'The selected paragraph context is too large for one inline edit. Split the passage into smaller paragraphs and retry.'
      )
    }

    const session = await this.terminals.startLatexInlineChat(input.projectId)
    const chat = this.store.getLatexChat(session.id)
    if (!chat || chat.purpose !== 'inline-edit') {
      throw new Error('Persistent inline Codex chat not found.')
    }
    const prompt = this.preparedPrompt(
      session.id,
      'Inline edit request. Modify the saved file at the exact selected range described below. ' +
        'The selected paragraph and one neighboring paragraph on each side are context only. ' +
        'Change only the exact selection unless the instruction explicitly requires adjacent source. ' +
        'Preserve valid LaTeX and surrounding formatting. Apply the edit in the file; do not only explain it. ' +
        `Request JSON: ${request}`
    )
    const offsets = latexSelectionOffsets(source, selection)
    const history = this.store.createLatexInlineEdit({
      projectId: project.id,
      terminalSessionId: session.id,
      path,
      instruction,
      originalText: savedSelection,
      startLine: selection.startLine,
      startColumn: selection.startColumn,
      endLine: selection.endLine,
      endColumn: selection.endColumn,
      prefixContext: source.slice(Math.max(0, offsets.start - 240), offsets.start),
      suffixContext: source.slice(offsets.end, offsets.end + 240)
    })

    let modelOutput = ''
    try {
      const result = await this.terminals.runLatexInlineEditExec(
        session.id,
        prompt
      )
      modelOutput = codexExecModelOutput(result.output)
      if (result.exitCode !== 0) {
        throw new Error(`Codex exited with code ${result.exitCode}.`)
      }

      const updatedFiles = this.readFiles(project.folder, connection)
      const unexpectedPaths = [...new Set([
        ...Object.keys(files),
        ...Object.keys(updatedFiles)
      ])].filter(
        (candidate) =>
          candidate !== path && files[candidate] !== updatedFiles[candidate]
      )
      const updatedSource = updatedFiles[path]
      const prefix = source.slice(0, offsets.start)
      const suffix = source.slice(offsets.end)
      if (
        unexpectedPaths.length > 0 ||
        updatedSource == null ||
        !updatedSource.startsWith(prefix) ||
        !updatedSource.endsWith(suffix)
      ) {
        await this.restoreLatexSources(project.folder, connection, files, updatedFiles)
        throw new Error(
          'Codex changed source outside the selected range, so PanePilot restored the original LaTeX files.'
        )
      }
      const replacementEnd = updatedSource.length - suffix.length
      const replacement = updatedSource.slice(offsets.start, replacementEnd)
      if (replacement === savedSelection) {
        throw new Error('Codex finished without changing the selected text.')
      }
      return this.store.completeLatexInlineEdit(
        history.id,
        replacement,
        modelOutput || 'Codex applied the requested inline edit.'
      )
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught))
      this.store.failLatexInlineEdit(history.id, error.message, modelOutput || null)
      throw error
    }
  }

  listInlineEdits(projectId: string): LatexInlineEditHistory[] {
    this.requireProject(projectId)
    return this.store.listLatexInlineEdits(projectId)
  }

  async rollbackInlineEdit(editId: string): Promise<LatexInlineEditHistory> {
    const edit = this.store.getLatexInlineEdit(editId)
    if (!edit) throw new Error('Inline edit history entry not found.')
    if (edit.status !== 'applied' || edit.replacementText == null) {
      throw new Error('Only an applied inline edit can be rolled back.')
    }
    const { project, connection } = this.requireProject(edit.projectId)
    const files = this.readFiles(project.folder, connection)
    const source = files[edit.path]
    if (source == null) throw new Error(`LaTeX source file “${edit.path}” was not found.`)
    const offset = this.locateInlineReplacement(source, edit)
    if (offset < 0) {
      throw new Error(
        'The replacement text has changed since this edit. PanePilot left the file untouched.'
      )
    }
    const restored =
      source.slice(0, offset) +
      edit.originalText +
      source.slice(offset + edit.replacementText.length)
    await this.writeSource(project.folder, connection, edit.path, restored)
    return this.store.markLatexInlineEditRolledBack(edit.id)
  }

  deleteInlineEdit(editId: string): void {
    this.store.deleteLatexInlineEdit(editId)
  }

  listComments(projectId: string): LatexComment[] {
    this.requireProject(projectId)
    return this.store.listLatexComments(projectId)
  }

  createComment(input: CreateLatexCommentInput): LatexComment {
    if (!input?.selection) throw new Error('Select some LaTeX source to comment on.')
    const body = input.body.trim()
    if (!body) throw new Error('Write a comment for the selected source.')
    if (body.length > MAX_COMMENT_LENGTH || /[\u0000\u0003\u0004]/.test(body)) {
      throw new Error('Comments must be 10,000 characters or fewer and cannot contain control characters.')
    }

    const path = normalizeProjectRelativePath(
      input.selection.path,
      'Selected LaTeX file',
      { extension: '.tex' }
    )
    const selection: LatexSourceSelection = { ...input.selection, path }
    if (
      !selection.text ||
      selection.text.length > MAX_INLINE_SELECTION_LENGTH ||
      /[\u0000\u0003\u0004]/.test(selection.text)
    ) {
      throw new Error('Select between 1 and 20,000 characters for a comment.')
    }

    const { project, connection } = this.requireProject(input.projectId)
    const source = this.readFiles(project.folder, connection)[path]
    if (source == null) throw new Error(`LaTeX source file “${path}” was not found.`)
    const selectedText = extractLatexSelection(source, selection)
    if (selectedText !== selection.text.replace(/\r\n?/g, '\n')) {
      throw new Error(
        'The selected source changed before the comment was added. Select it again and retry.'
      )
    }
    const offsets = latexSelectionOffsets(source, selection)
    return this.store.createLatexComment({
      projectId: project.id,
      path,
      body,
      selectedText,
      startLine: selection.startLine,
      startColumn: selection.startColumn,
      endLine: selection.endLine,
      endColumn: selection.endColumn,
      prefixContext: source.slice(Math.max(0, offsets.start - 240), offsets.start),
      suffixContext: source.slice(offsets.end, offsets.end + 240)
    })
  }

  deleteComment(commentId: string): void {
    const comment = this.store.getLatexComment(commentId)
    if (!comment) return
    this.requireProject(comment.projectId)
    this.store.deleteLatexComment(comment.id)
  }

  changes(sessionId: string): LatexChangeSet {
    const chat = this.store.getLatexChat(sessionId)
    if (!chat) throw new Error('LaTeX chat not found.')
    const snapshots = this.store.getLatexSnapshots(sessionId)
    if (!snapshots.length) return { sessionId, capturedAt: null, files: [] }
    const { project, connection } = this.requireProject(chat.projectId)
    const current = this.readFiles(project.folder, connection)
    const before = Object.fromEntries(
      snapshots.map((snapshot) => [snapshot.relativePath, snapshot.content])
    )
    const paths = [...new Set([...Object.keys(before), ...Object.keys(current)])].sort()
    const files = paths.flatMap((path): LatexFileChanges[] => {
      const changes = diffLatexFile(path, before[path] ?? '', current[path] ?? '')
      return changes ? [changes] : []
    })
    return {
      sessionId,
      capturedAt: snapshots[0]?.createdAt ?? null,
      files
    }
  }

  clearChanges(sessionId: string): void {
    if (!this.store.getLatexChat(sessionId)) throw new Error('LaTeX chat not found.')
    this.store.clearLatexSnapshots(sessionId)
  }

  private locateInlineReplacement(
    source: string,
    edit: LatexInlineEditHistory
  ): number {
    const replacement = edit.replacementText ?? ''
    if (replacement) {
      try {
        const expected = latexSelectionOffsets(source, {
          startLine: edit.startLine,
          startColumn: edit.startColumn,
          endLine: edit.startLine,
          endColumn: edit.startColumn + replacement.length
        }).start
        if (source.slice(expected, expected + replacement.length) === replacement) {
          return expected
        }
      } catch {
        // Later edits can move the original line. The anchored and unique-match
        // fallbacks below safely recover that case.
      }
    }

    const anchored = `${edit.prefixContext}${replacement}${edit.suffixContext}`
    if (anchored) {
      const anchorIndex = source.indexOf(anchored)
      if (anchorIndex >= 0 && source.indexOf(anchored, anchorIndex + 1) < 0) {
        return anchorIndex + edit.prefixContext.length
      }
    }
    if (!replacement) return -1
    const first = source.indexOf(replacement)
    return first >= 0 && source.indexOf(replacement, first + 1) < 0
      ? first
      : -1
  }

  private async restoreLatexSources(
    folder: string,
    connection: Connection,
    before: Record<string, string>,
    after: Record<string, string>
  ): Promise<void> {
    for (const [path, content] of Object.entries(after)) {
      if (before[path] != null) continue
      if (connection.kind === 'local') {
        deleteLocalFileIfUnchanged(folder, path, content)
      } else {
        await deleteRemoteFileIfUnchanged(
          connection.sshAlias ?? connection.name,
          folder,
          path,
          content
        )
      }
    }
    for (const [path, content] of Object.entries(before)) {
      if (after[path] === content) continue
      if (after[path] == null) {
        const parent = posix.dirname(path)
        const name = posix.basename(path)
        if (connection.kind === 'local') {
          createLocalFile(folder, parent, name)
        } else {
          await createRemoteFile(
            connection.sshAlias ?? connection.name,
            folder,
            parent,
            name
          )
        }
      }
      await this.writeSource(folder, connection, path, content)
    }
  }

  private async writeSource(
    folder: string,
    connection: Connection,
    path: string,
    content: string
  ): Promise<void> {
    if (connection.kind === 'local') {
      writeLocalFile(folder, path, content)
      return
    }
    await writeRemoteFileAsync(
      connection.sshAlias ?? connection.name,
      folder,
      path,
      content
    )
  }

  private readFiles(folder: string, connection: Connection): Record<string, string> {
    return connection.kind === 'local'
      ? localLatexFiles(folder)
      : readRemoteTextFiles(
          connection.sshAlias ?? connection.name,
          folder,
          '.tex',
          MAX_LATEX_FILES,
          MAX_LATEX_BYTES
        )
  }

  private requireProject(projectId: string): {
    project: ReturnType<Store['getProject']> & {}
    connection: Connection
    details: LatexProjectDetails
  } {
    const project = this.store.getProject(projectId)
    if (!project || project.type !== 'latex' || !project.latex) {
      throw new Error('LaTeX project not found.')
    }
    const connection = this.store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return { project, connection, details: project.latex }
  }
}
