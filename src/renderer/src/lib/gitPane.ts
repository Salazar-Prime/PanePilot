const DEFAULT_LOAD_THRESHOLD = 240

export function shouldLoadOlderGitCommits(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = DEFAULT_LOAD_THRESHOLD
): boolean {
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(clientHeight) ||
    !Number.isFinite(scrollHeight) ||
    clientHeight <= 0 ||
    scrollHeight <= clientHeight
  ) {
    return false
  }
  return scrollTop + clientHeight >= scrollHeight - Math.max(0, threshold)
}
