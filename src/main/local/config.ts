import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Profile, ServiceDef } from '@shared/local'

export interface LocalConfig {
  services: ServiceDef[]
  profiles: Profile[]
  /** brew services shown as infra chips. */
  infra: string[]
}

const P = join(homedir(), 'Productive')

/** Seeded from the prd tmux script (~/.local/bin/productive-tmux.sh). */
export const DEFAULT_CONFIG: LocalConfig = {
  profiles: [
    { id: 'full', label: 'prd · full' },
    { id: 'frontend', label: 'Frontend only' },
    { id: 'ai', label: 'AI work' },
    { id: 'exports', label: 'Exports & PDF' },
  ],
  services: [
    {
      name: 'app',
      cwd: join(P, 'app'),
      command: 'pnpm start',
      port: 4201,
      url: 'http://app.productive.io.localhost:4201/',
      panes: 2,
      profiles: ['full', 'frontend', 'ai', 'exports'],
      repo: 'frontend',
    },
    { name: 'api', cwd: join(P, 'api'), command: 'bundle exec sidekiq', panes: 0, profiles: ['full', 'frontend', 'ai', 'exports'], repo: 'api' },
    { name: 'realtime', cwd: join(P, 'realtime'), command: 'npm start', port: 4220, panes: 0, profiles: ['full', 'frontend'] },
    { name: 'e2e-tests', cwd: join(P, 'e2e-tests'), command: 'npm run cli', panes: 1, profiles: ['full'], repo: 'e2e-tests' },
    { name: 'exporter', cwd: join(P, 'exporter'), command: 'npm run start', panes: 0, profiles: ['full', 'exports'] },
    { name: 'pdf-generator', cwd: join(P, 'pdf-generator'), command: 'npm run start', panes: 0, profiles: ['full', 'exports'] },
    { name: 'pdf-viewer', cwd: join(P, 'pdf-viewer'), command: 'npm run start', panes: 0, profiles: ['full', 'exports'] },
    {
      name: 'AI',
      cwd: join(P, 'ai-agent'),
      command: 'DEV_API_ENV=production pnpm start',
      panes: 1,
      profiles: ['full', 'ai'],
      repo: 'ai-agent',
    },
  ],
  infra: ['mysql@8.0', 'redis', 'memcached', 'meilisearch', 'nginx'],
}

/** Reads services.json, writing the default on first run so it can be edited by hand. */
export function loadConfig(file: string): LocalConfig {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n')
    return DEFAULT_CONFIG
  }
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as Partial<LocalConfig>
    return {
      services: c.services ?? DEFAULT_CONFIG.services,
      profiles: c.profiles ?? DEFAULT_CONFIG.profiles,
      infra: c.infra ?? DEFAULT_CONFIG.infra,
    }
  } catch (e) {
    console.warn('[local] bad services.json, using defaults:', (e as Error).message)
    return DEFAULT_CONFIG
  }
}
