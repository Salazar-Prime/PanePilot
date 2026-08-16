export async function copyConversationSessionId(
  providerSessionId: string | null,
  copyText: (text: string) => Promise<void>
): Promise<boolean> {
  if (!providerSessionId) return false
  await copyText(providerSessionId)
  return true
}
