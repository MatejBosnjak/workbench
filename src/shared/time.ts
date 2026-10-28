import { isoDay } from './todos'

/** How long ago, in one unit: "now", "12m", "3h", "4d", "3mo". The exact time goes in a tooltip. */
export function age(at: string | number, now = Date.now()): string {
  const m = Math.floor((now - new Date(at).getTime()) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return d < 60 ? `${d}d` : `${Math.round(d / 30)}mo`
}

/** The exact time, for the tooltip behind an age. */
export const exact = (at: string | number) => new Date(at).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** A due day as a weekday and a distance: "today", "tomorrow", "Fri · in 2d", "3 Nov · in 9d", "late · 2d". */
export function dueText(day: string, now = new Date()): string {
  const today = isoDay(now)
  if (day === today) return 'today'
  const days = Math.round((new Date(`${day}T12:00`).getTime() - new Date(`${today}T12:00`).getTime()) / 86_400_000)
  if (days < 0) return `late · ${-days}d`
  if (days === 1) return 'tomorrow'
  const d = new Date(`${day}T12:00`)
  const name = days < 7 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  return `${name} · in ${days}d`
}
