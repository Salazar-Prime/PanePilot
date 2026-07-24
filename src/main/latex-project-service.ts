import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs'
import { posix, relative, resolve, sep } from 'node:path'
import type {
  Connection,
  LatexChangeHighlight,
  LatexChangeSet,
  LatexFileChanges,
  LatexProjectDetails,
  LatexSection,
  LatexWorkspace,
  StartLatexChatInput,
  TerminalSession,
  UpdateLatexProjectInput
} from '../shared/types'
import {
  normalizeOptionalWebUrl,
  normalizeProjectRelativePath
} from './latex-paths'
import {
  previewRemoteFile,
  readRemoteTextFiles,
  remoteDirectoryExists
} from './remote-file-service'
import type { ParsedLatexSection, Store } from './store'
import type { TerminalManager } from './terminal-manager'

const MAX_LATEX_FILES = 256
const MAX_LATEX_BYTES = 8 * 1024 * 1024
const MAX_PROMPT_LENGTH = 50_000
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
    const session = this.terminals.start({
      projectId: input.projectId,
      name: input.name,
      profile: input.provider,
      dangerousMode: input.dangerousMode
    })
    try {
      this.store.attachLatexChat(session.id, {
        projectId: input.projectId,
        scope: input.scope,
        sectionId: input.scope === 'section' ? input.sectionId ?? null : null,
        mode: input.mode
      })
    } catch (error) {
      this.terminals.stop(session.id)
      this.store.deleteSession(session.id)
      throw error
    }
    return this.store.getSession(session.id)!
  }

  setChatMode(sessionId: string, mode: 'ask' | 'edit'): void {
    this.store.setLatexChatMode(sessionId, mode)
  }

  sendPrompt(sessionId: string, rawPrompt: string): void {
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
    this.terminals.sendPrompt(
      sessionId,
      `[PanePilot LaTeX] ${instruction} ${context}\n\nUser request: ${prompt}`
    )
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
