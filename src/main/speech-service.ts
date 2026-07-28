import { TextToSpeechClient } from '@google-cloud/text-to-speech'
import type {
  SpeechConnectionTestResult,
  SpeechReadingMode,
  SpeechSettings,
  SpeechStatus,
  SynthesizeSpeechInput,
  SynthesizeSpeechResult,
  UpdateSpeechSettingsInput
} from '../shared/types'
import { Store } from './store'

export const GOOGLE_NEURAL2_FREE_CHARACTERS = 1_000_000
export const DEFAULT_SPEECH_CHARACTER_LIMIT = 950_000
const MAX_SPEECH_SOURCE_CHARACTERS = 30_000
const MAX_REQUEST_BYTES = 4_500
const GOOGLE_TTS_SETUP_COMMANDS =
  'Run `gcloud auth application-default login`, then ' +
  '`gcloud auth application-default set-quota-project YOUR_PROJECT_ID`.'

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen'
]

const TENS_WORDS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety'
]

function smallNumberWords(value: number): string {
  if (value < 20) return NUMBER_WORDS[value]
  if (value < 100) {
    const tens = Math.floor(value / 10)
    const rest = value % 10
    return rest ? `${TENS_WORDS[tens]}-${NUMBER_WORDS[rest]}` : TENS_WORDS[tens]
  }
  if (value < 1_000) {
    const hundreds = Math.floor(value / 100)
    const rest = value % 100
    return rest
      ? `${NUMBER_WORDS[hundreds]} hundred ${smallNumberWords(rest)}`
      : `${NUMBER_WORDS[hundreds]} hundred`
  }
  return value.toLocaleString('en-US')
}

function versionPartWords(part: string): string {
  const value = Number(part)
  if (!Number.isSafeInteger(value)) return part.split('').join(' ')
  if (part.length === 3 && value >= 100 && value < 200) {
    const rest = value - 100
    return rest ? `one ${smallNumberWords(rest)}` : 'one hundred'
  }
  return smallNumberWords(value)
}

function versionWords(raw: string): string {
  const [core, prerelease] = raw.split('-', 2)
  const spokenCore = core.split('.').map(versionPartWords).join(' dot ')
  if (!prerelease) return spokenCore
  const spokenPrerelease = prerelease
    .split(/[.-]/)
    .map((part) => (/^\d+$/.test(part) ? versionPartWords(part) : part))
    .join(' ')
  return `${spokenCore}, ${spokenPrerelease}`
}

function plainUrl(raw: string): string {
  try {
    const url = new URL(raw)
    const host = url.hostname.replace(/^www\./, '').replace(/\./g, ' dot ')
    const path = url.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 3)
      .join(', ')
    return path ? `${host}, ${path}` : host
  } catch {
    return raw
  }
}

