// Rejects a commit that changes src/ without updating the docs/SPEC.md sections that cover those files.
// A section covers the files on its `Code:` line. Screenshots alone don't count: with live data they change on every
// `pnpm snap`. Put [no-docs] in the commit message when the change really doesn't show (a refactor, a test, an internal fix).
// Usage: node scripts/docs-check.mjs <commit-msg-file>   (the commit-msg hook in .githooks/ calls it)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const SPEC = 'docs/SPEC.md'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })

const msg = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : ''
if (/\[no-docs\]/i.test(msg)) process.exit(0)
const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean)
const code = staged.filter((f) => /^src\/(renderer|main|shared)\//.test(f) && !/\.test\.ts$/.test(f))
if (!code.length) process.exit(0)

// The staged SPEC: each `## ` section with its line range and the files its Code: line names. Files on the
// "Code (plumbing …)" line change with most features, so any SPEC update covers them.
const lines = git('show', `:${SPEC}`).split('\n')
const sections = []
const plumbing = []
lines.forEach((l, i) => {
  if (l.startsWith('## ')) sections.push({ title: l.slice(3).trim(), from: i + 1, to: lines.length, files: [] })
  else if (sections.length) {
    sections.at(-1).to = i + 1
    const m = l.match(/Code( \(plumbing[^)]*\))?:(.*)$/)
    if (m) (m[1] ? plumbing : sections.at(-1).files).push(...[...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]))
  }
})
const covers = (entry, file) =>
  entry.endsWith('/') ? file.startsWith(entry) : entry.includes('/') ? file === entry || file.endsWith(`/${entry}`) : basename(file) === entry
const shared = code.filter((f) => plumbing.some((e) => covers(e, f)))
const owners = new Map(code.filter((f) => !shared.includes(f)).map((f) => [f, sections.filter((s) => s.files.some((e) => covers(e, f)))]))

// Which sections the staged SPEC diff touches (new-side line numbers of each hunk).
const touched = new Set()
if (staged.includes(SPEC)) {
  for (const m of git('diff', '--cached', '-U0', '--', SPEC).matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1])
    const end = start + Math.max(Number(m[2] ?? 1), 1) - 1
    for (const s of sections) if (start <= s.to && end >= s.from) touched.add(s.title)
  }
}

const missing = [...owners].filter(([, ss]) => ss.length && !ss.some((s) => touched.has(s.title)))
const unowned = [...owners].filter(([, ss]) => !ss.length).map(([f]) => f)
const loose = [...unowned, ...shared]
const specTouched = staged.includes(SPEC)
if (!missing.length && (specTouched || !loose.length)) {
  if (unowned.length) console.error(`docs-check: no SPEC section lists ${unowned.join(', ')} on its Code: line; add it to the right one.`)
  process.exit(0)
}

console.error('docs-check: this commit changes code but not the SPEC sections that describe it.')
for (const [f, ss] of missing) console.error(`  ${f} → ${ss.map((s) => `"## ${s.title}"`).join(' or ')}`)
if (unowned.length && !specTouched) console.error(`  ${unowned.join(', ')} → no section lists it; update the right section and add it to that section's Code: line`)
if (shared.length && !specTouched) console.error(`  ${shared.join(', ')} → plumbing; update whichever section's behaviour changed`)
console.error(`Update those sections in ${SPEC} (behaviour as built) and retake their screenshots with \`pnpm snap <shot…>\`.
If nothing visible or behavioural changed (refactor, internal fix), add [no-docs] to the commit message.`)
process.exit(1)
