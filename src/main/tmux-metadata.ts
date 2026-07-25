import { posix } from 'node:path'
import type {
  LatexChatMode,
  LatexChatScope,
  LaunchProfile,
  Project,
  TerminalSession,
  TerminalSessionKind
} from '../shared/types'

export const PANEPILOT_TMUX_METADATA_VERSION = 1
export const TMUX_FIELD_SEPARATOR = '\\037'
const TMUX_FORMAT_FIELD_SEPARATOR = '\u001f'

const TMUX_METADATA_KEYS = {
  managed: '@panepilot_managed',
  schema: '@panepilot_schema',
  terminalId: '@panepilot_terminal_id',
  projectId: '@panepilot_project_id',
  projectPath: '@panepilot_project_path',
  profile: '@panepilot_profile',
  providerSessionId: '@panepilot_provider_session_id',
  providerSessionName: '@panepilot_provider_session_name',
  createdAt: '@panepilot_created_at',
  dangerousMode: '@panepilot_dangerous_mode',
  sessionKind: '@panepilot_session_kind',
  actionId: '@panepilot_action_id',
  actionName: '@panepilot_action_name',
  actionCommand: '@panepilot_action_command',
  latexScope: '@panepilot_latex_scope',
  latexMode: '@panepilot_latex_mode',
  latexSectionId: '@panepilot_latex_section_id',
  latexSectionSource: '@panepilot_latex_section_source',
  latexSectionTitle: '@panepilot_latex_section_title',
  latexSectionLevel: '@panepilot_latex_section_level'
} as const

export const PANEPILOT_TMUX_OPTION_KEYS = Object.values(TMUX_METADATA_KEYS)

const VALID_PROFILES = new Set<LaunchProfile>(['shell', 'codex', 'claude', 'custom'])
const VALID_SESSION_KINDS = new Set<TerminalSessionKind>([
  'terminal',
  'action',
  'project-qna',
  'latex-chat'
])
const VALID_LATEX_SCOPES = new Set<LatexChatScope>(['project', 'section'])
const VALID_LATEX_MODES = new Set<LatexChatMode>(['ask', 'edit'])
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface PanePilotTmuxLatexMetadata {
  scope: LatexChatScope
  mode: LatexChatMode
  sectionId: string | null
  sectionSource: string | null
  sectionTitle: string | null
  sectionLevel: number | null
}

export interface PanePilotTmuxMetadata {
  terminalId: string
  originProjectId: string
  projectPath: string
  profile: LaunchProfile
  providerSessionId: string | null
  providerSessionName: string | null
  createdAt: string
  dangerousMode: boolean
  sessionKind: TerminalSessionKind | null
  action: {
    id: string
    name: string
    command: string
  } | null
  latex: PanePilotTmuxLatexMetadata | null
}

export interface ListedTmuxSession {
  tmuxId: string
  name: string
  attachedClients: number
  paneTitle: string
  paneCurrentCommand: string
  paneDead: boolean
  metadata: PanePilotTmuxMetadata | null
}

interface SessionMetadataContext {
  project: Project
  session: TerminalSession
  action: {
    id: string
    name: string
    command: string
  } | null
  latexSection: {
    id: string
    sourceFile: string
    title: string
    level: number
  } | null
}

function encodeText(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function decodeText(value: string, maxLength: number): string | null {
  if (!value || value.length > Math.ceil((maxLength * 4) / 3) + 8) return null
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    if (!decoded || decoded.length > maxLength || decoded.includes('\0')) return null
    return decoded
  } catch {
    return null
  }
}

function validUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function validTimestamp(value: string): boolean {
  return value.length <= 40 && Number.isFinite(Date.parse(value))
}

