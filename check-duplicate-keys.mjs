// A key written twice in one object literal, where the second silently wins.
//
// That is how the node context menu was dead for two rounds: `onContextMenu` was declared at the top of the
// props object and again forty lines below, and JavaScript does not warn. The first handler never ran, every
// right-click fell through to the canvas, and the symptom — "右键出来的是新建节点" — pointed at the event
// system rather than at a duplicate key.
//
// Duplicate keys are legal in sloppy mode and a SyntaxError only in strict mode, which this bundle is not.
// The engine's silence is the whole problem, so the check looks for the pattern directly.
//
// Unlike a scope analysis, this needs no understanding of what the code means: one literal, one key list,
// compare. Braces are matched from every `{` that opens a literal at a value position, and the top level of
// that literal is where keys live — a nested object's keys belong to the nested object.
import { readFileSync } from 'node:fs'

const ROOT = 'D:/DeepSeekHarness/dsh-knowledge-tree/'
const FILES = ['client.js', 'index.js', 'lib/routes.js', 'lib/state.js', 'lib/store.js', 'lib/tools.js']

/** Blank comments, strings and regexes, keeping offsets, so punctuation inside them is not counted. */
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
for (const file of FILES) {
  let raw
  try {
    raw = readFileSync(ROOT + file, 'utf8')
  } catch {
    continue
  }
  const code = blank(raw)
  const lines = code.split('\n')
  const rawLines = raw.split('\n')
  // The flat character stream, so a literal spanning lines is read the same as one on a single line.
  const flat = code
  const lineOf = []
  let line = 1
  for (const ch of flat) {
    lineOf.push(line)
    if (ch === '\n') line += 1
  }

  for (let at = 0; at < flat.length; at += 1) {
    if (flat[at] !== '{') continue
    // A value position: `= {`, `({`, `, {`, `return {`, `=> ({`. A block would be preceded by `)` or `{`.
    const before = flat.slice(Math.max(0, at - 24), at)
    if (!/(=|\(|,|:|\breturn|\bor|=>)\s*$/.test(before)) continue
    // Walk to the matching close, and cut the top level into entries on commas.
    //
    // The first version aimed a regex backwards from each comma to find "the key", which reaches past the
    // entry it is looking at and picks up other keys — `{ ok: false, problem }` came back as `ok` twice —
    // and it counted nested objects as part of the outer one, so a table of four rows reported four `text`
    // keys. Splitting on the top-level commas and reading the head of each piece is exact, and needs none
    // of that guessing.
    let depth = 0
    let end = -1
    const entries = []
    let entryStart = at + 1
    for (let scan = at + 1; scan < flat.length; scan += 1) {
      const ch = flat[scan]
      if (ch === '{' || ch === '(' || ch === '[') depth += 1
      else if (ch === '}' || ch === ')' || ch === ']') {
        if (depth === 0) { entries.push(flat.slice(entryStart, scan)); end = scan; break }
        depth -= 1
      } else if (ch === ',' && depth === 0) {
        entries.push(flat.slice(entryStart, scan))
        entryStart = scan + 1
      }
    }
    if (end === -1) continue
    const seenHere = new Map()
    for (const entry of entries) {
      // A shorthand entry (`{ a, b }`) has no key to repeat; a computed one (`[x]:`) is not a literal key.
      const key = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/.exec(entry)
      if (!key) continue
      seenHere.set(key[1], (seenHere.get(key[1]) || 0) + 1)
    }
    for (const [name, count] of seenHere) {
      if (count < 2) continue
      problems.push({ file, line: lineOf[at], name, count, text: rawLines[lineOf[at] - 1].trim().slice(0, 88) })
    }
  }
}

// One report per key per literal: the walk above visits a literal once, but a nested one is visited again
// from its own opening brace, so the same key can arrive twice.
const seen = new Set()
const unique = problems.filter((problem) => {
  const tag = problem.file + ':' + problem.line + ':' + problem.name
  if (seen.has(tag)) return false
  seen.add(tag)
  return true
})

if (unique.length === 0) {
  console.log('  ok   no object literal writes the same key twice')
  process.exit(0)
}
console.log('  FAIL these literals write a key twice, so the later one silently wins:')
for (const problem of unique) {
  console.log(`    ${problem.file}:${problem.line}  "${problem.name}" x${problem.count}`)
  console.log('        ' + problem.text)
}
process.exit(1)