function stripTerminalControl(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

export function verbalizeSpeechText(
  source: string,
  mode: SpeechReadingMode
): string {
  let text = stripTerminalControl(source).normalize('NFC')
  if (mode === 'verbatim') {
    return text.replace(/\n{3,}/g, '\n\n').trim()
  }

  text = text
    .replace(/^```[^\n]*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(
      /\b(session|thread|terminal|conversation|project)(?:\s+(?:id|identifier))?\s*(?:(?:is)\s+|[:=]\s*)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      (_match, label: string) => `${label} ID`
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      'unique identifier'
    )
    .replace(
      /\b(?:version\s+|v)(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?)/gi,
      (_match, version: string) => `version ${versionWords(version)}`
    )
    .replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) => plainUrl(url))
    .replace(/[│┃┆┇┊┋╎╏═─━]{2,}/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')

  return text.trim()
}

function splitOversizedToken(token: string, maxBytes: number): string[] {
  const chunks: string[] = []
  let current = ''
  for (const character of token) {
    if (Buffer.byteLength(current + character, 'utf8') > maxBytes && current) {
      chunks.push(current)
      current = character
    } else {
      current += character
    }
  }
  if (current) chunks.push(current)
  return chunks
}

export function splitSpeechText(
  text: string,
  maxBytes = MAX_REQUEST_BYTES
): string[] {
  const segments = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
  const chunks: string[] = []
  let current = ''

  const append = (segment: string): void => {
    const candidate = current ? `${current} ${segment}` : segment
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      current = candidate
      return
    }
    if (current) {
      chunks.push(current)
      current = ''
    }
    if (Buffer.byteLength(segment, 'utf8') <= maxBytes) {
      current = segment
      return
    }
    const words = segment.split(/\s+/)
    for (const word of words) {
      if (Buffer.byteLength(word, 'utf8') > maxBytes) {
        if (current) {
          chunks.push(current)
          current = ''
        }
        chunks.push(...splitOversizedToken(word, maxBytes))
      } else {
        append(word)
      }
    }
  }

  for (const segment of segments) append(segment)
  if (current) chunks.push(current)
  return chunks
}

export function googleBillingMonth(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  if (!year || !month) throw new Error('Could not determine the Google billing month.')
  return `${year}-${month}`
}

function validatedSettings(
  current: SpeechSettings,
  input: UpdateSpeechSettingsInput
): SpeechSettings {
  if (!input || typeof input.voiceName !== 'string') {
    throw new Error('Choose valid Google speech settings.')
  }
  const voiceName = input.voiceName.trim()
  if (!/^en-US-Neural2-[A-Z]$/.test(voiceName)) {
    throw new Error('Choose a supported US English Neural2 voice.')
  }
  if (
    !Number.isFinite(input.speakingRate) ||
    input.speakingRate < 0.75 ||
    input.speakingRate > 1.25
  ) {
    throw new Error('Speaking rate must be between 0.75 and 1.25.')
  }
  if (!Number.isFinite(input.pitch) || input.pitch < -5 || input.pitch > 5) {
    throw new Error('Pitch must be between -5 and 5.')
  }
  if (
    !Number.isSafeInteger(input.monthlyCharacterLimit) ||
    input.monthlyCharacterLimit < 1_000 ||
    input.monthlyCharacterLimit > GOOGLE_NEURAL2_FREE_CHARACTERS
  ) {
    throw new Error('The monthly character limit must be between 1,000 and 1,000,000.')
  }
  return {
    ...current,
    voiceName,
    languageCode: 'en-US',
    speakingRate: input.speakingRate,
    pitch: input.pitch,
    monthlyCharacterLimit: input.monthlyCharacterLimit
  }
}

function friendlyGoogleError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /default credentials|could not load|application default|unauthenticated|quota project/i.test(
      message
    )
  ) {
    return new Error(`Google Cloud credentials are not configured. ${GOOGLE_TTS_SETUP_COMMANDS}`)
  }
  if (/permission|billing|serviceusage|disabled|not been used/i.test(message)) {
    return new Error(
      `Google Cloud Text-to-Speech is not ready for this account. Enable the API and billing, ` +
        `then verify the ADC quota project. ${message}`
    )
  }
  return new Error(`Google Cloud Text-to-Speech failed: ${message}`)
}

export class SpeechService {
  private client: TextToSpeechClient | null = null

  constructor(private readonly store: Store) {}

  status(): SpeechStatus {
    const settings = this.store.getSpeechSettings()
    return {
      settings,
      usage: this.store.getSpeechUsage(
        googleBillingMonth(),
        settings.monthlyCharacterLimit
      )
    }
  }

  updateSettings(input: UpdateSpeechSettingsInput): SpeechStatus {
    const settings = validatedSettings(this.store.getSpeechSettings(), input)
    this.store.updateSpeechSettings(settings)
    return this.status()
  }

  async testConnection(): Promise<SpeechConnectionTestResult> {
    try {
      const client = this.getClient()
      const settings = this.store.getSpeechSettings()
      const [[response], authClient] = await Promise.all([
        client.listVoices({ languageCode: settings.languageCode }),
        client.auth.getClient()
      ])
      const projectId = authClient.quotaProjectId ?? null
      const voices = (response.voices ?? [])
        .map((voice) => voice.name ?? '')
        .filter((name) => name.startsWith('en-US-Neural2-'))
        .sort()
      if (!voices.length) {
        return {
          ok: false,
          message: 'Google connected, but no US English Neural2 voices were returned.',
          projectId,
          voices
        }
      }
      return {
        ok: true,
        message: `Connected to Google Cloud project ${projectId}.`,
        projectId,
        voices
      }
    } catch (error) {
      throw friendlyGoogleError(error)
    }
  }

  async synthesize(input: SynthesizeSpeechInput): Promise<SynthesizeSpeechResult> {
    if (!input || typeof input.text !== 'string') {
      throw new Error('There is no readable text in the active pane.')
    }
    const sourceCharacters = Array.from(input.text).length
    if (!input.text.trim()) throw new Error('There is no readable text in the active pane.')
    if (sourceCharacters > MAX_SPEECH_SOURCE_CHARACTERS) {
      throw new Error(
        `Read-aloud input is limited to ${MAX_SPEECH_SOURCE_CHARACTERS.toLocaleString()} ` +
          'characters. Select a smaller passage.'
      )
    }
    if (input.mode !== 'concise' && input.mode !== 'verbatim') {
      throw new Error('Choose a valid speech reading mode.')
    }

    const spokenText = verbalizeSpeechText(input.text, input.mode)
    const chunks = splitSpeechText(spokenText)
    if (!chunks.length) throw new Error('There is no readable text in the active pane.')
    const characters = chunks.reduce(
      (total, chunk) => total + Array.from(chunk).length,
      0
    )
    const settings = this.store.getSpeechSettings()
    let client: TextToSpeechClient
    try {
      client = this.getClient()
      await client.auth.getClient()
    } catch (error) {
      throw friendlyGoogleError(error)
    }
    const usage = this.store.reserveSpeechCharacters(
      googleBillingMonth(),
      characters,
      settings.monthlyCharacterLimit
    )

    try {
      const audioDataUrls: string[] = []
      for (const chunk of chunks) {
        const [response] = await client.synthesizeSpeech({
          input: { text: chunk },
          voice: {
            languageCode: settings.languageCode,
            name: settings.voiceName
          },
          audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: settings.speakingRate,
            pitch: settings.pitch
          }
        })
        if (!response.audioContent) {
          throw new Error('Google returned an empty audio response.')
        }
        const base64 =
          typeof response.audioContent === 'string'
            ? response.audioContent
            : Buffer.from(response.audioContent).toString('base64')
        audioDataUrls.push(`data:audio/mpeg;base64,${base64}`)
      }
      return { audioDataUrls, spokenText, characters, usage }
    } catch (error) {
      // The reservation intentionally remains counted. A request may have reached
      // Google before a later chunk failed, so refunding locally could exceed the
      // free tier.
      throw friendlyGoogleError(error)
    }
  }

  close(): void {
    void this.client?.close()
    this.client = null
  }

  private getClient(): TextToSpeechClient {
    this.client ??= new TextToSpeechClient()
    return this.client
  }
}
