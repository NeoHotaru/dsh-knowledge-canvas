// The client sends actions over HTTP; the host has a dispatch that must know each one. Nothing
// checked that coupling, so a new action was written, tested at the function level, and still failed
// in the panel with 'unknown action "color"' because the dispatch was never reached.
//
// This compares the two files directly: every action the client posts must appear in the host's
// dispatch. It is a grep, not a proof, but it is exactly the class that slipped through.
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const routes = readFileSync(new URL('./lib/routes.js', import.meta.url), 'utf8')

const sent = new Set()
for (const match of client.matchAll(/post\(\s*'([a-z]+)'/g)) sent.add(match[1])

const handled = new Set()
for (const match of routes.matchAll(/action === '([a-z]+)'/g)) handled.add(match[1])

const unknown = [...sent].filter((action) => !handled.has(action))
const unused = [...handled].filter((action) => !sent.has(action))

console.log(`  client sends: ${[...sent].sort().join(', ')}`)
console.log(`  host handles: ${[...handled].sort().join(', ')}`)
if (unknown.length) {
  console.log(`  FAIL the host has no dispatch for: ${unknown.join(', ')}`)
  process.exit(1)
}
if (unused.length) {
  console.log(`  note: the host handles actions the client never sends: ${unused.join(', ')}`)
}
console.log('  ok   every action the client posts is dispatched')
