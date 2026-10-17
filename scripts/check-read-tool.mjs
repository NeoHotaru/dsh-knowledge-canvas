// What does the read tool actually hand back now? Print o4's entry and check the body survives intact.
import { readFileSync } from 'node:fs'
import { describeBase } from '../lib/store.js'

const base = JSON.parse(readFileSync('D:\\DeepSeekHarness\\.dsh-knowledge\\ops.json', 'utf8'))
const text = describeBase(base)

const lines = text.split('\n')
const at = lines.findIndex((line) => /^\s*- o4\s/.test(line))
console.log('=== o4 as the read tool now returns it ===')
for (const line of lines.slice(at, at + 12)) console.log(line)

console.log('')
console.log('=== checks ===')
const whole = lines.slice(at, at + 14).join('\n')
console.log('  mentions 必须重启应用 : %s', /必须重启应用/.test(whole))
console.log('  keeps the newlines    : %s', whole.split('\n').length > 3)
console.log('  total size of the view: %d chars', text.length)
