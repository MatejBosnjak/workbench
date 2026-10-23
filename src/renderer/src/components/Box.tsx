import type { ReactNode } from 'react'

/** A TUI panel: 1px square border with the title cut into it; the active one is drawn in the accent colour. */
export function Box({ title, active = false, className = '', children, aside }: { title: ReactNode; active?: boolean; className?: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <section className={`box${active ? ' active' : ''}${className ? ` ${className}` : ''}`}>
      <span className="box-title">{title}</span>
      {aside && <span className="box-aside">{aside}</span>}
      {children}
    </section>
  )
}
