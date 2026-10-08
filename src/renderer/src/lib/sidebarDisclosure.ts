/** Reveal a whole group when it fits; otherwise keep its heading at the top. */
export function disclosureScrollDelta(top: number, bottom: number, groupTop: number, groupBottom: number): number {
  const start = top + 8
  const end = bottom - 8
  if (groupBottom - groupTop > end - start) return groupTop - start
  if (groupTop < start) return groupTop - start
  return Math.max(0, groupBottom - end)
}

export function disclosureTailHeight(scrollTop: number, viewportHeight: number, contentHeight: number): number {
  return scrollTop <= 0 ? 0 : Math.max(0, scrollTop + viewportHeight - contentHeight)
}

/** Minimal trailing space prevents the browser clamping scrollTop on collapse.
 * It is reclaimed as the user scrolls up or a group expands, not on a timer. */
export function trimSidebarTail(container: HTMLElement, scrollTop = container.scrollTop): void {
  const tail = container.querySelector<HTMLElement>('[data-sidebar-scroll-tail]')
  if (!tail) return
  // scrollHeight is at least clientHeight, so subtracting the tail from it
  // overestimates padding needs once the remaining content fits the viewport.
  const naturalHeight = tail.getBoundingClientRect().top - container.getBoundingClientRect().top +
    container.scrollTop - container.clientTop + parseFloat(getComputedStyle(container).paddingBottom || '0')
  tail.style.height = `${disclosureTailHeight(scrollTop, container.clientHeight, naturalHeight)}px`
}

export function animateSidebarDisclosure(
  element: HTMLElement, content: HTMLElement, open: boolean, done: () => void
): () => void {
  const container = element.closest<HTMLElement>('.sidebar-scroll')!
  const project = element.closest<HTMLElement>('[data-sidebar-project-id]')!
  const from = element.getBoundingClientRect().height
  const to = open ? content.getBoundingClientRect().height : 0
  const initialScroll = container.scrollTop
  const bounds = container.getBoundingClientRect()
  const projectBounds = project.getBoundingClientRect()
  const scrollDelta = open ? disclosureScrollDelta(bounds.top, bounds.bottom, projectBounds.top, projectBounds.bottom + to - from) : 0
  const tail = container.querySelector<HTMLElement>('[data-sidebar-scroll-tail]')
  // Reserve the disappearing space before shrinking layout (including bottom-of-list collapses).
  if (!open && tail) tail.style.height = `${tail.offsetHeight + from}px`
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
  let frame = 0
  let interrupted = false
  let finished = false
  const interrupt = () => { interrupted = true }
  const clean = () => {
    cancelAnimationFrame(frame)
    container.removeEventListener('wheel', interrupt)
    container.removeEventListener('pointerdown', interrupt)
    container.removeEventListener('keydown', interrupt)
    preference.removeEventListener('change', finish)
    document.removeEventListener('visibilitychange', finish)
    delete element.dataset.disclosing
  }
  const layout = (progress: number) => {
    element.style.height = `${from + (to - from) * progress}px`
    const desiredScroll = interrupted ? container.scrollTop : initialScroll + scrollDelta * progress
    trimSidebarTail(container, desiredScroll)
    if (!interrupted) container.scrollTop = desiredScroll
  }
  const finish = () => {
    if (finished) return
    finished = true
    layout(1)
    element.style.height = open ? 'auto' : '0px'
    clean()
    done()
    container.dispatchEvent(new Event('sidebar-disclosure-settled'))
  }
  element.dataset.disclosing = 'true'
  container.addEventListener('wheel', interrupt, { passive: true })
  container.addEventListener('pointerdown', interrupt, { passive: true })
  container.addEventListener('keydown', interrupt)
  preference.addEventListener('change', finish)
  document.addEventListener('visibilitychange', finish)
  const started = performance.now()
  const tick = (now: number) => {
    const progress = Math.min(1, (now - started) / 380)
    // Ease-out matches the short, decelerating project-reorder motion.
    layout(1 - Math.pow(1 - progress, 4))
    if (progress === 1) finish()
    else frame = requestAnimationFrame(tick)
  }
  if (preference.matches || document.hidden || !container.getClientRects().length) finish()
  else frame = requestAnimationFrame(tick)
  // Keep the intermediate height on reversal; the next run continues from it.
  return () => { finished = true; clean() }
}
