import { useId } from 'react'
import type { CaffeinateState } from '@shared/types'

/** A porcelain espresso cup on a saucer (docs/design/CaffeinateButton.dc.html): empty when off, coffee and steam when awake, a laptop badge for lid closed. */
export function Cup({ mode, size, label }: { mode: CaffeinateState['mode']; size: number; label?: string }) {
  const id = useId().replace(/:/g, '')
  const on = mode !== 'off'
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" style={{ overflow: 'visible', flexShrink: 0 }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <defs>
        <linearGradient id={`cup${id}`} x1="0" x2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset=".6" stopColor="#EDE6DC" />
          <stop offset="1" stopColor="#C9BFB2" />
        </linearGradient>
        <radialGradient id={`cof${id}`} cx=".45" cy=".4" r=".7">
          <stop offset="0" stopColor="#8A5530" />
          <stop offset="1" stopColor="#3B2112" />
        </radialGradient>
      </defs>
      {on && (
        <g className="steam" fill="none" stroke="#F4EEE6" strokeWidth="1.6" strokeLinecap="round" opacity=".85">
          <path d="M12.5 3.5c-1.2 1.4 1.2 2.6 0 4.2" />
          <path d="M17 2.5c-1.2 1.4 1.2 2.6 0 4.2" />
        </g>
      )}
      <ellipse cx="15" cy="26.5" rx="12.5" ry="2.6" fill={on ? '#D9D1C6' : '#2A2733'} />
      <ellipse cx="15" cy="26" rx="9" ry="1.6" fill={on ? '#BDB3A6' : '#232029'} />
      <path d="M22 15.2h1.6a3.2 3.2 0 0 1 0 6.4H21" fill="none" stroke={on ? '#E6DED3' : '#4A4558'} strokeWidth="2" />
      <path d="M6.9 12.6h15.2v5.6a6 6 0 0 1-6 6h-3.2a6 6 0 0 1-6-6z" fill={on ? `url(#cup${id})` : '#3A3646'} />
      <ellipse cx="14.5" cy="12.6" rx="7.6" ry="2" fill="none" stroke={on ? '#FFFFFF' : '#4A4558'} strokeWidth="1.1" />
      {on && (
        <>
          <ellipse cx="14.5" cy="12.6" rx="7.6" ry="1.9" fill={`url(#cof${id})`} />
          <ellipse cx="14.5" cy="12.4" rx="6.2" ry="1.3" fill="#C98D55" opacity=".55" />
        </>
      )}
      {mode === 'lid' && (
        <g>
          <rect x="20.5" y="1.5" width="11" height="9" rx="2.5" fill="#0E1C24" stroke="#6FC3E0" strokeWidth="1.2" />
          <rect x="22.5" y="4.6" width="7" height="1.8" rx=".6" fill="#6FC3E0" />
          <rect x="21.8" y="7" width="8.4" height="1.2" rx=".6" fill="#6FC3E0" opacity=".7" />
        </g>
      )}
    </svg>
  )
}
