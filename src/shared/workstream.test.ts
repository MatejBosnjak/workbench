import { describe, expect, it } from 'vitest'
import { itemRepos, repoFromTitle, withoutRepoPrefix, rootOf, slug, subtree, timeline, treeOrder, type WsPr, type WsTask } from './workstream'

const t = (id: string, parentId: string | null, p: Partial<WsTask> = {}): WsTask => ({
  id,
  number: null,
  title: id,
  milestone: false,
  projectId: 'p',
  projectName: 'P',
  taskListId: null,
  taskListName: null,
  parentId,
  statusName: 'Working',
  statusCategory: 2,
  statusColorId: null,
  dueDate: null,
  lastActivityAt: null,
  placement: 0,
  url: '',
  context: false,
  depth: 0,
  assignee: null,
  mine: false,
  closed: false,
  createdAt: null,
  ...p,
})

describe('rootOf', () => {
  it('climbs to the topmost known parent', () => {
    const tasks = [t('M', null), t('A', 'M'), t('A1', 'A'), t('X', 'unknown')]
    expect(rootOf('A1', tasks)).toBe('M')
    expect(rootOf('X', tasks)).toBe('X')
    expect(rootOf('M', tasks)).toBe('M')
  })
})

describe('treeOrder', () => {
  it('walks depth-first by placement and drops strays', () => {
    const out = treeOrder('M', [t('B', 'M', { placement: 2 }), t('A', 'M', { placement: 1 }), t('A1', 'A'), t('M', null), t('Z', 'other')])
    expect(out.map((x) => [x.id, x.depth])).toEqual([
      ['M', 0],
      ['A', 1],
      ['A1', 2],
      ['B', 1],
    ])
    expect([...subtree({ tasks: out }, 'A')]).toEqual(['A', 'A1'])
  })
})

describe('timeline', () => {
  it('merges sessions, PRs and task history in time order, skipping closed tasks nobody worked on', () => {
    const tasks = treeOrder('M', [t('M', null), t('A', 'M', { mine: true }), t('B', 'M', { closed: true }), t('C', 'M', { closed: true })])
    const pr: WsPr = { url: 'u', repo: 'o/fe', repoName: 'fe', number: 1, title: 'x', state: 'MERGED', draft: false, branch: 'b', createdAt: '2026-10-02T00:00:00Z', mergedAt: '2026-10-04T00:00:00Z', closedAt: '2026-10-04T00:00:00Z', taskIds: ['C'] }
    const items = timeline(
      {
        rootId: 'M',
        tasks,
        prs: [pr],
        activity: [
          { at: '2026-10-01T00:00:00Z', taskId: 'A', kind: 'created' },
          { at: '2026-10-05T00:00:00Z', taskId: 'B', kind: 'status', from: 'Working', to: 'Done' },
          { at: '2026-10-06T00:00:00Z', taskId: 'C', kind: 'status', from: 'Working', to: 'Done' },
        ],
      },
      [
        { sessionId: 's1', taskId: 'M', startedAt: Date.parse('2026-10-03T00:00:00Z') },
        { sessionId: 's1', taskId: 'A', startedAt: Date.parse('2026-10-03T00:00:00Z') },
      ],
    )
    expect(items.map((i) => `${i.kind}:${i.taskId}${i.kind === 'pr' ? `:${i.what}` : ''}`)).toEqual(['task:A', 'pr:C:opened', 'session:A', 'pr:C:merged', 'task:C'])
  })
})

describe('slug', () => {
  it('makes a short ascii name from a task title', () => {
    expect(slug('FE: Service markup in fixed amount — rate cards (Add from rate card)')).toBe('service-markup-fixed-amount-rate-cards')
    expect(slug('Scenarios: različita marža u pregledu')).toBe('scenarios-razlicita-marza-pregledu')
  })
})

describe('repoFromTitle', () => {
  it('reads the prefix, and nothing without one', () => {
    expect(repoFromTitle('FE: Sharing link')).toBe('frontend')
    expect(repoFromTitle('[BE] Public reject API')).toBe('api')
    expect(repoFromTitle('E2E: proposals')).toBe('e2e-tests')
    expect(repoFromTitle('PM: confirm email')).toBeNull()
    expect(repoFromTitle('Proposals v2')).toBeNull()
  })
})

describe('itemRepos', () => {
  const ghPr = (repoName: string, taskIds: string[]) => ({ repoName, taskIds }) as WsPr
  const ws = {
    rootId: 'M',
    tasks: [t('M', null, { title: 'Proposals v2' }), t('A', 'M', { title: 'BE: Reject API' }), t('A1', 'A', { title: 'Reject email' }), t('B', 'M', { title: 'Copy review' }), t('C', 'M', { title: 'FE: Sharing link' })],
    prs: [ghPr('frontend', ['C']), ghPr('ai-agent', ['C']), ghPr('specs', ['M'])],
  }
  it("uses a PR's own repo, the task's PRs, then the title prefix up the tree, never the root's PRs", () => {
    expect(itemRepos({ kind: 'pr', at: 0, taskId: 'C', pr: ghPr('api', ['C']), what: 'opened' }, ws)).toEqual(['api'])
    expect(itemRepos({ kind: 'session', at: 0, taskId: 'C', sessionId: 's' }, ws)).toEqual(['frontend', 'ai-agent'])
    expect(itemRepos({ kind: 'task', at: 0, taskId: 'A1', text: '', chip: 'TASK' }, ws)).toEqual(['api'])
    expect(itemRepos({ kind: 'task', at: 0, taskId: 'B', text: '', chip: 'TASK' }, ws)).toEqual([])
  })
})

describe('withoutRepoPrefix', () => {
  it('drops a repo prefix and keeps other titles whole', () => {
    expect(withoutRepoPrefix('FE: Service markup in fixed amount')).toBe('Service markup in fixed amount')
    expect(withoutRepoPrefix('AI agent: proposals skill')).toBe('proposals skill')
    expect(withoutRepoPrefix('[BE] Public reject API')).toBe('Public reject API')
    expect(withoutRepoPrefix('PM: confirm own login email')).toBe('PM: confirm own login email')
    expect(withoutRepoPrefix('Proposals v2')).toBe('Proposals v2')
  })
})
