import { useEffect, useRef, useState } from 'react'
import type { DraftTarget, GitSnapshot } from '@shared/git'
import { prRef } from '@shared/git'
import { useStore } from '../store'

function targetLabel(t: DraftTarget): string {
  if (t.kind === 'productive') return `Comment on “${t.title}”`
  const ref = `${t.repo.split('/')[1]} #${t.number}`
  return t.kind === 'gh-thread' ? `Reply on ${ref} · ${t.path ?? 'thread'}` : `Reply on ${ref}`
}

/** Today's side panel for one draft: optional instruction, Claude's text, edit, send with confirm. */
export function DraftPanel({ target, git }: { target: DraftTarget; git: GitSnapshot }) {
  const setDraft = useStore((s) => s.setDraft)
  const d = git.drafts.find((x) => x.target.key === target.key && x.status !== 'sent') ?? git.drafts.find((x) => x.target.key === target.key)
  const [body, setBody] = useState(d?.body ?? '')
  const [instruction, setInstruction] = useState('')
  const synced = useRef<string | null>(d?.body ?? null)

  // Take main's text when it changes there (Claude finished a draft).
  useEffect(() => {
    if (d && d.body !== synced.current) {
      synced.current = d.body
      setBody(d.body)
    }
  }, [d?.id, d?.body])

  useEffect(() => {
    if (!d || body === synced.current) return
    const t = setTimeout(() => {
      synced.current = body
      void window.workbench.git.saveDraft(d.id, body)
    }, 400)
    return () => clearTimeout(t)
  }, [body, d?.id])

  const pr = target.kind === 'productive' ? null : git.mine.find((p) => p.repo === target.repo && p.number === target.number)
  const convo = pr?.conversations.find((c) => c.key === target.key)
  const drafting = d?.status === 'drafting'
  const sending = d?.status === 'sending'
  const sent = d?.status === 'sent'

  return (
    <aside className="peek draft" aria-label="Draft">
      <div className="peek-top">
        <span className="peek-status">{target.kind === 'productive' ? 'Productive' : pr ? prRef(pr) : 'GitHub'}</span>
        <span className="peek-tools">
          <button className="icon-btn" aria-label="Close draft" onClick={() => setDraft(null)}>
            ×
          </button>
        </span>
      </div>
      <div className="peek-title">
        <h2>{targetLabel(target)}</h2>
        {pr && <span className="peek-parent">{pr.title}</span>}
      </div>

      {convo && (
        <section className="peek-section">
          <span className="peek-label">Conversation</span>
          <div className="draft-convo">
            {convo.diffHunk && <pre className="draft-hunk">{convo.diffHunk.split('\n').slice(-8).join('\n')}</pre>}
            {convo.messages.slice(-4).map((m) => (
              <div key={m.id} className={`draft-msg${m.author === git.viewer ? ' me' : ''}`}>
                <span className="pop-note">
                  <b>{m.author}</b>
                  {m.state && m.state !== 'COMMENTED' ? ` · ${m.state.toLowerCase().replace('_', ' ')}` : ''}
                </span>
                <span>{m.body.trim() || '(no text)'}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {sent ? (
        <section className="peek-section">
          <span className="ok-text">Posted.</span>
          <span className="draft-sent">{d!.body}</span>
        </section>
      ) : (
        <>
          <section className="peek-section">
            <span className="peek-label">Ask Claude</span>
            <div className="draft-ask">
              <input
                className="draft-input"
                placeholder="What should it say? (optional)"
                value={instruction}
                disabled={drafting}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void window.workbench.git.generate(target, instruction)
                }}
              />
              <button className="ghost" disabled={drafting || sending} onClick={() => void window.workbench.git.generate(target, instruction)}>
                {drafting ? 'Drafting…' : body.trim() ? 'Redraft' : 'Draft with Claude'}
              </button>
            </div>
            <span className="pop-note">Sonnet, read-only tools, in your checkout of the branch when there is one.</span>
          </section>

          <section className="peek-section draft-body">
            <span className="peek-label">Draft</span>
            <textarea
              className="draft-text"
              value={drafting ? 'Claude is drafting…' : body}
              disabled={drafting || sending || !d}
              placeholder="Write the reply, or ask Claude above."
              onChange={(e) => setBody(e.target.value)}
            />
            {d?.error && <span className="bad-text">{d.error}</span>}
          </section>

          <div className="draft-actions">
            <button
              className="ghost"
              disabled={!d || sending}
              onClick={() => {
                if (d) void window.workbench.git.discardDraft(d.id)
                setDraft(null)
              }}
            >
              Discard
            </button>
            <button className="primary" disabled={!d || drafting || sending || !body.trim()} onClick={() => void window.workbench.git.send(d!.id, body)}>
              {sending ? 'Posting…' : 'Send…'}
            </button>
          </div>
          <span className="pop-note">Send shows the exact text and where it goes before anything is posted.</span>
        </>
      )}
    </aside>
  )
}
