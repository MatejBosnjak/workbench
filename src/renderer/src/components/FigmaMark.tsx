import type { MouseEvent } from 'react'
import { figmaName, type Design } from '@shared/tasks'

/**
 * The Figma mark for a task's design link: grey at rest, its own colours on hover and on a selected row,
 * fainter when inherited from a parent. Click opens Figma; ⌘-click copies the link.
 */
export function FigmaMark({ design, size = 11 }: { design: Design; size?: number }) {
  const name = figmaName(design.url)
  const click = (e: MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.metaKey) void navigator.clipboard.writeText(design.url)
    else void window.workbench.openFigma(design.url)
  }
  return (
    <span
      role="link"
      tabIndex={-1}
      className={`figma-mark${design.from ? ' inherited' : ''}`}
      title={`Figma · ${name}${design.from ? `\nfrom parent: ${design.from}` : ''}\nclick opens Figma · ⌘-click copies the link`}
      aria-label={`Figma: ${name}`}
      onClick={click}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <svg width={(size * 38) / 57} height={size} viewBox="0 0 38 57" aria-hidden="true">
        <path style={{ fill: 'var(--fm1)' }} d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" />
        <path style={{ fill: 'var(--fm2)' }} d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z" />
        <path style={{ fill: 'var(--fm3)' }} d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" />
        <path style={{ fill: 'var(--fm4)' }} d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" />
        <path style={{ fill: 'var(--fm5)' }} d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z" />
      </svg>
    </span>
  )
}
