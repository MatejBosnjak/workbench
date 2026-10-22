import { describe, expect, it } from 'vitest'
import { groupTasks, taskIdsFromName, taskIdsFromText, type Task } from './tasks'

let n = 0
const task = (p: Partial<Task>): Task => ({
  id: String(++n),
  number: n,
  title: `t${n}`,
  milestone: false,
  projectId: 'p1',
  projectName: 'Platform: Frontend',
  taskListId: 'l1',
  taskListName: 'Sprint',
  parentId: null,
  statusName: 'To do',
  statusCategory: 1,
  statusColorId: null,
  dueDate: null,
  lastActivityAt: null,
  placement: n,
  url: '',
  context: false,
  ...p,
})

describe('groupTasks', () => {
  it('orders projects: Bugs, Product: CRM, then alphabetical', () => {
    const groups = groupTasks([
      task({ projectId: 'z', projectName: 'Zeta' }),
      task({ projectId: 'c', projectName: 'Product: CRM' }),
      task({ projectId: 'a', projectName: 'Alpha' }),
      task({ projectId: 'b', projectName: 'Bugs' }),
    ])
    expect(groups.map((g) => g.name)).toEqual(['Bugs', 'Product: CRM', 'Alpha', 'Zeta'])
  })

  it('nests subtasks by placement and hides a repeated task list', () => {
    const parent = task({ id: 'P', placement: 5 })
    const later = task({ parentId: 'P', placement: 30, taskListId: 'l2', taskListName: 'Other' })
    const sooner = task({ parentId: 'P', placement: 10 })
    const top = task({ placement: 1 })
    const lines = groupTasks([parent, later, sooner, top])[0]!.lines
    expect(lines.map((l) => [l.task.id, l.depth, l.list])).toEqual([
      [top.id, 0, 'Sprint'],
      ['P', 0, 'Sprint'],
      [sooner.id, 1, null],
      [later.id, 1, 'Other'],
    ])
  })

  it('shows context parents as headers and drops empty ones', () => {
    const ms = task({ id: 'M', milestone: true, context: true })
    const hidden = task({ id: 'H', context: true })
    const lonely = task({ id: 'L', context: true })
    const groups = groupTasks([ms, hidden, lonely, task({ parentId: 'M' }), task({ parentId: 'H' })])
    expect(groups[0]!.lines.filter((l) => l.header).map((l) => [l.task.id, l.header])).toEqual([
      ['M', 'milestone'],
      ['H', 'filtered'],
    ])
    expect(groups[0]!.count).toBe(2)
  })
})

describe('link inference', () => {
  it('finds task URLs in prompts', () => {
    const text = 'fix https://app.productive.io/109-productive/tasks/21071362 and https://app.productive.io/109-productive/projects/5/tasks/task/20794624?x=1'
    expect(taskIdsFromText(text)).toEqual(['21071362', '20794624'])
    expect(taskIdsFromText('see https://app.productive.io/109-productive/pages/123')).toEqual([])
  })

  it('finds known task ids in worktree and branch names', () => {
    const known = new Set(['21071362', '20794624'])
    expect(taskIdsFromName('/w/frontend-21071362-scenario-markup', known)).toEqual(['21071362'])
    expect(taskIdsFromName('feature/20794624-jira-connect', known)).toEqual(['20794624'])
    expect(taskIdsFromName('fix/12345678-unknown', known)).toEqual([])
    expect(taskIdsFromName('frontend-pr-30197', known)).toEqual([])
  })
})
