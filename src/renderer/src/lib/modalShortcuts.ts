import { useEffect, useRef, type RefObject } from 'react'

interface ModalShortcutEvent {
  code: string
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
  isComposing?: boolean
}

interface ModalShortcutsOptions {
  dialogRef: RefObject<HTMLElement>
  onSubmit?: () => void
  active?: boolean
  blocked?: boolean
}

export function modalShortcutAction(event: ModalShortcutEvent):
  | { kind: 'control'; index: number }
  | { kind: 'submit' }
  | null {
  if (
    !(event.metaKey || event.ctrlKey) ||
    event.altKey ||
    event.shiftKey ||
    event.repeat ||
    event.isComposing
  ) return null

  const digit = event.code.match(/^Digit([1-9])$/)
  if (digit) return { kind: 'control', index: Number(digit[1]) - 1 }
  if (event.key === 'Enter') return { kind: 'submit' }
  return null
}

export function useModalShortcuts({
  dialogRef,
  onSubmit,
  active = true,
  blocked = false
}: ModalShortcutsOptions): void {
  const submitRef = useRef(onSubmit)
  const blockedRef = useRef(blocked)
  submitRef.current = onSubmit
  blockedRef.current = blocked

  useEffect(() => {
    if (!active) return
    const handleShortcut = (event: KeyboardEvent) => {
      const action = modalShortcutAction(event)
      const dialog = dialogRef.current
      if (!action || !dialog) return
      const dialogs = Array.from(
        document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
      ).filter((candidate) => candidate.getClientRects().length > 0)
      if (dialogs[dialogs.length - 1] !== dialog) return
      if (action.kind === 'submit' && !submitRef.current) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      if (blockedRef.current) return

      if (action.kind === 'submit') {
        submitRef.current?.()
        return
      }

      const controls = Array.from(
        dialog.querySelectorAll<HTMLElement>('[data-modal-shortcut]')
      ).filter((control) =>
        !control.matches(':disabled') &&
        control.getClientRects().length > 0 &&
        window.getComputedStyle(control).visibility !== 'hidden' &&
        !control.closest('[aria-hidden="true"]')
      )
      const control = controls[action.index]
      if (!control) return
      control.focus()
      if (
        control instanceof HTMLButtonElement ||
        (control instanceof HTMLInputElement &&
          (control.type === 'checkbox' || control.type === 'radio'))
      ) {
        control.click()
      }
    }
    window.addEventListener('keydown', handleShortcut, true)
    return () => window.removeEventListener('keydown', handleShortcut, true)
  }, [active, dialogRef])
}
