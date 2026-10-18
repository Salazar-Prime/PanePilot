const units: Array<[string, number]> = [
  ['y', 31_536_000], ['mo', 2_592_000], ['w', 604_800],
  ['d', 86_400], ['h', 3_600], ['m', 60]
]
const fullTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
})

export function shortCommitTime(value: string, now = Date.now()): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return '—'
  const seconds = (timestamp - now) / 1_000
  for (const [unit, length] of units) {
    if (Math.abs(seconds) < length) continue
    const label = `${Math.floor(Math.abs(seconds) / length)}${unit}`
    return seconds > 0 ? `in ${label}` : `${label} ago`
  }
  return 'now'
}

export function fullCommitTime(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? fullTimeFormatter.format(date)
    : 'Unknown commit time'
}
