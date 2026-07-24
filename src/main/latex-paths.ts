import { posix } from 'node:path'

export function normalizeProjectRelativePath(
  value: string,
  label: string,
  options: { extension?: string; allowDot?: boolean } = {}
): string {
  const raw = value.trim().replaceAll('\\', '/')
  if (!raw) throw new Error(`${label} is required.`)
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`${label} must be relative to the project folder.`)
  }
  const normalized = posix.normalize(raw).replace(/^\.\//, '')
  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    (!options.allowDot && normalized === '.')
  ) {
    throw new Error(`${label} must stay inside the project folder.`)
  }
  if (options.extension && !normalized.toLocaleLowerCase().endsWith(options.extension)) {
    throw new Error(`${label} must end in ${options.extension}.`)
  }
  return normalized
}

export function normalizeOptionalWebUrl(value: string | undefined, label: string): string | null {
  const cleaned = value?.trim()
  if (!cleaned) return null
  let parsed: URL
  try {
    parsed = new URL(cleaned)
  } catch {
    throw new Error(`${label} must be a valid web URL.`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${label} must use http or https.`)
  }
  return parsed.toString()
}
