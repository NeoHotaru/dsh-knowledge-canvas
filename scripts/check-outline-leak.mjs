// Render the real `ops` base the way the system prompt does, and check whether any line still hands over the
// answer. This is the observation the experiment needed and could not get: if the outline still says
// "必须重启", then no task can separate the two arms.
import { readFileSync } from 'node:fs'
import { renderOutline } from '../lib/outline.js'

const workspace = 'D:\\DeepSeekHarness'
const base = JSON.parse(readFileSync(workspace + '\\.dsh-knowledge\\ops.json', 'utf8'))

const text = renderOutline([base], null)
const lines = text.split('\n')

console.log('=== the outline, line by line ===')
for (const line of lines) console.log('  ' + line)

console.log('')
console.log('=== does any line hand over the answer? ===')
const leaks = lines.filter((line) => /必须重启|重启应用|刷新页面就够/.test(line))
if (leaks.length === 0) {
  console.log('  no line names the action ✔ — the answer now lives only in the bodies')
} else {
  for (const line of leaks) console.log('  LEAK: ' + line)
}
