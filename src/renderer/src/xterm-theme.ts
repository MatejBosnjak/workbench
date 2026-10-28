import type { ITheme } from '@xterm/xterm'

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()

// ANSI colours mapped onto the theme's semantic tokens. A session terminal sits on the lifted sheet (--term-sheet).
export function xtermTheme(sheet = false): ITheme {
  const ground = (sheet && css('term-sheet')) || css('bg')
  return {
    background: ground,
    foreground: css('text-2'),
    cursor: css('accent'),
    cursorAccent: ground,
    selectionBackground: css('accent-line'),
    black: css('line-heavy'),
    brightBlack: css('faint'),
    red: css('bad'),
    brightRed: css('bad'),
    green: css('ok'),
    brightGreen: css('ok'),
    yellow: css('warn'),
    brightYellow: css('warn'),
    blue: css('info'),
    brightBlue: css('link'),
    magenta: css('accent'),
    brightMagenta: css('violet'),
    cyan: css('teal'),
    brightCyan: css('link-hover'),
    white: css('text-2'),
    brightWhite: css('text'),
  }
}

/** The terminal face for the current theme: --term-font, --term-size (px), --term-line and --term-bold from the theme tokens.
 *  Session terminals are read, not scanned: they take the roomier --term-read-line. */
export function termFont(sheet = false): { fontFamily: string; fontSize: number; lineHeight: number; fontWeightBold: 'bold' | 'normal' } {
  return {
    fontFamily: css('term-font') || "'JetBrains Mono', ui-monospace, monospace",
    fontSize: Number(css('term-size')) || 13,
    lineHeight: Number(css(sheet ? 'term-read-line' : 'term-line')) || 1.25,
    // A bitmap-style face like VT323 smears when bolded synthetically.
    fontWeightBold: css('term-bold') === 'normal' ? 'normal' : 'bold',
  }
}
