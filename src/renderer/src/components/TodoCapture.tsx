import { useEffect, useState, type KeyboardEvent } from 'react'
import { dayText, parseCapture } from '@shared/todos'
import { activeSessionId, useOverlay, useStore } from '../store'
import { sessionStyle } from './SessionMark'

/** ⌥⌘T (or ⌘K "todo …"): one line that adds a to-do to Needs you from any screen; over a session it's linked to it unless ⇥ turns that off. */
export function TodoCapture() {
  useOverlay(true)
  // Back to where typing was (a session's terminal, mid-prompt) once it closes; read before the input takes focus.
  const [before] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(() => () => before?.focus(), [before])
  const { capture, setCapture, view, sessions } = useStore()
  const [text, setText] = useState(capture?.text ?? '')
  const from = sessions.find((s) => s.id === activeSessionId(view))
  const [link, setLink] = useState(!!from)
  const parsed = parseCapture(text)
  const close = () => setCapture(null)

  const add = async () => {
    if (!parsed.text) return
    const s = link ? from : undefined
    close()
    await window.workbench.todos.add({ text: parsed.text, due: parsed.due, sessionId: s?.id ?? null, sessionTitle: s?.title ?? null })
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
    else if (e.key === 'Enter') void add()
    else if (e.key === 'Tab' && from) setLink((l) => !l)
    else return
    e.preventDefault()
  }

  return (
    <div className="scrim" onMouseDown={close}>
      <div className="palette todo-capture" role="dialog" aria-label="Add a to-do" onMouseDown={(e) => e.stopPropagation()}>
        <label className="palette-search">
          <span className="accent-text mono">+ to-do</span>
          <input autoFocus aria-label="To-do" placeholder="what needs doing · a day word at the end sets a date" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
          <kbd>esc</kbd>
        </label>
        {from && (
          <button className="palette-item" data-active={link} onClick={() => setLink((l) => !l)}>
            <span className="todo-check" data-on={link} aria-hidden="true" />
            <span className="pop-text">
              <span>
                link to <span className="todo-sess" style={sessionStyle(from)}>{from.title}</span>
              </span>
              <span className="pop-note">⏎ on the to-do in Needs you comes back to this session</span>
            </span>
            <span className="mono muted palette-hint">⇥ toggles</span>
          </button>
        )}
        <div className="palette-foot mono">
          <span>⏎ add{parsed.due && parsed.text ? ` · due ${dayText(parsed.due)}` : ''}</span>
          <span>esc cancel</span>
        </div>
      </div>
    </div>
  )
}
