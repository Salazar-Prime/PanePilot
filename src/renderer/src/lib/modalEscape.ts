import { useEffect, useRef } from 'react'

interface ModalDismissRegistration {
  id: symbol
  dismiss(): void
  blocked(): boolean
}

const registrations: ModalDismissRegistration[] = []
let listening = false

export function isModalEscapeKey(event: {
  key: string
  repeat?: boolean
  isComposing?: boolean
}): boolean {
  return event.key === 'Escape' && !event.repeat && !event.isComposing
}

function handleEscape(event: KeyboardEvent) {
  if (!isModalEscapeKey(event)) return
  const registration = registrations.at(-1)
  if (!registration) return
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  if (registration.blocked()) return
  registration.dismiss()
}

function updateListener() {
  if (registrations.length > 0 && !listening) {
    window.addEventListener('keydown', handleEscape, true)
    listening = true
  } else if (registrations.length === 0 && listening) {
    window.removeEventListener('keydown', handleEscape, true)
    listening = false
  }
}

export function useModalEscape(
  onDismiss: () => void,
  active = true,
  blocked = false
): void {
  const id = useRef(Symbol('modal-dismiss'))
  const dismissRef = useRef(onDismiss)
  const blockedRef = useRef(blocked)
  dismissRef.current = onDismiss
  blockedRef.current = blocked

  useEffect(() => {
    if (!active) return
    const registration: ModalDismissRegistration = {
      id: id.current,
      dismiss: () => dismissRef.current(),
      blocked: () => blockedRef.current
    }
    registrations.push(registration)
    updateListener()
    return () => {
      const index = registrations.findIndex((item) => item.id === id.current)
      if (index >= 0) registrations.splice(index, 1)
      updateListener()
    }
  }, [active])
}
