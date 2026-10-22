import { execFile } from 'node:child_process'
import { shellEnv, which } from './shell-env'

export interface HeadlessOptions {
  model: string
  cwd: string
  /** Built-in tools it may use; none by default. Never anything that writes. */
  tools?: string[]
  timeoutMs?: number
}

/** A one-shot `claude -p` run without MCP servers or a saved session. */
export async function runHeadless(prompt: string, o: HeadlessOptions): Promise<string> {
  const env = await shellEnv()
  const claude = which('claude', env)
  if (!claude) throw new Error('claude not found')
  const args = ['-p', '--model', o.model, '--no-session-persistence', '--strict-mcp-config', '--permission-mode', 'default', '--tools', (o.tools ?? []).join(',')]
  return new Promise((resolve, reject) => {
    const child = execFile(
      claude,
      args,
      // "-" makes Workbench's own hooks drop this run, so it never shows up as an external tab.
      { cwd: o.cwd, env: { ...env, WORKBENCH_SESSION_ID: '-' }, timeout: o.timeoutMs ?? 180_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim())),
    )
    child.stdin?.end(prompt)
  })
}
