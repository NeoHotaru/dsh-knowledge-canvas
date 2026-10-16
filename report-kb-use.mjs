// Read the knowledge base activity log as a report.
//
// The two-day test asks a per-session question: did this conversation consult the base, and did it write
// anything afterwards. This prints exactly that, from the log the tools keep, and stops short of judging —
// "read but did not act" and "never had the answer in the base" look identical from here, and telling them
// apart needs a person.
//
//   node report-kb-use.mjs            every session in the log
//   node report-kb-use.mjs <prefix>   only sessions whose id starts with it
import { readFileSync } from 'node:fs'

const LOG = 'D:/DeepSeekHarness/.dsh-knowledge/activity.log'
const filter = process.argv[2] || ''

let text
try {
  text = readFileSync(LOG, 'utf8')
} catch {
  console.log('  no activity log yet at ' + LOG)
  console.log('  it appears the first time a knowledge tool runs in the app.')
  process.exit(0)
}

// `at | session | tool | base/node | ms outcome`, and the older `at | tool | base/node | …` before the
// session was recorded. Lines in the old shape are labelled rather than guessed at: attributing them to a
// tool name would be a wrong answer presented as a right one.
const TOOL_NAMES = new Set([
  'knowledge_read', 'knowledge_create_base', 'knowledge_write_node', 'knowledge_link',
  'knowledge_remove_node', 'knowledge_select', 'knowledge_remove_base',
])
const rows = []
let legacy = 0
for (const line of text.split('\n')) {
  if (!line.trim()) continue
  const parts = line.split('  |  ')
  if (parts.length < 4) continue
  if (TOOL_NAMES.has(parts[1])) {
    legacy += 1
    rows.push({ at: parts[0], session: '(写于记录会话之前)', tool: parts[1], what: parts[2], outcome: parts.slice(3).join('  |  ') })
    continue
  }
  rows.push({ at: parts[0], session: parts[1], tool: parts[2], what: parts[3], outcome: parts.slice(4).join('  |  ') })
}

if (rows.length === 0) {
  console.log('  the log has no parsable lines yet')
  process.exit(0)
}

const bySession = new Map()
for (const row of rows) {
  if (filter && !row.session.startsWith(filter)) continue
  if (!bySession.has(row.session)) bySession.set(row.session, [])
  bySession.get(row.session).push(row)
}

const WRITES = new Set(['knowledge_write_node', 'knowledge_create_base', 'knowledge_link'])

console.log('  ' + rows.length + ' tool call(s) in the log, ' + bySession.size + ' session(s)'
  + (legacy ? '，其中 ' + legacy + ' 行写于记录会话之前' : ''))
console.log('')

for (const [session, calls] of [...bySession.entries()].sort()) {
  const reads = calls.filter((call) => call.tool === 'knowledge_read')
  const writes = calls.filter((call) => WRITES.has(call.tool))
  const first = calls[0]
  const last = calls[calls.length - 1]

  console.log('  ' + session)
  console.log('    ' + first.at.slice(0, 16) + ' → ' + last.at.slice(0, 16) + '   ' + calls.length + ' call(s)')
  console.log('    读 ' + reads.length + ' 次' + (reads.length ? '（' + [...new Set(reads.map((r) => r.what))].join('、') + '）' : ''))
  console.log('    写 ' + writes.length + ' 次' + (writes.length ? '（' + [...new Set(writes.map((r) => r.what))].join('、') + '）' : ''))

  // The order is the part worth seeing: a write with no read before it means the model wrote from memory,
  // and the report says so rather than leaving the reader to compare timestamps.
  const firstRead = reads.length ? calls.indexOf(reads[0]) : -1
  const firstWrite = writes.length ? calls.indexOf(writes[0]) : -1
  if (firstWrite !== -1 && (firstRead === -1 || firstWrite < firstRead)) {
    console.log('    ⚠ 先写后读：第一次写入之前没有读过')
  }
  if (firstRead === -1 && writes.length > 0) {
    console.log('    ⚠ 全程没读：只写不读')
  }
  const failed = calls.filter((call) => call.outcome.includes('FAILED'))
  if (failed.length) {
    console.log('    失败 ' + failed.length + ' 次：' + [...new Set(failed.map((f) => f.outcome.slice(0, 60)))].join(' / '))
  }
  console.log('')
}

console.log('  说明：这个报告只给事实。')
console.log('  「读了没照做」和「库里根本没写这件事」在这里长得一样，要靠人分。')
