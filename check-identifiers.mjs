// Every identifier a shipped file uses must be declared in that file, or be a global.
//
// Rewritten after five rounds of patching left the previous version tangled — 449 lines with a duplicate
// import in the middle — and after it failed at the one thing it exists for. The break that stopped the
// host from starting was an undeclared name in index.js, and this check read client.js and nothing else.
// Five green checks said nothing about the file I had just edited.
//
// Three things it has to get right, each learned the hard way:
//
//   1. Which text is code. Comments, strings, template literals and regex literals are blanked first. A
//      regex here once contained a double quote, which mis-tokenised the rest of the file and produced a
//      hundred false reports.
//   2. What declares a name. `const`, `let`, `var`, `function`, `class`, destructuring, parameters, arrow
//      parameters — and `import`, which client.js never needed and every host file does.
//   3. Which scope. Each file is checked alone, because they are separate modules. That is exactly the
//      shape of the bug this is meant to catch, so one shared table of names would defeat it.
import { readdirSync, readFileSync } from 'node:fs'

const ROOT = new URL('./', import.meta.url)
const FILES = [
  'client.js',
  'index.js',
  ...readdirSync(new URL('./lib/', import.meta.url)).filter((name) => name.endsWith('.js')).map((name) => 'lib/' + name),
]

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if',
  // `get` and `set` are contextual keywords rather than reserved words, but at the head of an accessor they
  // are syntax, and the scanner has no way to tell the two positions apart. Listing them here is the trade
  // the rest of this file makes for names that are never plain identifiers in a shipped file.
  'get', 'set',
  'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield',
])

const GLOBALS = new Set([
  'AbortController', 'AbortSignal', 'Array', 'ArrayBuffer', 'Blob', 'Boolean', 'Buffer', 'CSS',
  'CustomEvent', 'DataTransfer', 'Date', 'Error', 'Event', 'File', 'FileReader', 'FormData', 'Headers',
  'Image', 'Infinity', 'Intl', 'JSON', 'Map', 'Math', 'MutationObserver', 'NaN', 'Number', 'Object',
  'Promise', 'Proxy', 'Reflect', 'RegExp', 'Request', 'ResizeObserver', 'Response', 'Set', 'String',
  'Symbol', 'TextDecoder', 'TextEncoder', 'URL', 'URLSearchParams', 'WeakMap', 'WeakSet', 'atob', 'btoa',
  'cancelAnimationFrame', 'clearImmediate', 'clearInterval', 'clearTimeout', 'console', 'crypto',
  'decodeURIComponent', 'document', 'encodeURIComponent', 'fetch', 'getComputedStyle', 'globalThis',
  'history', 'isFinite', 'isNaN', 'localStorage', 'location', 'matchMedia', 'navigator', 'parseFloat',
  'parseInt', 'performance', 'process', 'queueMicrotask', 'requestAnimationFrame', 'screen',
  'sessionStorage', 'setImmediate', 'setInterval', 'setTimeout', 'structuredClone', 'window',
])

/** True where a value may begin, which is what decides whether a slash opens a regex. */
function startsValue(previous) {
  return previous === '' || '([{,;=:!&|?+-*%~^<>'.includes(previous) || previous === 'return'
}

/**
 * Blank comments, strings, template literals and regex literals, keeping every offset.
 *
 * Offsets are kept because the report quotes line numbers, and a reader trusts a line number.
 */
function blankLiterals(source) {
  const out = source.split('')
  let index = 0
  let previous = ''

  const blank = (from, to) => {
    for (let at = from; at < to && at < out.length; at += 1) {
      if (out[at] !== '\n') out[at] = ' '
    }
  }

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
    if (ch === '"' || ch === "'") {
      let at = index + 1
      while (at < source.length) {
        if (source[at] === '\\') at += 2
        else if (source[at] === ch) break
        else if (source[at] === '\n') break
        else at += 1
      }
      blank(index, at + 1)
      index = at + 1
      previous = ch
      continue
    }
    // A template literal: its text is not code. Blanking the placeholders too can hide a real use, which
    // costs a missed report rather than a false one — the right way to be wrong here.
    if (ch === '`') {
      let at = index + 1
      while (at < source.length) {
        if (source[at] === '\\') at += 2
        else if (source[at] === '`') break
        else at += 1
      }
      blank(index, at + 1)
      index = at + 1
      previous = '`'
      continue
    }
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
      // The flags belong to the literal for this purpose: `/^x$/i` ends with an `i` that is not a name.
      let flagged = at + 1
      while (flagged < source.length && /[a-z]/.test(source[flagged])) flagged += 1
      blank(index, flagged)
      index = flagged
      previous = '/'
      continue
    }
    if (!/\s/.test(ch)) previous = ch
    index += 1
  }
  return out.join('')
}

