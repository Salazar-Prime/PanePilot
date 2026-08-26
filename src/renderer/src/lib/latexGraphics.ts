export interface LatexGraphicReference {
  source: string
  startColumn: number
  endColumn: number
  candidates: string[]
}

const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
  '.avif',
  '.bmp',
  '.pdf'
]

function unescapedCommentStart(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '%') continue
    let slashes = 0
    for (let before = index - 1; before >= 0 && line[before] === '\\'; before -= 1) {
      slashes += 1
    }
    if (slashes % 2 === 0) return index
  }
  return -1
}

function normalizeRelativePath(basePath: string, rawPath: string): string | null {
  if (!rawPath || rawPath.startsWith('/') || rawPath.includes('\\')) return null
  const parts: string[] = []
  const baseParts = basePath.split('/').slice(0, -1)
  for (const part of [...baseParts, ...rawPath.split('/')]) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
      continue
    }
    if (/^[^\u0000-\u001f\u007f{}$#]+$/.test(part)) parts.push(part)
    else return null
  }
  return parts.join('/') || null
}

function withImageExtensions(path: string): string[] {
  const name = path.split('/').at(-1) ?? ''
  return /\.[a-z0-9]+$/i.test(name)
    ? [path]
    : IMAGE_EXTENSIONS.map((extension) => `${path}${extension}`)
}

export function latexGraphicAtColumn(
  line: string,
  sourcePath: string,
  column: number
): LatexGraphicReference | null {
  const commentStart = unescapedCommentStart(line)
  const visibleLine = commentStart < 0 ? line : line.slice(0, commentStart)
  const pattern = /\\includegraphics\s*(?:\[[^\]]*\]\s*)?\{([^{}\r\n]+)\}/g
  for (const match of visibleLine.matchAll(pattern)) {
    const raw = match[1]
    const trimmed = raw.trim()
    if (!trimmed || match.index == null) continue
    const rawStart = match.index + match[0].indexOf(raw)
    const leadingSpace = raw.length - raw.trimStart().length
    const startColumn = rawStart + leadingSpace + 1
    const endColumn = startColumn + trimmed.length
    if (column < startColumn || column > endColumn) continue

    const candidates = new Set<string>()
    const fromRoot = normalizeRelativePath('', trimmed)
    const fromSource = normalizeRelativePath(sourcePath, trimmed)
    for (const candidate of [fromRoot, fromSource]) {
      if (!candidate) continue
      for (const expanded of withImageExtensions(candidate)) candidates.add(expanded)
    }
    if (!candidates.size) return null
    return {
      source: trimmed,
      startColumn,
      endColumn,
      candidates: [...candidates]
    }
  }
  return null
}
