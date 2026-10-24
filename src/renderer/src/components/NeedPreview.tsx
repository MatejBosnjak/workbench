import { useState } from 'react'
import { lastMessage, prRef, verb } from '@shared/git'
import { prSessions, prTasks } from '@shared/links'
import { FE_REPO } from '@shared/runpr'
import type { TasksSnapshot } from '@shared/tasks'
import type { NeedItem } from '../needs'
import { tomorrowMorning } from '../needs'
import { useStore } from '../store'
import { Box } from './Box'
import { NewSessionButton, SessionChip, TaskChip } from './Chips'
import { replyInPane } from './GitView'
import { RunAppButton } from './RunPr'

const CI = { pass: ['CI passing', 'var(--ok)'], fail: ['CI failing', 'var(--bad)'], pending: ['CI running', 'var(--info)'], none: ['no CI', 'var(--faint)'] } as const

const when = (iso: string) => {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return new Date().toDateString() === d.toDateString() ? `today ${time}` : `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

/** The sidebar card for a PR in Needs you: what's waiting, the latest message, and the ways to act on it. ⏎ again opens it. */
export function NeedPreview({ item, tasks, onOpen, onClose }: { item: NeedItem; tasks: TasksSnapshot | null; onOpen(): void; onClose(): void }) {
  const { snooze, sessions, runpr } = useStore()
  const [drafting, setDrafting] = useState(false)
  const p = item.pr!
  const c = item.conversation
  const last = c ? lastMessage(c) : null
  const [ciText, ciColor] = CI[p.ci]
  const linked = prTasks(p, tasks)
  const sess = prSessions(p, p.url, tasks, sessions, runpr?.focus ?? {})[0]

  return (
    <Box title="PR" className="peek" aside={<button className="icon-btn" aria-label="Close" onClick={onClose}>×</button>}>
      <span className={`need-kind need-${item.kind.replace(' ', '-')}`}>{item.kind}</span>
      <span className="gp-ref">
        {prRef(p)} <span style={{ color: ciColor, fontWeight: 400 }}>● {ciText}</span>
      </span>
      <h2 className="peek-title">{p.title}</h2>
      <div className="kv">
        <span className="k">branch</span>
        <span className="faint">{p.branch}</span>
        <span className="k">updated</span>
        <span>{when(p.updatedAt)}</span>
        {linked.length > 0 && (
          <>
            <span className="k">task</span>
            <span className="peek-prs">
              {linked.map((t) => (
                <TaskChip key={t.id} task={t} />
              ))}
            </span>
            <span className="k">session</span>
            <span className="peek-prs">{sess ? <SessionChip s={sess} /> : <NewSessionButton taskId={linked[0]!.id} />}</span>
          </>
        )}
      </div>

      {c && last && (
        <>
          <div className="peek-sub">
            {last.author} {verb(c)}
            {c.path ? ` ${c.path.split('/').pop()}` : ''} · {when(last.at)}
          </div>
          <span className="pr-quote-text need-quote">{last.body.trim() || '(no text)'}</span>
        </>
      )}

      <div className="peek-actions">
        <button className="key-btn primary-key" onClick={onOpen}>
          ⏎ open
        </button>
        {c && (
          <button
            className="key-btn"
            disabled={drafting}
            onClick={async () => {
              setDrafting(true)
              try {
                await replyInPane(p, c, true)
              } finally {
                setDrafting(false)
              }
            }}
          >
            {drafting ? 'drafting…' : 'draft reply with Claude'}
          </button>
        )}
        {p.repo === FE_REPO && <RunAppButton n={p.number} compact />}
      </div>
      <div className="peek-links">
        <button className="link-btn" onClick={() => snooze(item.key, tomorrowMorning())}>
          zz sleep until tomorrow
        </button>
        <button className="link-btn" onClick={() => void window.workbench.openExternal(last?.url || p.url)}>
          open in browser
        </button>
      </div>
    </Box>
  )
}
