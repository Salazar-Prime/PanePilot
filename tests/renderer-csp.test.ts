import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('renderer content security policy', () => {
  it('restricts media to bundled resources', () => {
    const html = readFileSync(
      join(process.cwd(), 'src', 'renderer', 'index.html'),
      'utf8'
    )

    expect(html).toContain("media-src 'self';")
    expect(html).not.toMatch(/media-src[^;\"]*(?:data:|https?:)/)
  })

  it('allows only the dedicated preview frame without relaxing app script execution', () => {
    const html = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')
    expect(html).toContain("frame-src 'self' panepilot-preview:")
    expect(html).toContain("script-src 'self';")
    expect(html).not.toMatch(/script-src[^;]*(?:unsafe-inline|unsafe-eval|panepilot-preview)/)
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
