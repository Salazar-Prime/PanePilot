import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  googleBillingMonth,
  SpeechService,
  splitSpeechText,
  verbalizeSpeechText
} from '../src/main/speech-service'
import { Store } from '../src/main/store'

let appDataPath: string | null = null

afterEach(() => {
  if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
  appDataPath = null
})

describe('speech verbalization', () => {
  it('shortens session IDs and speaks semantic versions by component', () => {
    const text =
      'Session ID: 550e8400-e29b-41d4-a716-446655440000 uses version 0.145.0.'
    const sentenceForm =
      'The session identifier is 01984243-b17e-7c52-a450-ff3953f46a55.'

    expect(verbalizeSpeechText(text, 'concise')).toBe(
      'Session ID uses version zero dot one forty-five dot zero.'
    )
    expect(verbalizeSpeechText(sentenceForm, 'concise')).toBe(
      'The session ID.'
    )
    expect(verbalizeSpeechText(text, 'verbatim')).toBe(text)
  })

  it('keeps every Google request below the configured UTF-8 byte limit', () => {
    const text = `First sentence. ${'😀'.repeat(2_000)} Last sentence.`
    const chunks = splitSpeechText(text, 100)

    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 100)).toBe(
      true
    )
  })

  it('uses the Google billing month in Pacific time', () => {
    expect(googleBillingMonth(new Date('2026-01-01T07:59:59Z'))).toBe('2025-12')
    expect(googleBillingMonth(new Date('2026-01-01T08:00:00Z'))).toBe('2026-01')
  })
})

describe('speech usage limit', () => {
  it('reserves characters atomically and blocks requests beyond the device limit', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-speech-'))
    const store = new Store(appDataPath)
    try {
      const settings = store.getSpeechSettings()
      expect(settings).toMatchObject({
        provider: 'google-neural2',
        voiceName: 'en-US-Neural2-F',
        monthlyCharacterLimit: 950_000
      })

      const first = store.reserveSpeechCharacters(
        '2026-07',
        949_000,
        settings.monthlyCharacterLimit
      )
      expect(first.remainingCharacters).toBe(1_000)
      expect(() =>
        store.reserveSpeechCharacters(
          '2026-07',
          1_001,
          settings.monthlyCharacterLimit
        )
      ).toThrow('only 1,000 remain')
      expect(
        store.getSpeechUsage('2026-07', settings.monthlyCharacterLimit)
          .usedCharacters
      ).toBe(949_000)
    } finally {
      store.close()
    }
  })
})

describe('speech Google authentication', () => {
  it('uses the ADC quota project when authorized-user credentials have no resource project', async () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-speech-'))
    const store = new Store(appDataPath)
    const service = new SpeechService(store)
    const fakeClient = {
      listVoices: vi.fn().mockResolvedValue([
        {
          voices: [{ name: 'en-US-Neural2-F' }]
        }
      ]),
      auth: {
        getClient: vi.fn().mockResolvedValue({
          quotaProjectId: 'panepilot-t2s'
        })
      }
    }
    Reflect.set(service, 'client', fakeClient)

    try {
      await expect(service.testConnection()).resolves.toEqual({
        ok: true,
        message: 'Connected to Google Cloud project panepilot-t2s.',
        projectId: 'panepilot-t2s',
        voices: ['en-US-Neural2-F']
      })
    } finally {
      store.close()
    }
  })
})
