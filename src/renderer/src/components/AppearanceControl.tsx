import { ALargeSmall, Check, Minus, Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  APPEARANCE_SCALES,
  nextAppearanceScale,
  type AppearanceScale
} from '../lib/appearanceScale'
import { useModalEscape } from '../lib/modalEscape'

interface Props {
  scale: AppearanceScale
  onChange(scale: AppearanceScale): void
}

const scaleLabels: Record<AppearanceScale, string> = {
  0.9: 'Compact',
  1: 'Standard',
  1.1: 'Comfortable',
  1.25: 'Large'
}

export function AppearanceControl({ scale, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useModalEscape(() => setOpen(false), open)

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', closeOutside, true)
    return () => window.removeEventListener('mousedown', closeOutside, true)
  }, [open])

  return (
    <div className="appearance-control" ref={rootRef}>
      <button
        className={`icon-button ${open ? 'active' : ''}`}
        aria-label="Text and interface size"
        aria-expanded={open}
        title={`Text and interface size · ${Math.round(scale * 100)}%`}
        onClick={() => setOpen((current) => !current)}
      >
        <ALargeSmall size={17} />
      </button>
      {open && (
        <section className="appearance-popover" aria-label="Text and interface size">
          <header>
            <div>
              <strong>Readable size</strong>
              <small>Terminal, editor, and interface</small>
            </div>
            <span>{Math.round(scale * 100)}%</span>
          </header>
          <div className="appearance-stepper">
            <button
              onClick={() => onChange(nextAppearanceScale(scale, -1))}
              disabled={scale === APPEARANCE_SCALES[0]}
              aria-label="Decrease interface size"
            >
              <Minus size={14} />
            </button>
            <div aria-hidden="true">
              {APPEARANCE_SCALES.map((option) => (
                <i key={option} className={option <= scale ? 'filled' : ''} />
              ))}
            </div>
            <button
              onClick={() => onChange(nextAppearanceScale(scale, 1))}
              disabled={scale === APPEARANCE_SCALES.at(-1)}
              aria-label="Increase interface size"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="appearance-options">
            {APPEARANCE_SCALES.map((option) => (
              <button
                key={option}
                className={scale === option ? 'selected' : ''}
                onClick={() => onChange(option)}
              >
                <span>
                  <strong>{scaleLabels[option]}</strong>
                  <small>{Math.round(option * 100)}%</small>
                </span>
                {scale === option && <Check size={14} />}
              </button>
            ))}
          </div>
          <footer>Interface size changes are available here only</footer>
        </section>
      )}
    </div>
  )
}
