import type { ITheme } from '@xterm/xterm'

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()

// ANSI colours mapped onto the theme's semantic tokens.
export function xtermTheme(): ITheme {
  return {
    background: css('bg'),
    foreground: css('text-2'),
    cursor: css('accent'),
    cursorAccent: css('bg'),
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
