import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpDown, Check } from 'lucide-react'

export interface SortMenuOption<T extends string> {
  value: T
  label: string
}

interface SortMenuProps<T extends string> {
  x: number
  y: number
  label: string
  value: T
  options: SortMenuOption<T>[]
  onChange(value: T): void
  onClose(): void
}

export function SortMenu<T extends string>({
  x,
  y,
  label,
  value,
  options,
  onChange,
  onClose
}: SortMenuProps<T>) {
  useEffect(() => {
    function closeOutside(event: MouseEvent) {
      const target = event.target as HTMLElement
      if (!target.closest('.sort-menu')) onClose()
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', closeOutside)
    window.addEventListener('blur', onClose)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', closeOutside)
      window.removeEventListener('blur', onClose)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose])

  const width = 184
  const estimatedHeight = 37 + options.length * 31 + 8
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8))
  const top = Math.max(
    8,
    Math.min(y, window.innerHeight - estimatedHeight - 8)
  )

  return createPortal(
    <div
      className="sort-menu"
      role="menu"
      aria-label={label}
      style={{ left, top, width }}
    >
      <header>
        <ArrowUpDown size={12} />
        <span>{label}</span>
      </header>
      {options.map((option) => (
        <button
          key={option.value}
          role="menuitemradio"
          aria-checked={option.value === value}
          className={option.value === value ? 'selected' : ''}
          onClick={() => {
            onChange(option.value)
            onClose()
          }}
        >
          <Check size={12} />
          <span>{option.label}</span>
        </button>
      ))}
    </div>,
    document.body
  )
}
