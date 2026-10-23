import { describe, expect, it } from 'vitest'
import { breakdown, memoryColor, parsePs, shortSize, tree } from './memory'

const PS = `
  1     0   1000 /sbin/launchd
 100     1  320000 /Users/me/.local/share/claude/versions/2.1/claude
 101   100   50000 node
 102   100   48000 node
 103   101   10000 /bin/zsh
 200     1  90000 rails
`

describe('memory', () => {
  it('parses ps and walks a process tree', () => {
    const procs = parsePs(PS)
    expect(procs).toHaveLength(6)
    expect(tree(100, procs).map((p) => p.pid).sort()).toEqual([100, 101, 102, 103])
    expect(tree(999, procs)).toEqual([])
  })

  it('names the biggest kinds of process in a tree', () => {
    expect(breakdown(tree(100, parsePs(PS)))).toBe('claude 313 · node ×2 96 · zsh 10')
  })

  it('blends the glyph colour across RAM-relative steps', () => {
    const ram = 18 * 1024 // steps of 1.5 GB
    expect(memoryColor(300, ram, 'normal')).toBe('#CDB8F5')
    expect(memoryColor(2.25 * 1024, ram, 'normal')).toBe('color-mix(in oklab, #6B4FB0 0%, #A07EEA)')
    expect(memoryColor(3 * 1024, ram, 'normal')).toBe('color-mix(in oklab, #6B4FB0 50%, #A07EEA)')
    expect(memoryColor(20 * 1024, ram, 'normal')).toBe('#FF4D6A')
    expect(memoryColor(300, ram, 'critical')).toBe('#FF4D6A')
  })

  it('shortens sizes for the taskbar', () => {
    expect(shortSize(860)).toBe('860M')
    expect(shortSize(2468)).toBe('2.4G')
  })
})
