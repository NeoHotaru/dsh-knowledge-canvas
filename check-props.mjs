// A component that is handed a prop it never takes.
//
// `h(NodeBox, { …, boxWidth })` with a signature that destructures everything except boxWidth put
// "boxWidth is not defined" on screen at render. Five checks missed it: the identifier check only asks
// whether a name exists anywhere in the file, the scope check's list is hand-written, the load check
// never renders, and it is neither a TDZ nor an action. What it actually is, is two lists that have to
// match — the keys at the call site and the names in the signature — and that is checkable exactly.
import { readFileSync } from 'node:fs'

const SOURCE = new URL('./client.js', import.meta.url)
// Comments are blanked first, keeping offsets. The first run reported a prop called "scope" that
// existed only inside a comment — the same mistake the other two checks made on their first run: they
// were reading the text of the file rather than the code in it.
const raw = readFileSync(SOURCE, 'utf8')
const code = raw
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length))

// Component signatures: `function Name({ a, b, c })`, possibly across several lines.
const signatures = new Map()
for (const match of code.matchAll(/function\s+([A-Z][\w$]*)\s*\(\s*\{([\s\S]*?)\}\s*\)\s*\{/g)) {
  const names = new Set()
  for (const part of match[2].split(',')) {
    const name = part.trim().split(/[=:]/)[0].trim()
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
  }
  signatures.set(match[1], names)
}

/** Top-level `key:` names of the object literal starting at the brace at \`from\`. */
function keysOf(from) {
  const keys = []
  let depth = 0
  let index = from
  let start = from + 1
  for (; index < code.length; index += 1) {
    const ch = code[index]
    if (ch === '{' || ch === '(' || ch === '[') depth += 1
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1
      if (depth === 0) break
    } else if (ch === ',' && depth === 1) {
      start = index + 1
    } else if (ch === ':' && depth === 1) {
      // The segment just before this colon is the key.
      const segment = code.slice(start, index).trim()
      const name = segment.split(/[\s,]/).pop()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.push(name)
      start = index + 1
    }
  }
  return keys
}

const problems = []
for (const match of code.matchAll(/\bh\(\s*([A-Z][\w$]*)\s*,\s*\{/g)) {
  const component = match[1]
  const signature = signatures.get(component)
  if (!signature) continue
  const passed = keysOf(code.indexOf('{', match.index + match[0].length - 1))
  // React's own `key` is legitimate on any element and is not a prop of the component.
  const missing = passed.filter((key) => key !== 'key' && !signature.has(key))
  if (missing.length > 0) {
    const line = code.slice(0, match.index).split('\n').length
    problems.push({ component, line, missing })
  }
}

if (problems.length === 0) {
  console.log('  ok   every prop passed to a component is taken by its signature')
  process.exit(0)
}
console.log('  FAIL a component is handed props it does not take:')
for (const problem of problems) {
  console.log('    line ' + problem.line + '  h(' + problem.component + ', …) passes '
    + problem.missing.join(', ') + ' — not in its signature')
}
process.exit(1)
