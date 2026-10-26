import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import type { PaneNode, ServiceState } from '@shared/local'
import { closePane, defaultLayout, leaves, nextShellId, setSizes, splitPane } from '../panes'
import { TermView } from './TermView'

const Icon = {
  right: <path d="M3 5h18v14H3zM12 5v14" />,
  down: <path d="M3 5h18v14H3zM3 12h18" />,
  max: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
}
const Svg = ({ d }: { d: ReactNode }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    {d}
  </svg>
)

/** Split, resizable terminals for one service; the layout is saved per service. */
export function Panes({ service }: { service: ServiceState }) {
  const key = `ui:layout:${service.name}`
  const [layout, setLayout] = useState<PaneNode | null>(null)
  const [maxed, setMaxed] = useState<string | null>(null)
  const [alive, setAlive] = useState<Record<string, boolean>>({})

  useEffect(() => window.workbench.local.onPaneExit((id) => setAlive((a) => ({ ...a, [id]: false }))), [])

  // Snapshots replace `service` on every update; only a different service reloads the layout.
  const def = useRef(service.def)
  def.current = service.def
  useEffect(() => {
    setLayout(null)
    setMaxed(null)
    void window.workbench.getSetting<PaneNode | null>(key, null).then((l) => setLayout(l ?? defaultLayout(def.current)))
  }, [key])

  if (!layout) return null

  const save = (next: PaneNode) => {
    setLayout(next)
    void window.workbench.setSetting(key, next)
  }

  const header = (id: string, index: number) => {
    const isService = id.startsWith('svc:')
    return (
      <div className="pane-head">
        {isService && <span className={`svc-dot svc-${service.status}`} />}
        <span className="mono">
          {index + 1} · {isService ? service.def.command : 'zsh'}
        </span>
        {isService && service.status === 'crashed' && <span className="mono pane-crash">· crashed · exit {service.exitCode}</span>}
        <span className="pane-tools">
          <button aria-label="Split right" title="Split right" onClick={() => save(splitPane(layout, id, 'row', nextShellId(layout, service.name)))}>
            <Svg d={Icon.right} />
          </button>
          <button aria-label="Split down" title="Split down" onClick={() => save(splitPane(layout, id, 'col', nextShellId(layout, service.name)))}>
            <Svg d={Icon.down} />
          </button>
          <button aria-label={maxed === id ? 'Restore pane' : 'Maximize pane'} title={maxed === id ? 'Restore' : 'Maximize'} onClick={() => setMaxed(maxed === id ? null : id)}>
            <Svg d={Icon.max} />
          </button>
          {!isService && (
            <button
              aria-label="Close pane"
              title="Close pane"
              onClick={() => {
                void window.workbench.local.closePane(id)
                if (maxed === id) setMaxed(null)
                save(closePane(layout, id))
              }}
            >
              <Svg d={Icon.close} />
            </button>
          )}
        </span>
      </div>
    )
  }

  const order = leaves(layout)
  const pane = (id: string) => {
    const isService = id.startsWith('svc:')
    const running = service.status === 'running' || service.status === 'stopping'
    // The service's terminal is a shell that outlives the command; without one (not zsh) it's only there while it runs.
    const terminal = service.terminal ?? running
    const open = (size: { cols: number; rows: number }) => window.workbench.local.openPane(id, size)
    return (
      <div className={`pane${isService ? ' pane-main' : ''}`}>
        {header(id, order.indexOf(id))}
        <div className="pane-body">
          <TermView
            id={id}
            active
            autoFocus={false}
            hideWhenInactive={false}
            className="pane-term"
            alive={isService ? terminal : (alive[id] ?? true)}
            open={(size) => void open(size)}
            revive={isService ? (size) => void open(size) : (size) => void open(size).then(() => setAlive((a) => ({ ...a, [id]: true })))}
            exitMessage="shell exited · press Enter for a new one"
          />
          {isService && !terminal && (
            <div className="pane-idle">
              <span>{service.status === 'crashed' ? `Crashed · exit code ${service.exitCode}` : 'Not running'}</span>
              <button className="primary" onClick={() => void window.workbench.local.start(service.name)}>
                Start {service.name}
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  const render = (n: PaneNode): ReactNode => {
    if (n.type === 'leaf') return pane(n.id)
    const even = 100 / n.children.length
    return (
      <Group
        orientation={n.dir === 'row' ? 'horizontal' : 'vertical'}
        defaultLayout={n.sizes ?? Object.fromEntries(n.children.map((c) => [c.id, even]))}
        onLayoutChanged={(sizes) => save(setSizes(layout, n.id, sizes))}
      >
        {n.children.map((c, i) => (
          <PanelWithSeparator key={c.id} id={c.id} first={i === 0} dir={n.dir}>
            {render(c)}
          </PanelWithSeparator>
        ))}
      </Group>
    )
  }

  return <div className="panes">{maxed && order.includes(maxed) ? pane(maxed) : render(layout)}</div>
}

function PanelWithSeparator({ id, first, dir, children }: { id: string; first: boolean; dir: 'row' | 'col'; children: ReactNode }) {
  return (
    <>
      {!first && <Separator className={`pane-sep ${dir}`} />}
      <Panel id={id} minSize="10">
        {children}
      </Panel>
    </>
  )
}
