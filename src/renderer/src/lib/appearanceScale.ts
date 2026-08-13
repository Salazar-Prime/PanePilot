import { useEffect, useState } from 'react'

export const APPEARANCE_SCALES = [0.9, 1, 1.1, 1.25] as const
export type AppearanceScale = (typeof APPEARANCE_SCALES)[number]

const STORAGE_KEY = 'panepilot:appearance-scale:v1'
const DEFAULT_SCALE: AppearanceScale = 1.1

export function readAppearanceScale(): AppearanceScale {
  const stored = Number(window.localStorage.getItem(STORAGE_KEY))
  return isAppearanceScale(stored) ? stored : DEFAULT_SCALE
}

export function nextAppearanceScale(
  current: AppearanceScale,
  direction: -1 | 1
): AppearanceScale {
  const index = APPEARANCE_SCALES.indexOf(current)
  const next = Math.max(
    0,
    Math.min(APPEARANCE_SCALES.length - 1, index + direction)
  )
  return APPEARANCE_SCALES[next]
}

export function useAppearanceScale(): [
  AppearanceScale,
  (scale: AppearanceScale) => void
] {
  const [scale, setScale] = useState<AppearanceScale>(readAppearanceScale)

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, String(scale))
    window.projectConsole.system.setZoomFactor(scale)
  }, [scale])

  return [scale, setScale]
}

function isAppearanceScale(value: number): value is AppearanceScale {
  return APPEARANCE_SCALES.includes(value as AppearanceScale)
}