function normalizeProjectPath(value: string): string {
  const normalized = posix.normalize(value.trim())
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function panePilotTmuxMetadata({
  project,
  session,
  action,
  latexSection
}: SessionMetadataContext): PanePilotTmuxMetadata {
  const chat = session.latexChat
  return {
    terminalId: session.id,
    originProjectId: project.id,
    projectPath: normalizeProjectPath(project.folder),
    profile: session.profile,
    providerSessionId: session.providerSessionId,
    providerSessionName: session.providerSessionName,
    createdAt: session.createdAt,
    dangerousMode: session.dangerousMode,
    sessionKind: session.kind,
    action:
      session.kind === 'action' && action
        ? {
            id: action.id,
            name: action.name,
            command: action.command
          }
        : null,
    latex: chat
      ? {
          scope: chat.scope,
          mode: chat.mode,
          sectionId: chat.scope === 'section' ? chat.sectionId : null,
          sectionSource:
            chat.scope === 'section' ? latexSection?.sourceFile ?? null : null,
          sectionTitle: chat.scope === 'section' ? latexSection?.title ?? null : null,
          sectionLevel: chat.scope === 'section' ? latexSection?.level ?? null : null
        }
      : null
  }
}

export function encodePanePilotTmuxMetadata(
  metadata: PanePilotTmuxMetadata
): Record<string, string | null> {
  return {
    [TMUX_METADATA_KEYS.managed]: '1',
    [TMUX_METADATA_KEYS.schema]: String(PANEPILOT_TMUX_METADATA_VERSION),
    [TMUX_METADATA_KEYS.terminalId]: metadata.terminalId,
    [TMUX_METADATA_KEYS.projectId]: metadata.originProjectId,
    [TMUX_METADATA_KEYS.projectPath]: encodeText(metadata.projectPath),
    [TMUX_METADATA_KEYS.profile]: metadata.profile,
    [TMUX_METADATA_KEYS.providerSessionId]: metadata.providerSessionId
      ? encodeText(metadata.providerSessionId)
      : null,
    [TMUX_METADATA_KEYS.providerSessionName]: metadata.providerSessionName
      ? encodeText(metadata.providerSessionName)
      : null,
    [TMUX_METADATA_KEYS.createdAt]: metadata.createdAt,
    [TMUX_METADATA_KEYS.dangerousMode]: metadata.dangerousMode ? '1' : '0',
    [TMUX_METADATA_KEYS.sessionKind]: metadata.sessionKind,
    [TMUX_METADATA_KEYS.actionId]: metadata.action?.id ?? null,
    [TMUX_METADATA_KEYS.actionName]: metadata.action
      ? encodeText(metadata.action.name)
      : null,
    [TMUX_METADATA_KEYS.actionCommand]: metadata.action
      ? encodeText(metadata.action.command)
      : null,
    [TMUX_METADATA_KEYS.latexScope]: metadata.latex?.scope ?? null,
    [TMUX_METADATA_KEYS.latexMode]: metadata.latex?.mode ?? null,
    [TMUX_METADATA_KEYS.latexSectionId]: metadata.latex?.sectionId ?? null,
    [TMUX_METADATA_KEYS.latexSectionSource]: metadata.latex?.sectionSource
      ? encodeText(metadata.latex.sectionSource)
      : null,
    [TMUX_METADATA_KEYS.latexSectionTitle]: metadata.latex?.sectionTitle
      ? encodeText(metadata.latex.sectionTitle)
      : null,
    [TMUX_METADATA_KEYS.latexSectionLevel]:
      metadata.latex?.sectionLevel == null
        ? null
        : String(metadata.latex.sectionLevel)
  }
}

export function tmuxMetadataShellCommand(
  metadata: PanePilotTmuxMetadata,
  targetName?: string,
  unsetMissing = false,
  tmuxCommand = 'tmux'
): string {
  const target = targetName
    ? ` -t ${quote(`=${targetName}:`)}`
    : ' -t "$TMUX_PANE"'
  const executable = quote(tmuxCommand)
  const encoded = encodePanePilotTmuxMetadata(metadata)
  const managedKey = TMUX_METADATA_KEYS.managed
  const optionCommands = Object.entries(encoded)
    .filter(([key]) => key !== managedKey)
    .flatMap(([key, value]) => {
      if (value == null) {
        return unsetMissing
          ? [`${executable} set-option -q -u${target} ${quote(key)}`]
          : []
      }
      return [
        `${executable} set-option -q${target} ${quote(key)} ${quote(value)}`
      ]
    })
  return [
    `${executable} set-option -q${target} ${quote(managedKey)} '0'`,
    ...optionCommands,
    `${executable} set-option -q${target} ${quote(managedKey)} '1'`
  ].join(' && ')
}

export function tmuxSessionListFormat(): string {
  return [
    '#{session_id}',
    '#{session_name}',
    '#{session_attached}',
    '#{pane_title}',
    '#{pane_current_command}',
    '#{pane_dead}',
    ...PANEPILOT_TMUX_OPTION_KEYS.map((key) => `#{${key}}`)
  ].join(TMUX_FORMAT_FIELD_SEPARATOR)
}

function parseMetadata(values: Map<string, string>): PanePilotTmuxMetadata | null {
  if (
    values.get(TMUX_METADATA_KEYS.managed) !== '1' ||
    values.get(TMUX_METADATA_KEYS.schema) !== String(PANEPILOT_TMUX_METADATA_VERSION)
  ) {
    return null
  }
  const terminalId = values.get(TMUX_METADATA_KEYS.terminalId) ?? ''
  const originProjectId = values.get(TMUX_METADATA_KEYS.projectId) ?? ''
  const encodedProjectPath = values.get(TMUX_METADATA_KEYS.projectPath) ?? ''
  const projectPath = decodeText(encodedProjectPath, 4_096)
  const profile = values.get(TMUX_METADATA_KEYS.profile) as LaunchProfile | undefined
  const createdAt = values.get(TMUX_METADATA_KEYS.createdAt) ?? ''
  const sessionKindValue = values.get(TMUX_METADATA_KEYS.sessionKind) ?? ''
  const sessionKind = sessionKindValue
    ? (sessionKindValue as TerminalSessionKind)
    : null
  if (
    !validUuid(terminalId) ||
    !validUuid(originProjectId) ||
    !projectPath ||
    !profile ||
    !VALID_PROFILES.has(profile) ||
    (sessionKind != null && !VALID_SESSION_KINDS.has(sessionKind)) ||
    !validTimestamp(createdAt)
  ) {
    return null
  }

  let action: PanePilotTmuxMetadata['action'] = null
  if (sessionKind === 'action') {
    const actionId = values.get(TMUX_METADATA_KEYS.actionId) ?? ''
    const actionNameValue = values.get(TMUX_METADATA_KEYS.actionName) ?? ''
    const actionCommandValue = values.get(TMUX_METADATA_KEYS.actionCommand) ?? ''
    const actionName = decodeText(actionNameValue, 80)
    const actionCommand = decodeText(actionCommandValue, 4_096)
    if (
      !validUuid(actionId) ||
      !actionName ||
      /[\u0000-\u001f\u007f]/.test(actionName) ||
      !actionCommand
    ) {
      return null
    }
    action = { id: actionId, name: actionName, command: actionCommand }
  }
  if (
    (sessionKind === 'action' && profile !== 'custom') ||
    (sessionKind === 'project-qna' && profile !== 'codex')
  ) {
    return null
  }

  const providerSessionIdValue = values.get(TMUX_METADATA_KEYS.providerSessionId) ?? ''
  const providerSessionNameValue =
    values.get(TMUX_METADATA_KEYS.providerSessionName) ?? ''
  const providerSessionId = providerSessionIdValue
    ? decodeText(providerSessionIdValue, 200)
    : null
  const providerSessionName = providerSessionNameValue
    ? decodeText(providerSessionNameValue, 200)
    : null
  if (
    (providerSessionIdValue && !providerSessionId) ||
    (providerSessionNameValue && !providerSessionName)
  ) {
    return null
  }

  const scopeValue = values.get(TMUX_METADATA_KEYS.latexScope) ?? ''
  const modeValue = values.get(TMUX_METADATA_KEYS.latexMode) ?? ''
  let latex: PanePilotTmuxLatexMetadata | null = null
  if (scopeValue || modeValue) {
    const scope = scopeValue as LatexChatScope
    const mode = modeValue as LatexChatMode
    if (!VALID_LATEX_SCOPES.has(scope) || !VALID_LATEX_MODES.has(mode)) return null
    const sectionIdValue = values.get(TMUX_METADATA_KEYS.latexSectionId) ?? ''
    const sectionSourceValue =
      values.get(TMUX_METADATA_KEYS.latexSectionSource) ?? ''
    const sectionTitleValue = values.get(TMUX_METADATA_KEYS.latexSectionTitle) ?? ''
    const sectionLevelValue = values.get(TMUX_METADATA_KEYS.latexSectionLevel) ?? ''
    const sectionSource = sectionSourceValue
      ? decodeText(sectionSourceValue, 1_024)
      : null
    const sectionTitle = sectionTitleValue
      ? decodeText(sectionTitleValue, 1_024)
      : null
    const sectionLevel =
      sectionLevelValue && /^\d+$/.test(sectionLevelValue)
        ? Number(sectionLevelValue)
        : null
    if (
      scope === 'section' &&
      (!validUuid(sectionIdValue) ||
        !sectionSource ||
        !sectionTitle ||
        sectionLevel == null ||
        sectionLevel < 0 ||
        sectionLevel > 6)
    ) {
      return null
    }
    latex = {
      scope,
      mode,
      sectionId: scope === 'section' ? sectionIdValue : null,
      sectionSource: scope === 'section' ? sectionSource : null,
      sectionTitle: scope === 'section' ? sectionTitle : null,
      sectionLevel: scope === 'section' ? sectionLevel : null
    }
  }
  if (
    sessionKind === 'latex-chat' &&
    (!latex || (profile !== 'codex' && profile !== 'claude'))
  ) {
    return null
  }

  return {
    terminalId,
    originProjectId,
    projectPath: normalizeProjectPath(projectPath),
    profile,
    providerSessionId,
    providerSessionName,
    createdAt: new Date(createdAt).toISOString(),
    dangerousMode: values.get(TMUX_METADATA_KEYS.dangerousMode) === '1',
    sessionKind,
    action,
    latex
  }
}

export function parseTmuxSessionList(output: string): ListedTmuxSession[] {
  const expectedFields = 6 + PANEPILOT_TMUX_OPTION_KEYS.length
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 1_000)
    .flatMap((line): ListedTmuxSession[] => {
      const fields = line.includes(TMUX_FORMAT_FIELD_SEPARATOR)
        ? line.split(TMUX_FORMAT_FIELD_SEPARATOR)
        : line.split(TMUX_FIELD_SEPARATOR)
      if (fields.length !== expectedFields) return []
      const [
        tmuxId,
        name,
        attachedValue,
        paneTitle,
        paneCurrentCommand,
        paneDeadValue,
        ...optionValues
      ] = fields
      if (
        !/^\$\d+$/.test(tmuxId) ||
        !name ||
        name.length > 80 ||
        /[:\u0000-\u001f\u007f]/.test(name) ||
        paneTitle.length > 1_024 ||
        paneCurrentCommand.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(paneTitle) ||
        /[\u0000-\u001f\u007f]/.test(paneCurrentCommand) ||
        (paneDeadValue !== '0' && paneDeadValue !== '1')
      ) {
        return []
      }
      const attachedClients = Number(attachedValue)
      if (!Number.isInteger(attachedClients) || attachedClients < 0) return []
      const values = new Map(
        PANEPILOT_TMUX_OPTION_KEYS.map((key, index) => [
          key,
          optionValues[index] ?? ''
        ])
      )
      return [
        {
          tmuxId,
          name,
          attachedClients,
          paneTitle,
          paneCurrentCommand,
          paneDead: paneDeadValue === '1',
          metadata: parseMetadata(values)
        }
      ]
    })
}

export function sameRemoteProjectPath(left: string, right: string): boolean {
  return normalizeProjectPath(left) === normalizeProjectPath(right)
}
