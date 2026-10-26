import { mkdtempSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Pr } from '@shared/git'
import type { Task, TasksSnapshot } from '@shared/tasks'
import type { Session } from '@shared/types'
import { startSignalServer, stopSignalServer } from './signal-server'
import { runWb, type WbDeps } from './wb'

const task = { id: '20971870', title: 'Scenarios: data migracija', statusName: 'Peer Review', projectName: 'Bugs', taskListName: 'CRM', dueDate: null, url: 'https://app.productive.io/1-x/tasks/20971870', context: false } as Task
const pr = { url: 'https://github.com/productiveio/api/pull/24733', repoName: 'api', number: 24733, title: '[fix] Document used_quantity', ci: 'pass', reviewDecision: 'REVIEW_REQUIRED', draft: false, conflict: false, author: 'me', branch: 'fix/doc', taskRefs: ['20971870'], reviewers: [{ login: 'ana', avatar: '', state: 'waiting' }] } as unknown as Pr

function deps(calls: string[] = []): WbDeps {
  const snap = { tasks: [task], links: [{ sessionId: 's1', taskId: task.id }], fetchedAt: 1, error: null, loading: false, summaries: {} } as unknown as TasksSnapshot
  return {
    session: (id) => (id === 's1' ? ({ id: 's1', title: 'Scenarios', cwd: '/repo' } as Session) : undefined),
    tasks: () => snap,
    git: () => ({ viewer: 'me', mine: [pr], reviews: [], fetchedAt: 1, error: null, loading: false, seen: {} }) as never,
    runpr: () => null,
    branch: async () => 'fix/doc',
    linkPr: (s, u) => calls.push(`linkPr ${s} ${u}`),
    unlinkPr: (s, u) => calls.push(`unlinkPr ${s} ${u}`),
    linkTask: (s, t) => calls.push(`linkTask ${s} ${t}`),
    unlinkTask: (s, t) => calls.push(`unlinkTask ${s} ${t}`),
  }
}

describe('wb', () => {
  it('reports the session with its task and its task’s PR', async () => {
    const out = await runWb(deps(), 's1', 'status', [])
    expect(out).toContain('Workbench session "Scenarios" (tab s1)')
    expect(out).toContain('cwd /repo · branch fix/doc')
    expect(out).toContain('id 20971870 · Peer Review · Bugs › CRM')
    expect(out).toContain('api #24733 [fix] Document used_quantity')
    expect(out).toContain('CI passing · review required · reviewers: ana waiting')
  })

  it('links a pasted PR URL cleaned up, and only my tasks', async () => {
    const calls: string[] = []
    const d = deps(calls)
    expect(await runWb(d, 's1', 'link-pr', ['https://github.com/productiveio/api/pull/24733/files'])).toBe('linked https://github.com/productiveio/api/pull/24733')
    expect(await runWb(d, 's1', 'link-pr', ['nonsense'])).toMatch(/^error:/)
    expect(await runWb(d, 's1', 'link-task', ['20971870'])).toBe('linked task 20971870: Scenarios: data migracija')
    expect(await runWb(d, 's1', 'link-task', ['12345678'])).toMatch(/^error: task 12345678 is not one of my tasks/)
    expect(calls).toEqual(['linkPr s1 https://github.com/productiveio/api/pull/24733', 'linkTask s1 20971870'])
    expect(await runWb(d, 'nope', 'status', [])).toMatch(/^error:/)
  })

  it('answers over the socket, even when the client closes its side first', async () => {
    const sock = join(mkdtempSync(join(tmpdir(), 'wb-')), 's.sock')
    const server = startSignalServer(sock, () => {}, async (id, name, args) => `${id} ${name} ${args.join(',')}`)
    await new Promise((r) => server.once('listening', r))
    const reply = await new Promise<string>((resolve) => {
      let out = ''
      const c = connect(sock, () => c.end('cmd s1 link-pr a b\n'))
      c.on('data', (d) => (out += d))
      c.on('end', () => resolve(out))
    })
    stopSignalServer(server, sock)
    expect(reply).toBe('s1 link-pr a,b\n')
  })
})
