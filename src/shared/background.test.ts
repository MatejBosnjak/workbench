import { describe, expect, it } from 'vitest'
import { scanBackground, type BackgroundTask } from './background'

const line = (o: object) => JSON.stringify(o)
const launch = (id: string, name: string, input: object, result: object, ts = '2026-10-27T09:00:00Z') =>
  [
    line({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name, input }] } }),
    line({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id }] }, toolUseResult: result }),
  ].join('\n')
const done = (id: string) => line({ type: 'user', message: { content: `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>` } })

describe('scanBackground', () => {
  it('keeps background launches until their notification names them', () => {
    const pending = new Map<string, BackgroundTask>()
    const names = new Map<string, string>()
    scanBackground(
      [
        launch('toolu_A', 'Bash', { command: 'pnpm e2e', description: 'Run e2e' }, { backgroundTaskId: 'b1' }),
        launch('toolu_B', 'Agent', { description: 'Review the diff' }, { status: 'async_launched', agentId: 'a1' }),
        launch('toolu_C', 'Bash', { command: 'ls' }, { stdout: 'x' }),
      ].join('\n'),
      pending,
      names,
    )
    expect([...pending.values()].map((t) => t.text)).toEqual(['Run e2e', 'Review the diff'])
    expect(names.size).toBe(0)
    scanBackground(done('toolu_A'), pending, names)
    expect([...pending.keys()]).toEqual(['toolu_B'])
    scanBackground(line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_D', name: 'TaskStop', input: { task_id: 'a1' } }] } }), pending, names)
    expect(pending.size).toBe(0)
  })
})
