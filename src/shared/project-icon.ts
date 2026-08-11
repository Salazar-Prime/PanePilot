const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme'
})

export function normalizeProjectIcon(value: string | null): string | null {
  if (value == null) return null
  const cleaned = value.trim()
  if (!cleaned) return null
  if (cleaned.length > 32) {
    throw new Error('Project icons must be one Unicode symbol or emoji.')
  }
  if (/\p{Cc}/u.test(cleaned)) {
    throw new Error('Project icons cannot contain control characters.')
  }
  const graphemes = [...graphemeSegmenter.segment(cleaned)]
  if (graphemes.length !== 1 || graphemes[0].segment !== cleaned) {
    throw new Error('Project icons must be one Unicode symbol or emoji.')
  }
  return cleaned
}
