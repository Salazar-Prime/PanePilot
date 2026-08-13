import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('renderer content security policy', () => {
  it('allows PanePilot-generated audio data without allowing remote media', () => {
    const html = readFileSync(
      join(process.cwd(), 'src', 'renderer', 'index.html'),
      'utf8'
    )

    expect(html).toContain("media-src 'self' data:")
    expect(html).not.toMatch(/media-src[^;]*https?:/)
  })

  it('allows secure README images without allowing insecure remote images', () => {
    const html = readFileSync(
      join(process.cwd(), 'src', 'renderer', 'index.html'),
      'utf8'
    )

    expect(html).toContain("img-src 'self' data: https:")
    expect(html).not.toMatch(/img-src[^;]*\bhttp:/)
  })
})
