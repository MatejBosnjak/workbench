/**
 * Session colours tell open sessions apart; they say nothing about state (that's the tab's glyph). Each theme defines
 * --sess-0 … --sess-6 in muted tones kept away from the bright task-status colours; MU/TH/UR prints SESSION_SIGILS instead.
 */
export const SESSION_COLORS = 7

export const SESSION_SIGILS = ['▚', '▞', '▀', '▄', '▌', '▐', '▓'] as const

/**
 * The colour for a tab added after `open` (the open tabs' colours, in tab order): the one furthest round the palette
 * from the two tabs before it, then the least used, then the lowest.
 */
export function pickSessionColor(open: number[]): number {
  const near = open.slice(-2)
  let best = 0
  let bestScore = -Infinity
  for (let c = 0; c < SESSION_COLORS; c++) {
    const gap = near.length ? Math.min(...near.map((n) => Math.min(Math.abs(c - n), SESSION_COLORS - Math.abs(c - n)))) : SESSION_COLORS
    const used = open.filter((n) => n === c).length
    const score = gap * 10 - used * 25
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}