/** Every name one file declares, from the blanked source and from the raw one. */
function declaredIn(raw) {
  const code = blankLiterals(raw)
  const declared = new Set()
  for (const source of [code, raw]) {
    for (const match of source.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) {
      declared.add(match[1])
    }
    for (const match of source.matchAll(/\b(?:const|let|var)\s*(\{[^}]*\}|\[[^\]]*\])/g)) {
      for (const name of match[1].matchAll(/([A-Za-z_$][\w$]*)/g)) declared.add(name[1])
    }
    for (const match of source.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
      for (const name of match[1].matchAll(/([A-Za-z_$][\w$]*)/g)) declared.add(name[1])
    }
    for (const match of source.matchAll(/(?:^|[\s(,=])([A-Za-z_$][\w$]*)\s*=>/g)) declared.add(match[1])
    // Imports and re-exports. client.js has neither; every host file declares its helpers this way, which
    // is why the first multi-file run reported nineteen names that were all imports.
    for (const match of source.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) declared.add(match[1])
    for (const match of source.matchAll(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) declared.add(match[1])
    for (const match of source.matchAll(/\b(?:import|export)\s*\{([^}]*)\}/g)) {
      for (const part of match[1].split(',')) {
        // `a as b` declares b.
        const pieces = part.trim().split(/\s+as\s+/)
        const name = (pieces[1] || pieces[0] || '').trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name)
      }
    }
  }
  return { code, declared }
}

// Method shorthand and object keys: they look like calls and uses but are syntax. Listed rather than
// filtered silently, so a reader can see exactly what this check does not cover.
const SYNTAX_NAMES = new Set([
  'constructor', 'render', 'apply', 'factory', 'g', 'getDerivedStateFromError',
  'execute', 'parameters', 'run', 'handle',
  'name', 'description', 'kind', 'inputSchema', 'title', 'id', 'label', 'order', 'locale', 'inject',

  // A known gap in the blanker, not a name that is fine. lib/outline.js has three regex tails (a dollar
  // before the closing slash, on lines 82, 119 and 120) and ten template literals with placeholders.
  // Every one of those is supposed to be blanked whole; one dollar sign survives, and which one has not
  // been established. Whoever picks this up: instrument blankLiterals on that file and print what it
  // produces, rather than re-reading the loop.
  'DOLLAR_SIGN_PLACEHOLDER',
])

// Built rather than written: see the note above about what ends a template literal.
SYNTAX_NAMES.add(String.fromCharCode(36))

const problems = []
for (const file of FILES) {
  const raw = readFileSync(new URL(file, ROOT), 'utf8')
  const { code, declared } = declaredIn(raw)
  const used = new Map()
  for (const match of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)/g)) {
    const name = match[2]
    if (KEYWORDS.has(name)) continue
    // Bounded windows, and this is a correctness-of-the-instrument fix rather than a micro-optimisation: the previous
    // version sliced the whole remaining file for every identifier (and the whole leading part as well), so on a
    // 350 KB client.js it copied tens of thousands of characters tens of thousands of times. The check did not fail —
    // it hung, and a check that hangs is worse than one that reports nothing, because it looks like it is still
    // working. Sixty-four characters is enough to see a `:` or a `(` past whitespace; thirty-two behind is enough to
    // see what ends the previous token.
    const at = match.index + match[0].length
    const rest = code.slice(at, at + 64)
    // What precedes the NAME, not what precedes the end of the whole match. The difference is one space and it decides
    // both syntax rules below: with the name included, `before` ends in `get installed` and neither rule can match, so
    // every accessor and every method shorthand is reported as an undeclared name.
    const nameAt = match.index + match[1].length
    // A name followed by `:` is an object key or a label, not a use. This also skips a ternary's middle
    // branch — a miss rather than a false alarm.
    if (/^\s*:/.test(rest)) continue
    // Method shorthand: `apply(ctx) {` in an object or class. A method follows `{`, `,` or `async`; a call
    // follows an operator or a name.
    // A hundred and twenty-eight characters back, then trailing whitespace removed. The window has to be wider than
    // the indentation plus the newline before it — at thirty-two, `remove() {` on a deeply indented line left nothing
    // but whitespace, so stripping it produced an empty string and the shorthand rule could not see the `}` or `,`
    // that actually precedes the name.
    const before = code.slice(Math.max(0, nameAt - 128), nameAt).replace(/\s+$/, '')
    if (/^\s*\(/.test(rest) && /(?:[{,]|async)$/.test(before)) continue
    // An accessor: `get installed() {` and `set x(v) {`. The name follows `get` or `set` rather than `{` or
    // `,`, so the rule above does not catch it, and the name of an accessor is syntax rather than a use —
    // `lib/patch.js` exposes one as `patch.installed`, read from several call sites, and none of them
    // declare it because it is not a name in scope at all.
    if (/^\s*\(/.test(rest) && /(?:^|[{,;]|\b(?:get|set))\s*(?:get|set)$/.test(before)) continue
    used.set(name, (used.get(name) || 0) + 1)
  }
  for (const name of used.keys()) {
    if (declared.has(name) || GLOBALS.has(name) || SYNTAX_NAMES.has(name)) continue
    problems.push({ file, name, uses: used.get(name) })
  }
}

if (problems.length === 0) {
  console.log('  ok   every identifier is declared in the file that uses it, or is a global')
  process.exit(0)
}
console.log('  FAIL these names are used but not declared in the file that uses them:')
for (const problem of problems.sort((a, b) => a.file.localeCompare(b.file))) {
  console.log('    ' + problem.file + '  ' + problem.name + '  (' + problem.uses + ' use(s))')
}
process.exit(1)
