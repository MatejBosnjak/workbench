/** The app's looks. Dusk is the default; the others are the cassette-futurism set (docs/design/explore/Cassette*.dc.html; Night drive is the canvas's Cassette futurism 6 board). */
export const THEMES = [
  { id: 'dusk', name: 'Dusk', note: 'Muted synthwave on graphite' },
  { id: 'muthur', name: 'MU/TH/UR', note: 'Amber phosphor CRT, status codes' },
  { id: 'brown', name: 'Brown workstation', note: 'Smoked-brown keycaps, 70s stripes, LCD meters' },
  { id: 'console', name: 'Ops console', note: 'Dymo labels, seven-segment counts, lamps' },
  { id: 'night', name: 'Night drive', note: '80s digital dash: VFD cyan through smoked lenses, bar gauges' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

export const isTheme = (v: unknown): v is ThemeId => THEMES.some((t) => t.id === v)

const CODES: Record<string, string> = {
  working: 'WRK',
  'in progress': 'WRK',
  'peer review': 'REV',
  'code review': 'REV',
  review: 'REV',
  paused: 'PAU',
  backlog: 'BKL',
  triage: 'TRI',
  'on latest': 'LAT',
  'on production / followup': 'PRD',
  'on production': 'PRD',
  done: 'DNE',
  closed: 'CLS',
  blocked: 'BLK',
  'to do': 'TDO',
  'not started': 'NEW',
  qa: 'QA',
  'no status': '---',
}

/** A three-letter code for a Productive status, as MU/TH/UR prints statuses: known names by hand, else the first letters. */
export function statusCode(name: string | null | undefined): string {
  const n = (name || 'No status').trim().toLowerCase()
  if (CODES[n]) return CODES[n]
  const words = n.split(/[^a-z0-9]+/).filter(Boolean)
  if (words.length >= 3) return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase()
  if (words.length === 2) return (words[0]!.slice(0, 2) + words[1]![0]).toUpperCase()
  const w = words[0] ?? '---'
  // First letter, then the next consonants: "deployed" → DPL.
  const rest = w.slice(1).replace(/[aeiou]/g, '')
  return (w[0] + (rest.length >= 2 ? rest : w.slice(1))).slice(0, 3).toUpperCase()
}
