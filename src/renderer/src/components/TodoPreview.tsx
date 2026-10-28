import { useEffect, useState } from 'react'
import { dayText, isoDay, parseDay } from '@shared/todos'
import type { NeedItem } from '../needs'
import { tomorrowMorning } from '../needs'
import { useStore } from '../store'
import { Box } from './Box'
import { sessionStyle } from './SessionMark'
import { finishTodo, openTodo } from './TodayView'

/** The sidebar card for one of my to-dos: its text, day and note edited in place, the session it came from, done / sleep / delete. */
export function TodoPreview({ item, onClose }: { item: NeedItem; onClose(): void }) {
  const t = item.todo!
  const { snooze, sessions } = useStore()
  const [text, setText] = useState(t.text)
  const [note, setNote] = useState(t.note)
  const [day, setDay] = useState(t.due ? dayText(t.due) : '')
  useEffect(() => {
    setText(t.text)
    setNote(t.note)
    setDay(t.due ? dayText(t.due) : '')
  }, [t.id, t.text, t.note, t.due])
  const sess = t.sessionId ? sessions.find((s) => s.id === t.sessionId) : undefined
  const save = (patch: Parameters<typeof window.workbench.todos.update>[1]) => void window.workbench.todos.update(t.id, patch)
  const parsedDay = day.trim() ? parseDay(day) : null
  const saveDay = () => {
    if (!day.trim()) return t.due && save({ due: null })
    if (parsedDay && parsedDay !== t.due) save({ due: parsedDay })
    else setDay(t.due ? dayText(t.due) : '')
  }
  const late = !!t.due && t.due < isoDay(new Date())

  return (
    <Box title="To-do" className="peek" aside={<button className="icon-btn" aria-label="Close" onClick={onClose}>×</button>}>
      <span className="need-kind need-to-do">to-do</span>
      <input
        className="todo-title peek-title"
        aria-label="To-do"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text.trim() && text.trim() !== t.text && save({ text: text.trim() })}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()}
      />
      <div className="kv">
        <span className="k">due</span>
        <span>
          <input
            className={`todo-day${late ? ' bad-text' : ''}`}
            aria-label="Due"
            placeholder="no date · type fri, tomorrow, 3 nov"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            onBlur={saveDay}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && (e.target as HTMLInputElement).blur()}
          />
          {day.trim() && day !== (t.due ? dayText(t.due) : '') && <span className={parsedDay ? 'faint' : 'bad-text'}>{parsedDay ? ` → ${dayText(parsedDay)}` : ' not a day'}</span>}
        </span>
        <span className="k">added</span>
        <span>{new Date(t.createdAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
        {t.sessionId && (
          <>
            <span className="k">from</span>
            <span className="todo-sess" style={sess ? sessionStyle(sess) : undefined}>
              {sess?.title ?? t.sessionTitle ?? 'a session'}
              {!sess && <span className="faint"> · closed</span>}
            </span>
          </>
        )}
      </div>
      <textarea
        className="todo-note"
        aria-label="Note"
        placeholder="note"
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => note !== t.note && save({ note })}
      />
      <div className="peek-actions">
        <button className="key-btn primary-key" onClick={() => (finishTodo(t), onClose())}>
          ✓ done <span className="faint">x</span>
        </button>
        {t.sessionId && (
          <button className="key-btn" onClick={() => void openTodo(t)}>
            ⏎ {sess ? 'open session' : 'resume session'}
          </button>
        )}
      </div>
      <div className="peek-links">
        <button className="link-btn" onClick={() => snooze(item.key, tomorrowMorning())}>
          zz sleep until tomorrow
        </button>
        <button className="link-btn bad-text" onClick={() => (void window.workbench.todos.remove(t.id), onClose())}>
          delete
        </button>
      </div>
    </Box>
  )
}
