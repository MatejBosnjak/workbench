import { describe, expect, it } from 'vitest'
import type { Pr } from './git'
import { markOf, prSessions, prTasks, sessionTaskIds, taskSessions } from './links'
import type { Task, TaskLink, TasksSnapshot } from './tasks'
import type { Session } from './types'

const task = (id: string, context = false) => ({ id, context, title: id }) as Task
const link = (sessionId: string, taskId: string, lastEventAt: number, createdAt = 0): TaskLink => ({
  sessionId,
  taskId,
  via: 'branch',
  createdBy: 'auto',
  createdAt,
  session: { title: `stored ${sessionId}`, state: 'idle', alive: false, open: false, lastEventAt, firstPrompt: null },
})
const session = (id: string, state: Session['state'], alive: boolean, lastEventAt: number) => ({ id, title: `tab ${id}`, state, alive, lastEventAt }) as Session
const snap = (tasks: Task[], links: TaskLink[]): TasksSnapshot => ({ tasks, links, fetchedAt: 1, error: null, loading: false, summaries: {} })

describe('markOf', () => {
  it('uses the tab state while the tab is open, idle once claude exited, closed without a tab', () => {
    expect(markOf(session('a', 'running', true, 0))).toBe('running')
    expect(markOf(session('a', 'waiting', true, 0))).toBe('waiting')
    expect(markOf(session('a', 'running', false, 0))).toBe('idle')
    expect(markOf(undefined)).toBe('closed')
  })
})

describe('taskSessions', () => {
  it('puts live sessions first, then the most recent, and prefers the open tab over the stored row', () => {
    const s = snap([task('T')], [link('old', 'T', 300), link('live', 'T', 100), link('closed', 'T', 200)])
    const out = taskSessions('T', s, [session('live', 'waiting', true, 150), session('old', 'idle', true, 300)])
    expect(out.map((x) => [x.id, x.mark])).toEqual([
      ['live', 'waiting'],
      ['old', 'idle'],
      ['closed', 'closed'],
    ])
    expect(out[0]!.title).toBe('tab live')
    expect(out[2]!.title).toBe('stored closed')
  })
})

describe('prTasks and prSessions', () => {
  const pr = { taskRefs: ['T', 'C'], url: 'u' } as Pr
  it('skips parents shown only for context', () => {
    expect(prTasks(pr, snap([task('T'), task('C', true)], [])).map((t) => t.id)).toEqual(['T'])
  })
  it('adds sessions working on the PR that are not linked to its task, once each', () => {
    const s = snap([task('T')], [link('a', 'T', 10)])
    const out = prSessions(pr, 'u', s, [session('a', 'idle', true, 10), session('b', 'running', true, 5)], { a: { url: 'u' }, b: { url: 'u' } })
    expect(out.map((x) => x.id)).toEqual(['b', 'a'])
  })
})

describe('sessionTaskIds', () => {
  it('lists the latest link first', () => {
    expect(sessionTaskIds(snap([], [link('s', 'A', 0, 1), link('s', 'B', 0, 2), link('x', 'C', 0, 3)]), 's')).toEqual(['B', 'A'])
  })
})
