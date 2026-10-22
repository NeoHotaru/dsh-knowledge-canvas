// `.then(onOk, onErr)` does not mean "handle failure".
//
// Its second argument catches a rejection that happened *before* it. A throw from inside onOk — which is
// where `unwrap` raises when a file is missing — passes straight through to the next handler up the chain.
//
// That is how a session with no list of its own announced "读不到知识库": the absent file threw inside onOk,
// the second argument did not catch it, and an outer catch reported a failure. The comment on that line had
// said "absent means no opinion" since it was written; the shape never did.
//
// The first version of this check flagged every two-argument `.then`, and all four in this codebase were
// legitimate — a callback that cannot throw is fine with a second argument. The rule is about semantics, not
// shape, so the check looks only for the shape that actually bites: an onOk that parses or unwraps, both of
// which raise on the error results these APIs return.
import { readFileSync } from 'node:fs'

const SOURCES = [
  'client.js',
  'index.js',
  'lib/outline.js',
  'lib/routes.js',
  'lib/state.js',
  'lib/store.js',
  'lib/tools.js',
  'lib/session.js',
  'lib/seed.js',
]

const ROOT = new URL('./', import.meta.url)

/** Calls that raise rather than return a value when the thing they were handed is an error. */
const THROWS = /\b(unwrap|JSON\.parse)\s*\(/

/** Blank comments and string-ish text, keeping offsets, so a comma inside one is not counted. */
function blank(source) {
  const out = source.split('')
  const wipe = (from, to) => {
    for (let at = from; at < to && at < out.length; at += 1) if (out[at] !== '\n') out[at] = ' '
  }
  let index = 0
  let previous = ''
  while (index < source.length) {
    const ch = source[index]
    const next = source[index + 1]
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      wipe(index, end === -1 ? source.length : end)
      index = end === -1 ? source.length : end
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      wipe(index, end === -1 ? source.length : end + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (ch === '/' && (previous === '' || '([{,;=:!&|?+-*%~^<>'.includes(previous))) {
      let at = index + 1
      let inClass = false
      while (at < source.length) {
        if (source[at] === '\\') at += 2
        else if (source[at] === '[') { inClass = true; at += 1 }
        else if (source[at] === ']') { inClass = false; at += 1 }
        else if (source[at] === '/' && !inClass) break
        else if (source[at] === '\n') break
        else at += 1
      }
      let flags = at + 1
      while (flags < source.length && /[a-z]/.test(source[flags])) flags += 1
      wipe(index, flags)
      index = flags
      previous = '/'
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let at = index + 1
      while (at < source.length) {
        if (source[at] === '\\') at += 2
        else if (source[at] === ch) break
        else if (source[at] === '\n' && ch !== '`') break
        else at += 1
      }
      wipe(index, at + 1)
      index = at + 1
      previous = ch
      continue
    }
    if (!/\s/.test(ch)) previous = ch
    index += 1
  }
  return out.join('')
}

const problems = []
for (const file of SOURCES) {
  const raw = readFileSync(new URL(file, ROOT), 'utf8')
  const code = blank(raw)
  const rawLines = raw.split('\n')
  const lines = code.split('\n')

  for (let at = 0; at < lines.length; at += 1) {
    for (const match of lines[at].matchAll(/\.then\s*\(/g)) {
      // Walk the argument list to find the comma that separates the two callbacks, and keep the text of the
      // first one so it can be judged.
      let depth = 1
      let line = at
      let column = match.index + match[0].length
      let split = null
      const first = []
      while (line < lines.length && depth > 0) {
        const text = lines[line]
        while (column < text.length) {
          const ch = text[column]
          if (ch === '(' || ch === '[' || ch === '{') depth += 1
          else if (ch === ')' || ch === ']' || ch === '}') {
            depth -= 1
            if (depth === 0) break
          } else if (ch === ',' && depth === 1) {
            split = { line, column }
            break
          }
          if (split === null) first.push(ch)
          column += 1
        }
        if (split) break
        line += 1
        column = 0
      }
      // Only the first callback matters, and only when it raises on an error result.
      if (split && THROWS.test(first.join(''))) {
        problems.push({ file, line: at + 1, text: rawLines[at].trim().slice(0, 96) })
      }
    }
  }
}

if (problems.length === 0) {
  console.log('  ok   no .then parses in its first callback and handles failure in its second')
  process.exit(0)
}
console.log('  FAIL a throw from these .then first callbacks escapes their second argument:')
for (const problem of problems) {
  console.log('    ' + problem.file + ':' + problem.line)
  console.log('        ' + problem.text)
}
process.exit(1)
