import { useEffect, useRef, useState } from 'react'

/** A tiny inline sparkline (no dependency). */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null
  const w = 64
  const h = 16
  const max = Math.max(...values, 1)
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * (h - 3) - 1.5}`)
    .join(' ')
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden="true">
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** A number that eases to its new value instead of jumping. */
export function RollingNumber({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  const frame = useRef(0)

  useEffect(() => {
    const a = from.current
    const b = value
    if (a === b) return
    const start = performance.now()
    const duration = 400
    const tick = (t: number): void => {
      const k = Math.min(1, (t - start) / duration)
      const eased = 1 - Math.pow(1 - k, 3)
      setShown(a + (b - a) * eased)
      if (k < 1) frame.current = requestAnimationFrame(tick)
      else from.current = b
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [value])

  return <>{format(shown)}</>
}
