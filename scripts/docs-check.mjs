// Fails a commit that changes the UI or behaviour (src/) without touching docs/SPEC.md or docs/design/current/.
// Put [no-docs] in the commit message when the change really doesn't show (a refactor, a test, an internal fix).
// Usage: node scripts/docs-check.mjs <commit-msg-file>   (the commit-msg hook in .githooks/ calls it)
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const msg = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : ''
if (/\[no-docs\]/i.test(msg)) process.exit(0)
const files = execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' }).split('\n').filter(Boolean)
const code = files.filter((f) => /^src\/(renderer|main|shared)\//.test(f) && !/\.test\.ts$/.test(f))
const docs = files.some((f) => f === 'docs/SPEC.md' || f.startsWith('docs/design/current/'))
if (!code.length || docs) process.exit(0)
console.error(`docs-check: this commit changes ${code.length} source file(s) but not docs/SPEC.md or docs/design/current/.
  If it changes what the app does or looks like: update the screen's section in docs/SPEC.md and run \`pnpm snap <shot…>\`.
  If it doesn't (refactor, internal fix): add [no-docs] to the commit message.`)
process.exit(1)
