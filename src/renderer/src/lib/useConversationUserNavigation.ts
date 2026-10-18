import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ConversationMessage } from '@shared/types'

/** Jump among retained user cards, never among assistant responses or hidden cards. */
export function useConversationUserNavigation(
  containerRef: RefObject<HTMLDivElement>,
  messages: readonly ConversationMessage[]
) {
  const [index, setIndex] = useState(-1)
  const followingJump = useRef(false)
  const users = messages.filter((message) => message.role === 'user')

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    followingJump.current = false
    const sync = () => {
      if (followingJump.current) return
      const padding = parseFloat(getComputedStyle(container).paddingTop) || 0
      const top = container.getBoundingClientRect().top + padding + 2
      const cards = Array.from(container.querySelectorAll<HTMLElement>('[data-message-role="user"]'))
      let current = -1
      for (let i = 0; i < cards.length; i++) {
        if (cards[i].getBoundingClientRect().top <= top) current = i
        else break
      }
      setIndex(current)
    }
    const manual = () => { followingJump.current = false; sync() }
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) manual()
    }
    container.addEventListener('scroll', sync, { passive: true })
    container.addEventListener('wheel', manual, { passive: true })
    container.addEventListener('pointerdown', manual)
    container.addEventListener('keydown', key)
    const resize = new ResizeObserver(sync)
    resize.observe(container)
    sync()
    return () => {
      resize.disconnect()
      container.removeEventListener('scroll', sync)
      container.removeEventListener('wheel', manual)
      container.removeEventListener('pointerdown', manual)
      container.removeEventListener('keydown', key)
    }
  }, [containerRef, messages])

  function jump(direction: -1 | 1): void {
    const container = containerRef.current
    const next = index + direction
    if (!container || next < 0 || next >= users.length) return
    const card = container.querySelectorAll<HTMLElement>('[data-message-role="user"]')[next]
    if (!card) return
    const padding = parseFloat(getComputedStyle(container).paddingTop) || 0
    const top = container.scrollTop + card.getBoundingClientRect().top - container.getBoundingClientRect().top - padding
    followingJump.current = true
    setIndex(next)
    container.scrollTo({ top: Math.max(0, top), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }

  return { previous: index > 0, next: index < users.length - 1, activeId: users[index]?.id, jump }
}
