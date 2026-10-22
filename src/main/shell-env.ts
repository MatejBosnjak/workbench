import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const MARKER = '__WORKBENCH_ENV__'

// The shell starts from only these, like a new terminal window, so nothing leaks in from
// whatever launched Workbench (e.g. CLAUDE_CODE_CHILD_SESSION when started from a claude session).
const BASE = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING']

let cached: Promise<Record<string, string>> | undefined

/**
 * The environment a login + interactive shell would have. An app started from Finder
 * gets a bare launchd environment, so PATH, nvm, and `.zprofile` exports are missing.
 */
export function shellEnv(): Promise<Record<string, string>> {
  cached ??= load()
  return cached
}

function load(): Promise<Record<string, string>> {
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-l', '-i', '-c', `printf '${MARKER}'; env -0`],
      { timeout: 10_000, maxBuffer: 10 * 1024 * 1024, env: { ...baseEnv(), DISABLE_AUTO_UPDATE: 'true' } },
      (err, stdout) => {
        const at = stdout?.indexOf(MARKER) ?? -1
        if (err || at < 0) {
          console.warn('[shell-env] login shell failed, using a minimal env:', err?.message)
          resolve({ ...baseEnv(), PATH: fallbackPath() })
          return
        }
        const env: Record<string, string> = {}
        for (const pair of stdout.slice(at + MARKER.length).split('\0')) {
          const eq = pair.indexOf('=')
          if (eq > 0) env[pair.slice(0, eq)] = pair.slice(eq + 1)
        }
        resolve(env)
      },
    )
  })
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  for (const k of BASE) if (process.env[k]) env[k] = process.env[k]
  return env
}

function fallbackPath(): string {
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')]
  return [...extra, '/usr/bin:/bin:/usr/sbin:/sbin'].join(delimiter)
}

export function which(bin: string, env: Record<string, string>): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const p = join(dir, bin)
    try {
      accessSync(p, constants.X_OK)
      return p
    } catch {
      // keep looking
    }
  }
  return undefined
}
