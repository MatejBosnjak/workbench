import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'

/**
 * Service terminals run zsh with a ZDOTDIR of our own: each file sources the user's own (so the shell is the one they
 * know), and .zshrc adds two hooks that report each command line as it starts and its exit code when it ends, as
 * OSC `6973;wb;start;<line>` and `6973;wb;exit;<code>`. That's how a service started in the shell still has a status.
 */
const FILES: Record<string, string> = {
  '.zshenv': `WB_ZDOTDIR=$ZDOTDIR; ZDOTDIR=$WB_USER_ZDOTDIR; [[ -f $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv; WB_USER_ZDOTDIR=$ZDOTDIR; ZDOTDIR=$WB_ZDOTDIR\n`,
  '.zprofile': `ZDOTDIR=$WB_USER_ZDOTDIR; [[ -f $ZDOTDIR/.zprofile ]] && source $ZDOTDIR/.zprofile; ZDOTDIR=$WB_ZDOTDIR\n`,
  // ZDOTDIR stays the user's after this, so .zlogin and any nested zsh read their own files.
  '.zshrc': `ZDOTDIR=$WB_USER_ZDOTDIR; [[ -f $ZDOTDIR/.zshrc ]] && source $ZDOTDIR/.zshrc
__wb_pre() { __wb_ran=1; printf '\\e]6973;wb;start;%s\\a' "\${1//[[:cntrl:]]/ }" }
__wb_post() { local c=$?; [[ -n $__wb_ran ]] && printf '\\e]6973;wb;exit;%s\\a' $c; __wb_ran= }
preexec_functions+=(__wb_pre)
precmd_functions=(__wb_post $precmd_functions)
`,
}

let dir: string | undefined

/** The shell and env for a service terminal, or null when the login shell isn't zsh (then services run without one). */
export function serviceShell(env: Record<string, string>): { file: string; env: Record<string, string> } | null {
  const file = env.SHELL || '/bin/zsh'
  if (basename(file) !== 'zsh') return null
  if (!dir) {
    dir = join(app.getPath('userData'), 'zsh')
    mkdirSync(dir, { recursive: true })
    for (const [name, text] of Object.entries(FILES)) writeFileSync(join(dir, name), text)
  }
  return { file, env: { ...env, ZDOTDIR: dir, WB_USER_ZDOTDIR: env.ZDOTDIR || env.HOME || '' } }
}

const MARK = /\x1b\]6973;wb;(start|exit);([^\x07]*)\x07/g

/** Pulls the markers out of a chunk of output: what's left to show, and the events in order. */
export function readMarks(data: string): { data: string; marks: { kind: 'start' | 'exit'; value: string; at: number }[] } {
  const marks: { kind: 'start' | 'exit'; value: string; at: number }[] = []
  let out = ''
  let last = 0
  for (const m of data.matchAll(MARK)) {
    out += data.slice(last, m.index)
    marks.push({ kind: m[1] as 'start' | 'exit', value: m[2]!, at: out.length })
    last = m.index! + m[0].length
  }
  return { data: marks.length ? out + data.slice(last) : data, marks }
}
