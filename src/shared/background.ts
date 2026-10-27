/** A task claude started in the background (Bash with run_in_background, an async Agent) that hasn't reported back. */
export interface BackgroundTask {
  /** The launching tool_use id; the task's notification names it. */
  id: string
  /** Claude's task id (backgroundTaskId / agentId); TaskStop names it. */
  taskId: string
  text: string
  /** Epoch ms. */
  at: number
}

interface Entry {
  type?: string
  timestamp?: string
  message?: { content?: string | { type: string; id?: string; name?: string; tool_use_id?: string; text?: string; input?: { description?: string; command?: string; task_id?: string } }[] }
  toolUseResult?: { backgroundTaskId?: string; agentId?: string; status?: string }
  attachment?: { type?: string; prompt?: string }
}

const short = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 80 ? `${t.slice(0, 79)}…` : t
}

/**
 * Reads appended transcript lines into `pending`: a background launch adds its tool_use id, its
 * <task-notification> (naming the same <tool-use-id>) or a TaskStop of it removes it. `names` keeps launch descriptions between calls.
 */
export function scanBackground(jsonl: string, pending: Map<string, BackgroundTask>, names: Map<string, string>): void {
  for (const line of jsonl.split('\n')) {
    if (!line.includes('tool_use') && !line.includes('tool-use-id')) continue
    let e: Entry
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    for (const m of line.matchAll(/<tool-use-id>(toolu_[A-Za-z0-9]+)<\/tool-use-id>/g)) pending.delete(m[1]!)
    const c = e.message?.content
    if (!Array.isArray(c)) continue
    if (e.type === 'assistant') {
      for (const b of c) {
        if (b.type !== 'tool_use' || !b.id) continue
        if (b.name === 'Bash' || b.name === 'Agent') names.set(b.id, short(b.input?.description || b.input?.command || b.name))
        // A stopped task sends no notification.
        if (b.name === 'TaskStop') for (const t of pending.values()) if (t.taskId === b.input?.task_id) pending.delete(t.id)
      }
    } else if (e.type === 'user') {
      const r = e.toolUseResult
      const taskId = r?.backgroundTaskId ?? (r?.status === 'async_launched' ? r.agentId : undefined)
      for (const b of c) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue
        const id = b.tool_use_id
        if (taskId) pending.set(id, { id, taskId, text: names.get(id) ?? 'Background task', at: e.timestamp ? Date.parse(e.timestamp) : 0 })
        names.delete(id)
      }
    }
  }
}
