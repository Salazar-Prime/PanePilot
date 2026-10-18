export function formatConversationDate(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString([], {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      })
}
