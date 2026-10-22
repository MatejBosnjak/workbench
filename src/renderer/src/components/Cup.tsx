import type { CaffeinateState } from '@shared/types'

/** Espresso cup on a saucer (design variant 4h). `knockout` is the colour behind the lid badge. */
export function Cup({ mode, size, knockout = 'var(--chrome)', label }: { mode: CaffeinateState['mode']; size: number; knockout?: string; label?: string }) {
  const on = mode !== 'off'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: on ? 'var(--accent)' : 'var(--muted)', overflow: 'visible', flexShrink: 0 }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d="M7 11h9v3.5a3.5 3.5 0 0 1-3.5 3.5h-2A3.5 3.5 0 0 1 7 14.5z" fill={on ? 'currentColor' : 'none'} />
      <path d="M16 12.2h1a1.6 1.6 0 0 1 0 3.2h-1" />
      <path d="M4 20.5h16" />
      {on && (
        <g className="steam">
          <path d="M10 5.5c-.8 1 .8 1.8 0 3" />
          <path d="M13.2 5.5c-.8 1 .8 1.8 0 3" />
        </g>
      )}
      {mode === 'lid' && (
        <>
          <circle cx="19" cy="6" r="4.4" fill={knockout} stroke="none" />
          <g style={{ color: 'var(--info)' }}>
            <path d="M15.8 5.6h6.4" strokeWidth="2.2" />
            <path d="M15 7.8h8" />
          </g>
        </>
      )}
    </svg>
  )
}
