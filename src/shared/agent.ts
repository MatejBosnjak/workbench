// Picker options for Claude Code. `value` is what goes to --model / --effort / --permission-mode.

export const MODELS = [
  { value: 'opus[1m]', label: 'Opus 5.5 · 1M', short: 'opus-5.5 1M', note: 'Default for coding sessions' },
  { value: 'opus', label: 'Opus 5.5 · 200K', short: 'opus-5.5', note: 'Smaller context, compacts sooner' },
  { value: 'sonnet', label: 'Sonnet 5.5', short: 'sonnet-5.5', note: 'Faster, lighter on the 5h limit' },
  { value: 'haiku', label: 'Haiku 5.5', short: 'haiku-5.5', note: 'Quick lookups and triage' },
  { value: 'fable', label: 'Fable 5.1', short: 'fable-5.1', note: 'Most capable, heaviest on limits' },
] as const

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const MODES = [
  { value: 'manual', label: 'ask' },
  { value: 'auto', label: 'auto' },
  { value: 'acceptEdits', label: 'accept edits' },
  { value: 'plan', label: 'plan' },
  { value: 'bypassPermissions', label: 'bypass' },
] as const

/** Whether a statusline model id (e.g. `claude-opus-5-5[1m]`) is what the alias selects. */
export function modelMatches(alias: string, id: string | undefined): boolean {
  if (!id) return false
  const [family = '', ctx] = alias.split('[')
  return id.includes(family) && id.endsWith('[1m]') === (ctx === '1m]')
}

/** The picker option a statusline model id corresponds to. */
export function modelFromId(id: string | undefined): (typeof MODELS)[number] | undefined {
  return MODELS.find((m) => modelMatches(m.value, id))
}

export interface AgentSettings {
  model: string | null
  effort: string | null
  permissionMode: string | null
}

/** How a picker change reached the session. */
export type ApplyResult = 'restarted' | 'pending' | 'saved'
