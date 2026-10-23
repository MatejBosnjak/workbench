import { useEffect, useRef } from 'react'
import { navigate, useStore } from './store'

/** What the screen on view does with the keyboard-first keys. */
export interface KeyTarget {
  move?(d: 1 | -1): void
  open?(): void
  run?(): void
  /** Returns false to fall back to a plain new session. */
  newSession?(): boolean
  nextPane?(): void
  filter?(): void
  /** Screen-specific keys (e.g. m in My PRs); true when handled. */
  key?(k: string): boolean
}

let target: KeyTarget | null = null

/** Registers the screen's handlers while it's active. */
export function useKeyTarget(t: KeyTarget, active: boolean): void {
  const ref = useRef(t)
  ref.current = t
  useEffect(() => {
    if (!active) return
    const proxy: KeyTarget = {
      move: (d) => ref.current.move?.(d),
      open: () => ref.current.open?.(),
      run: () => ref.current.run?.(),
      newSession: () => ref.current.newSession?.() ?? false,
      nextPane: () => ref.current.nextPane?.(),
      filter: () => ref.current.filter?.(),
      key: (k) => ref.current.key?.(k) ?? false,
    }
    target = proxy
    return () => {
      if (target === proxy) target = null
    }
  }, [active])
}

/** Keys only act when nothing that takes text has focus: a terminal, an input, a textarea. */
function typing(el: Element | null): boolean {
  if (!el) return false
  if (el.closest('.xterm')) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable
}

export function installKeys(newSession: () => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
    const st = useStore.getState()
    if (st.paletteOpen || st.runGuard || st.cafOpen) return
    if (e.key === 'Escape') {
      if (st.keysOpen) st.setKeysOpen(false)
      return
    }
    if (typing(document.activeElement)) return
    const k = e.key
    const done = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (k === 'j' || k === 'ArrowDown') return target?.move && (target.move(1), done())
    if (k === 'k' || k === 'ArrowUp') return target?.move && (target.move(-1), done())
    if (k === 'Enter') return target?.open && (target.open(), done())
    if (k === 'Tab') return target?.nextPane && (target.nextPane(), done())
    if (k === 'r') return target?.run && (target.run(), done())
    if (k === 's') {
      if (!target?.newSession?.()) newSession()
      return done()
    }
    if (k === '/') {
      if (target?.filter) target.filter()
      else st.setPalette(true)
      return done()
    }
    if (k === 'g' || k === 'v') {
      navigate({ kind: k === 'g' ? 'git' : 'reviews', prId: null })
      return done()
    }
    if (k === 'c') {
      st.setCafOpen(true)
      return done()
    }
    if (k === '?') {
      st.setKeysOpen(!st.keysOpen)
      return done()
    }
    if (target?.key?.(k)) return done()
    if (/^[1-9]$/.test(k)) {
      const n = Number(k)
      if (n === 1) st.show({ kind: 'today' })
      else if (n === 2) st.show({ kind: 'local' })
      else {
        const s = st.sessions[n - 3]
        if (s) st.show({ kind: 'session', id: s.id })
      }
      return done()
    }
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
