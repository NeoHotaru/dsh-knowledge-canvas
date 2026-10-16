// A name read before it is declared, in the same block.
//
// This class has caused two render crashes tonight — `view` and then `post` — both in the client, both
// invisible to the other four checks, both found by the user looking at a broken panel.
//
// Rewritten from scratch. The previous attempt used "the nearest enclosing function" and produced three
// false positives, one for each of three different reasons, which is what got it unwired:
//
//   `function f(a, side = 0)`   the read and the "declaration" are on the same line
//   `'[data-node-id]'`          the name is inside a string literal
//   two `cursor`s               the same name in two sibling functions
//
// Braces answer all three, and they answer them without a parser. Every line gets a depth; a declaration is
// in scope from its own line downward, inside the block it sits in — the run of following lines whose depth
// stays at or above its own. A read is a problem only if it is inside that run and above the declaration.
//
// The one thing this cannot see is a read inside a nested callback defined above the declaration, because
// the callback's braces put it at a deeper depth and it stays inside the run. That is a miss, not a false
// alarm, which is the right way for a check to be wrong.
import { readFileSync } from 'node:fs'

const SOURCES = [
  'D:/DeepSeekHarness/dsh-knowledge-tree/client.js',
  'D:/DeepSeekHarness/dsh-knowledge-tree/index.js',
]

/** True where a value may begin, which is what decides whether a slash opens a regex. */
function startsValue(previous) {
  return previous === '' || '([{,;=:!&|?+-*%~^<>'.includes(previous) || previous === 'return'
}

/**
 * Replace comments, strings, template literals and regex literals with blanks, keeping offsets.
 *
 * The regex branch is the load-bearing one. Without it a quote inside a regex starts a string that runs to
 * the next quote anywhere in the file, and everything between becomes blank — which is exactly what
 * happened, and why this check missed a read of \`post\` that crashed the panel.
 */
function blankLiterals(source) {
  const out = source.split('')
  const blank = (from, to) => {
    for (let at = from; at < to && at < out.length; at += 1) if (out[at] !== '\n') out[at] = ' '
  }
  let index = 0
  let previous = ''
  while (index < source.length) {
    const ch = source[index]
    const next = source[index + 1]
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      blank(index, end === -1 ? source.length : end)
      index = end === -1 ? source.length : end
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      blank(index, end === -1 ? source.length : end + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    // A regex literal, if a value may begin here. Its flags come after the closing slash and are blanked
    // with it, because \`/^x$/i\` ends with an \`i\` that is not a name.
    if (ch === '/' && startsValue(previous)) {
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
      let flagged = at + 1
      while (flagged < source.length && /[a-z]/.test(source[flagged])) flagged += 1
      blank(index, flagged)
      index = flagged
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
      blank(index, at + 1)
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
  const raw = readFileSync(file, 'utf8')
  const code = blankLiterals(raw)
  const lines = code.split('\n')
  const rawLines = raw.split('\n')

  // The depth a line begins at. Braces, parens and brackets all count, so a declaration inside a call's
  // arguments is not confused with one at the statement level.
  const depthAt = []
  let depth = 0
  for (const line of lines) {
    depthAt.push(depth)
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') depth += 1
      else if (ch === '}' || ch === ')' || ch === ']') depth -= 1
    }
  }

  const declarations = []
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]
    // A loop head binds its variable for the loop alone, so it is never read above itself. Looking upward
    // from there can only find false positives, and it found five: `for (const base of …)` twice and
    // `for (const item of …)` three times.
    if (/^\s*for\s*\(/.test(line)) continue
    for (const match of line.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
      // Only when it is the name being bound, not a property access.
      declarations.push({ name: match[1], line: at, depth: depthAt[at], column: match.index })
    }
    for (const match of line.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) {
      declarations.push({ name: match[1], line: at, depth: depthAt[at], column: match.index })
    }
  }

  for (const declaration of declarations) {
    const { name } = declaration
    const pattern = new RegExp('(^|[^.\\w$])' + name.replace(/\$/g, '\\$') + '(?![\\w$])')
    for (let at = declaration.line - 1; at >= 0; at -= 1) {
      // Above the declaration's own depth means the block it lives in has ended.
      if (depthAt[at] < declaration.depth) break
      // Deeper than the declaration means a nested block: a function body evaluated when it is called, a
      // loop header, a call's arguments. Those run later, so the order here does not matter.
      if (depthAt[at] > declaration.depth) continue
      const line = lines[at]
      // A loop head that binds this very name is that loop's own variable, not a read of the declaration being
      // checked. `for (let i = a.length - 1; …)` above a later `let i = 0` looked exactly like a read of it.
      //
      // Only the name the head binds is skipped, not the whole line: `for (let j = i; …)` really does read an
      // outer `i`, and that is a genuine use-before-declare. Skipping every `for` line outright would have been
      // simpler and would have hidden it.
      const head = /^\s*for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)
      if (head && head[1] === name) continue
      const hit = pattern.exec(line)
      if (!hit) continue
      const rest = line.slice(hit.index + hit[0].length)
      // A key, a label, or a parameter name is not a read.
      if (/^\s*:/.test(rest)) continue
      problems.push({
        file: file.split('/').pop(),
        name,
        read: at + 1,
        declared: declaration.line + 1,
        text: rawLines[at].trim().slice(0, 92),
      })
      break
    }
  }
}

if (problems.length === 0) {
  console.log('  ok   no name is read in its own block before it is declared')
  process.exit(0)
}
console.log('  FAIL these names are read before they are declared, in the same block:')
for (const problem of problems) {
  console.log('    ' + problem.file + ':' + problem.read + '  ' + problem.name
    + '  (declared at ' + problem.declared + ')')
  console.log('        ' + problem.text)
}
process.exit(1)
