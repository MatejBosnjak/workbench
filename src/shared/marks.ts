/** A bookmark on a session's terminal: a prompt you sent, a Subagent result or a question Claude asked. */
export interface Mark {
  /** The transcript entry's uuid (a question's tool_use id). */
  id: string
  kind: 'prompt' | 'result' | 'question'
  /** First line with text, trimmed, at most 120 characters. */
  text: string
  /** Epoch ms. */
  at: number
}

export const MARK_LABEL: Record<Mark['kind'], string> = { prompt: 'Your prompt', result: 'Subagent result', question: 'Question' }

interface Entry {
  type?: string
  uuid?: string
  timestamp?: string
  isMeta?: boolean
  isCompactSummary?: boolean
  message?: { content?: string | { type: string; text?: string; name?: string; id?: string; input?: { questions?: { question?: string }[] } }[] }
  attachment?: { type?: string; prompt?: string; commandMode?: string }
}

const firstLine = (s: string) => {
  const line = s.split('\n').find((l) => l.trim()) ?? ''
  const t = line.replace(/\s+/g, ' ').trim()
  return t.length > 120 ? `${t.slice(0, 119)}…` : t
}

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')

/** A task notification's summary ("Agent "x" completed"), or null when the text isn't one. */
function notification(text: string): string | null {
  if (!text.trimStart().startsWith('<task-notification>')) return null
  const m = /<summary>([\s\S]*?)<\/summary>/.exec(text)
  return m ? unescape(m[1]!) : 'Task finished'
}

/** Your prompt, unless it's a slash command, a shell escape, interruption marker or other wrapped input. */
const isPrompt = (text: string) => !!text.trim() && !/^\s*</.test(text) && !text.startsWith('[Request interrupted')

/** Marks in a transcript's JSONL, oldest first. */
export function parseMarks(jsonl: string): Mark[] {
  const out: Mark[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"user"') && !line.includes('AskUserQuestion') && !line.includes('queued_command')) continue
    let e: Entry
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const at = e.timestamp ? Date.parse(e.timestamp) : 0
    const id = e.uuid ?? `${at}`
    const c = e.message?.content
    if (e.type === 'user' && !e.isMeta && !e.isCompactSummary) {
      const text = typeof c === 'string' ? c : (c ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
      const note = notification(text)
      if (note) out.push({ id, kind: 'result', text: firstLine(note), at })
      else if (isPrompt(text)) out.push({ id, kind: 'prompt', text: firstLine(text), at })
    } else if (e.type === 'attachment' && e.attachment?.type === 'queued_command' && e.attachment.prompt) {
      // A prompt (or a Subagent result) taken mid-turn.
      const note = notification(e.attachment.prompt)
      if (note) out.push({ id, kind: 'result', text: firstLine(note), at })
      else if (isPrompt(e.attachment.prompt)) out.push({ id, kind: 'prompt', text: firstLine(e.attachment.prompt), at })
    } else if (e.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'tool_use' && b.name === 'AskUserQuestion') out.push({ id: b.id ?? id, kind: 'question', text: firstLine(b.input?.questions?.[0]?.question ?? 'Question'), at })
      }
    }
  }
  return out
}

/** A terminal line that may hold a mark: its glyph and its text from there on, joined with the next lines. */
export interface Candidate {
  line: number
  glyph: string
  text: string
}

const GLYPH = /^\s{0,4}([❯⏺●⎿])\s*(?:·\s*)?(.*)$/
const norm = (s: string) =>
  s
    .replace(/\[Image #\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/** Reads the lines that start with one of Claude's glyphs. `line(i)` is the terminal's line i as text. */
export function candidates(count: number, line: (i: number) => string): Candidate[] {
  const out: Candidate[] = []
  for (let i = 0; i < count; i++) {
    const m = GLYPH.exec(line(i))
    if (!m) continue
    // A long prompt wraps onto the following lines.
    const text = norm([m[2]!, line(i + 1) ?? '', line(i + 2) ?? ''].map((l) => (GLYPH.test(l) ? '\u0000' : l)).join(' ').split('\u0000')[0]!)
    out.push({ line: i, glyph: m[1]!, text })
  }
  return out
}

const KEY = 32
const glyphFits = (kind: Mark['kind'], g: string) => (kind === 'prompt' ? g === '❯' : kind === 'result' ? g === '⏺' || g === '●' : g === '⎿')

function matches(m: Mark, c: Candidate): boolean {
  if (!glyphFits(m.kind, c.glyph)) return false
  const t = norm(m.text.replace(/…$/, ''))
  if (!t) return false
  const key = t.slice(0, KEY)
  if (!c.text.startsWith(key)) return false
  // A short prompt ("yes") must not match the start of a longer one ("yesterday…").
  return t.length > KEY || c.text.length === key.length || c.text[key.length] === ' '
}

/**
 * Finds each mark's line, newest first and walking up, so a history Claude reprinted is read from its latest copy.
 * Marks it can't find (scrolled out of the scrollback, or rendered differently) get no line.
 */
export function placeMarks(marks: Mark[], cands: Candidate[]): Map<string, number> {
  const out = new Map<string, number>()
  let j = cands.length - 1
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i]!
    for (let k = j; k >= 0; k--) {
      if (matches(m, cands[k]!)) {
        out.set(m.id, cands[k]!.line)
        j = k - 1
        break
      }
    }
  }
  return out
}

/**
 * Which mark ⌘[ / ⌘] go to. `lines`: each mark's line, in order. `top`: the line at the viewport's top.
 * `from`: the mark last jumped to while the user hasn't scrolled since, else null; a mark near the bottom
 * can't reach the top, so stepping by viewport alone would stall there.
 */
export function stepMark(lines: number[], top: number, dir: 1 | -1, from: number | null): number | null {
  if (lines.length === 0) return null
  if (from !== null && from >= 0 && from < lines.length) {
    const next = from + dir
    return next >= 0 && next < lines.length ? next : null
  }
  // A jump leaves one line of context above the mark.
  const at = top + 1
  if (dir === 1) {
    const i = lines.findIndex((l) => l > at)
    return i >= 0 ? i : null
  }
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]! < at) return i
  return null
}
