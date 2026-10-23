import { describe, expect, it } from 'vitest'
import { candidates, parseMarks, placeMarks, stepMark, type Mark } from './marks'

const jsonl = (...entries: object[]) => entries.map((e) => JSON.stringify(e)).join('\n')
const user = (uuid: string, content: unknown, extra = {}) => ({ type: 'user', uuid, timestamp: '2026-10-22T09:10:23.797Z', message: { role: 'user', content }, ...extra })

describe('parseMarks', () => {
  it('keeps prompts, task notifications and questions, oldest first', () => {
    const marks = parseMarks(
      jsonl(
        user('a', 'fix the rate rounding\nsecond line'),
        user('b', [{ type: 'tool_result', content: 'x' }]),
        user('c', '<command-name>/clear</command-name>'),
        user('d', 'injected', { isMeta: true }),
        user('e', [{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
        { type: 'assistant', uuid: 'f', timestamp: '2026-10-22T09:11:00Z', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which rounding?' }] } }] } },
        user('g', '<task-notification>\n<summary>Agent &quot;search callers&quot; completed</summary>\n</task-notification>'),
        { type: 'attachment', uuid: 'h', timestamp: '2026-10-22T09:12:00Z', attachment: { type: 'queued_command', prompt: 'draft comments' } },
        { type: 'attachment', uuid: 'i', timestamp: '2026-10-22T09:13:00Z', attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: '<task-notification><summary>Background command "pnpm i" completed (exit code 0)</summary></task-notification>' } },
      ),
    )
    expect(marks.map((m) => [m.id, m.kind, m.text])).toEqual([
      ['a', 'prompt', 'fix the rate rounding'],
      ['tu1', 'question', 'Which rounding?'],
      ['g', 'result', 'Agent "search callers" completed'],
      ['h', 'prompt', 'draft comments'],
      ['i', 'result', 'Background command "pnpm i" completed (exit code 0)'],
    ])
    expect(marks[0]!.at).toBe(Date.parse('2026-10-22T09:10:23.797Z'))
  })

  it('cuts long first lines to 120 characters', () => {
    const [m] = parseMarks(jsonl(user('a', 'x'.repeat(200))))
    expect(m!.text).toHaveLength(120)
    expect(m!.text.endsWith('…')).toBe(true)
  })
})

const screen = [
  '⏺ Bash(ls)',
  '  ⎿  a.ts',
  '',
  '❯ yesterday it broke',
  '',
  '⏺ Looking.',
  '❯ yes',
  '',
  '⏺ User answered Claude\'s questions:',
  '  ⎿  · Which rounding mode should invoices use? → half up',
  '',
  '⏺ Agent "search callers" completed',
  '❯ please make the change across every file that calls the old',
  '  helper and keep the tests green',
  '',
  '❯ ',
]
const cands = candidates(screen.length, (i) => screen[i] ?? '')
const mark = (id: string, kind: Mark['kind'], text: string): Mark => ({ id, kind, text, at: 0 })

describe('placeMarks', () => {
  it('finds each kind on its line and tells a short prompt from a longer one', () => {
    const placed = placeMarks(
      [
        mark('1', 'prompt', 'yesterday it broke'),
        mark('2', 'prompt', 'yes'),
        mark('3', 'question', 'Which rounding mode should invoices use?'),
        mark('4', 'result', 'Agent "search callers" completed'),
        mark('5', 'prompt', 'please make the change across every file that calls the old helper and keep the tests green'),
      ],
      cands,
    )
    expect([...placed]).toEqual([
      ['5', 12],
      ['4', 11],
      ['3', 9],
      ['2', 6],
      ['1', 3],
    ])
  })

  it('leaves out marks that scrolled away and keeps the order', () => {
    const placed = placeMarks([mark('0', 'prompt', 'something long gone'), mark('1', 'prompt', 'yes')], cands)
    expect([...placed]).toEqual([['1', 6]])
  })

  it('reads a reprinted history from its latest copy', () => {
    const twice = [...screen, ...screen]
    const placed = placeMarks([mark('2', 'prompt', 'yes')], candidates(twice.length, (i) => twice[i] ?? ''))
    expect(placed.get('2')).toBe(screen.length + 6)
  })
})

describe('stepMark', () => {
  const lines = [10, 50, 90]
  it('steps by viewport', () => {
    expect(stepMark(lines, 0, 1, null)).toBe(0)
    expect(stepMark(lines, 9, 1, null)).toBe(1)
    expect(stepMark(lines, 9, -1, null)).toBe(null)
    expect(stepMark(lines, 60, -1, null)).toBe(1)
  })
  it('steps from the last jump', () => {
    expect(stepMark(lines, 40, 1, 2)).toBe(null)
    expect(stepMark(lines, 40, -1, 2)).toBe(1)
  })
})
