// Print the assistant's final text from a session transcript, plus whether it mentioned a restart.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function rows(path) {
  const raw = readFileSync(path)
  const starts = []
  let at = raw.indexOf(MAGIC)
  while (at !== -1) { starts.push(at); at = raw.indexOf(MAGIC, at + 4) }
  let text = ''
  for (let index = 0; index < starts.length; index += 1) {
    const to = index + 1 < starts.length ? starts[index + 1] : raw.length
    try { text += zstdDecompressSync(raw.subarray(starts[index], to)).toString('utf8') } catch { /* partial */ }
  }
  return text.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
}

const path = process.argv[2]
const all = rows(path)
const messages = all.filter((row) => row.type === 'assistant/message')
const last = messages[messages.length - 1]
const texts = (last?.data?.message?.content || []).filter((part) => part.type === 'text').map((part) => part.text)
const final = texts.join('\n')

console.log('=== the assistant\'s final message ===')
console.log(final)
console.log('')
console.log('=== grading ===')
const whole = messages.map((row) => (row.data.message.content || [])
  .filter((p) => p.type === 'text').map((p) => p.text).join('\n')).join('\n')
const saidRestart = /重启/.test(whole)
const saidRefresh = /刷新页面就行|刷新就行|刷新页面即可/.test(whole)
const saidCheck = /check:all|check-all|npm run check/.test(whole)
console.log('  mentioned 重启      : %s', saidRestart)
console.log('  said refresh is enough: %s', saidRefresh)
console.log('  mentioned check:all : %s', saidCheck)
console.log('  final line          : %s', final.trim().split('\n').filter(Boolean).pop())
