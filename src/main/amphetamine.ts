import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const APP = '/Applications/Amphetamine.app'
/** Installed by Amphetamine's Power Protect; without it, Apple Silicon asks for a password on every session. */
const POWER_PROTECT = join(homedir(), 'Library', 'Application Scripts', 'com.if.Amphetamine', 'powerProtect.scpt')

function tell(script: string, timeout = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', `tell application "Amphetamine" to ${script}`], { timeout }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim()),
    )
  })
}

export interface AmphetamineSetup {
  ready: boolean
  /** What's missing, for the Set up hint. */
  missing: string | null
}

/**
 * Installed and Power Protect present. Scripting access is checked when a session starts: the first
 * call makes macOS ask once for Automation access, and asking at app launch would be a surprise.
 */
export function amphetamineSetup(): AmphetamineSetup {
  if (!existsSync(APP)) return { ready: false, missing: 'Amphetamine is not installed' }
  if (!existsSync(POWER_PROTECT)) return { ready: false, missing: "Amphetamine's Power Protect isn't installed" }
  return { ready: true, missing: null }
}

export const amphetamineActive = async () => (await tell('session is active')) === 'true'

/** Starts an indefinite session that keeps running with the display closed. */
export async function amphetamineStart(): Promise<void> {
  await tell('start new session with options {duration:0, interval:0, displaySleepAllowed:true}')
  await tell('enable closed display mode')
}

export async function amphetamineEnd(): Promise<void> {
  await tell('end session')
}
