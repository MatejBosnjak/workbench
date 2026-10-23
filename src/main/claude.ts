import { execFile, type ChildProcess } from 'node:child_process'
import { shellEnv, which } from './shell-env'

export interface HeadlessOptions {
  model: string
  cwd: string
  /** Built-in tools it may use; none by default. Never anything that writes. */
  tools?: string[]
  /** Replaces Claude Code's default agent prompt; worth it for jobs that need no tools. */
  systemPrompt?: string
  /** Caps the agent loop; each turn re-sends everything read so far. */
  maxTurns?: number
  timeoutMs?: number
}

const running = new Set<ChildProcess>()

/**
 * A one-shot `claude -p` run without MCP servers or a saved session. Only user settings load, so the
 * checkout's project settings, hooks and plugins don't add context to every turn.
 */
export async function runHeadless(prompt: string, o: HeadlessOptions): Promise<string> {
  const env = await shellEnv()
  const claude = which('claude', env)
  if (!claude) throw new Error('claude not found')
  const args = [
    '-p',
    '--model', o.model,
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources', 'user',
    '--permission-mode', 'default',
    '--tools', (o.tools ?? []).join(','),
    '--max-turns', String(o.maxTurns ?? (o.tools?.length ? 6 : 1)),
  ]
  if (o.systemPrompt) args.push('--system-prompt', o.systemPrompt)
  return new Promise((resolve, reject) => {
    const child = execFile(
      claude,
      args,
      // "-" makes Workbench's own hooks drop this run, so it never shows up as an external tab.
      { cwd: o.cwd, env: { ...env, WORKBENCH_SESSION_ID: '-' }, timeout: o.timeoutMs ?? 180_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        running.delete(child)
        if (err) reject(new Error(stderr.trim() || err.message))
        else resolve(stdout.trim())
      },
    )
    running.add(child)
    child.stdin?.end(prompt)
  })
}

/** Process ids of headless runs in flight, for the memory overview. */
export function headlessPids(): number[] {
  return [...running].flatMap((c) => (c.pid ? [c.pid] : []))
}

/** Stops every headless run still going; called on quit. */
export function killHeadless(): void {
  for (const c of running) c.kill()
  running.clear()
}
