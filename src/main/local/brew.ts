import { execFile } from 'node:child_process'
import type { InfraService } from '@shared/local'
import { shellEnv, which } from '../shell-env'

async function brew(args: string[]): Promise<string | null> {
  const env = await shellEnv()
  const bin = which('brew', env)
  if (!bin) return null
  return new Promise((done) => execFile(bin, args, { env, timeout: 30_000 }, (err, stdout) => done(err ? null : stdout)))
}

export async function infraStatus(names: string[]): Promise<InfraService[]> {
  const out = await brew(['services', 'list', '--json'])
  const list = out ? (JSON.parse(out) as { name: string; status: string }[]) : []
  return names.map((name) => ({ name, status: list.find((s) => s.name === name)?.status ?? 'unknown' }))
}

export async function startInfra(name: string): Promise<boolean> {
  return (await brew(['services', 'start', name])) !== null
}
