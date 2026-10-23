import { describe, expect, it } from 'vitest'
import { prLinks } from './components/PrLinks'

const task = (id: string, extra = {}) => ({ id, number: 1, title: `t${id}`, milestone: false, projectId: 'p', projectName: 'P', taskListId: null, taskListName: null, parentId: null, statusName: 'Peer Review', statusCategory: 2, statusColorId: '5', dueDate: null, lastActivityAt: null, placement: 0, url: '', context: false, ...extra })
const link = (sessionId: string, taskId: string, state: string, lastEventAt: number) => ({ sessionId, taskId, via: 'x', createdBy: 'manual' as const, createdAt: 1, session: { title: `s ${sessionId}`, state, alive: false, open: false, lastEventAt, firstPrompt: null } })
const session = (id: string, state: string, lastEventAt: number) => ({ id, cwd: '/', title: `tab ${id}`, state, alive: true, external: false, startedAt: 1, lastEventAt, model: null, effort: null, permissionMode: null }) as never
const pr = { taskRefs: ['10'] } as never

describe('prLinks', () => {
  it('finds the PR’s task, its sessions (running first) and sessions working on the PR', () => {
    const tasks = { tasks: [task('10'), task('11')], links: [link('a', '10', 'idle', 9), link('b', '10', 'running', 1), link('c', '11', 'running', 5)], fetchedAt: 1, error: null, loading: false, summaries: {} }
    const r = prLinks(pr, 'u', tasks, [session('b', 'running', 1), session('d', 'idle', 3)], { d: { url: 'u' }, b: { url: 'u' } })
    expect(r.tasks.map((t) => t.id)).toEqual(['10'])
    expect(r.sessions.map((s) => [s.id, s.open])).toEqual([
      ['b', true],
      ['a', false],
      ['d', true],
    ])
  })

  it('has nothing for a PR without task refs or focus', () => {
    expect(prLinks(undefined, 'u', null, [], {})).toEqual({ tasks: [], sessions: [] })
  })
})
