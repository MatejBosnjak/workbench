const SEGS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', '—': 'g', ' ': '',
}
const W = 30
const T = 6
const L = 54
const GAP = 12
// Each segment as a rect in a 30×54 digit box.
const RECTS: Record<string, [number, number, number, number]> = {
  a: [T, 0, W - 2 * T, T],
  g: [T, (L - T) / 2, W - 2 * T, T],
  d: [T, L - T, W - 2 * T, T],
  f: [0, T, T, (L - 3 * T) / 2],
  b: [W - T, T, T, (L - 3 * T) / 2],
  e: [0, (L + T) / 2, T, (L - 3 * T) / 2],
  c: [W - T, (L + T) / 2, T, (L - 3 * T) / 2],
}

/** Seven-segment LED digits (Ops console counters): lit segments in currentColor, unlit ones in --seg-off. */
export function SevenSeg({ value, digits = 2, height }: { value: string; digits?: number; height: number }) {
  const text = value.padStart(digits, ' ')
  const width = text.length * (W + GAP) - GAP + 8
  return (
    <svg className="seg7" height={height} width={(width * height) / L} viewBox={`0 0 ${width} ${L}`} role="img" aria-label={value}>
      <g transform="translate(6 0) skewX(-6)">
        {[...text].map((ch, i) =>
          Object.entries(RECTS).map(([k, [x, y, w, h]]) => (
            <rect key={`${i}${k}`} className={SEGS[ch]?.includes(k) ? 'on' : 'off'} x={x + i * (W + GAP) + 0.6} y={y + 0.6} width={w - 1.2} height={h - 1.2} rx={2} />
          )),
        )}
      </g>
    </svg>
  )
}
