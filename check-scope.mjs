// Guard against a bug class this file has already produced twice.
//
// `Tree` and `Body` are separate components. A callback written inside `Tree` that refers to
// Body's `post`, `setState` or `open` compiles, renders, and passes `node --check` — the
// reference only fails when the callback runs, so it throws on click and the message goes to
// the browser console where nobody sees it. The repair for that shipped bug was two lines;
// finding it took a restart cycle and a user report.
//
// This maps every line back to its enclosing component and reports uses of Body-scoped names
// outside Body.
//
// Shadowing is respected. A component that takes a prop called `open`, or declares its own
// `const open`, means its own thing — flagging that would be a false positive, and a check
// that cries wolf gets deleted or, worse, gets "fixed" by renaming working code.
//
// Run: node check-scope.mjs

import { readFileSync } from 'node:fs'

const PATH = new URL('./client.js', import.meta.url)
const lines = readFileSync(PATH, 'utf8').split('\n')

/** Names that exist only inside Body, the component that owns the remote, the state and post(). */
const BODY_ONLY = [
  'post', 'toggleBase', 'patchNodeLocally', 'patchBaseLocally', 'commitRename', 'confirmRemove',
  'setState', 'setEnabled', 'setPositions', 'setDrafts', 'setEdits', 'setSaving', 'setMenuFor',
  'setRenamingId', 'setConfirmingId', 'sessionId', 'saving', 'undoLast', 'open', 'menuFor',
  // Added after this exact name shipped across a component boundary: the list is hand-written, so a
  // name missing from it is a name the check cannot protect.
  'resetArrangement', 'unreviewedIn', 'reviewBase', 'reviewEverything', 'totalUnreviewed', 'stepUnread',
  'renamingId', 'confirmingId',
  // Added after a render threw on `state is not defined`: it is a Body variable, and nothing was
  // checking for it.
  'state',
]

/** Components allowed to touch Body's names: Body itself and the tiny leaf components. */
const ALLOWED = new Set(['Body', 'Note', 'ChipTitle', 'Marker', 'Switch', 'Glyph', 'unwrap', 'layout', 'definition'])

/** Every `function name(...)` declaration, with the line its parameter list starts on. */
const components = []
for (const [index, line] of lines.entries()) {
  const match = /^\s*function ([A-Za-z_][A-Za-z0-9_]*)\(/.exec(line)
  if (match) components.push({ line: index + 1, name: match[1] })
}

/** The component a line belongs to, by the last declaration above it. */
function ownerOf(lineNumber) {
  let owner = { name: '(module)', line: 1 }
  for (const component of components) {
    if (component.line > lineNumber) break
    owner = component
  }
  return owner
}

/**
 * Names that belong to a component rather than to Body: its parameters (including destructured
 * props) and anything it declares itself.
 */
function localNamesOf(component) {
  const names = new Set()
  const end = component.line - 1 + 40
  // The parameter list: from the declaration to the `{` that opens the body.
  let signature = ''
  for (let i = component.line - 1; i < Math.min(lines.length, end); i += 1) {
    signature += lines[i] + '\n'
    if (/\{\s*$/.test(lines[i]) && i > component.line - 1) break
  }
  const head = signature.slice(0, signature.indexOf(') {') + 1)
  for (const match of head.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const word = match[0]
    if (word !== 'function' && word !== component.name) names.add(word)
  }
  // Locally declared bindings anywhere inside the component.
  //
  // Destructuring counts, and that is not a detail: every `useState` in this file is `const [a, setA] = ...`,
  // so a pattern that only matched `const NAME` could not see a single piece of component state. That is how
  // `VersionBody`'s `open` was reported as undeclared while it sat declared one line above — and `open` is
  // also a Body-scoped name, so the false positive looked exactly like the real failure this file exists to
  // catch. A check that cannot see the most common declaration in the file will keep crying wolf, and the
  // usual response to a check that cries wolf is to stop reading it.
  for (let i = component.line; i < lines.length; i += 1) {
    const next = components.find((entry) => entry.line === i + 1)
    if (next) break
    for (const match of lines[i].matchAll(/(?:const|let|var|function)\s+([^=;]+?)\s*=/g)) {
      for (const name of match[1].matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
        // `[a, setA]` and `{ a, b: c }`: take every identifier, which over-collects on an object pattern with
        // a renamed key. Over-collecting only makes the check quieter, never wrong — and a missed report here
        // is a crash at runtime, which is why the balance is struck this way round.
        names.add(name[0])
      }
    }
    // `function name(...)` has no `=`, so it is not covered by the pattern above.
    for (const match of lines[i].matchAll(/(?:^|\s)function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
      names.add(match[1])
    }
  }
  return names
}

// Not preceded by a dot or a dollar: `workspace.sessionId` is a property, not the Body-scoped name, and
// `\b` alone cannot tell them apart.
const pattern = new RegExp('(?<![.\\w$])(' + BODY_ONLY.join('|') + ')(?![\\w$])')
const problems = []
for (const [index, line] of lines.entries()) {
  const owner = ownerOf(index + 1)
  if (ALLOWED.has(owner.name)) continue
  const trimmed = line.trim()
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
  const match = pattern.exec(line)
  if (!match) continue
  if (localNamesOf(owner).has(match[1])) continue
  problems.push({ line: index + 1, owner: owner.name, name: match[1], text: trimmed.slice(0, 100) })
}

// A second rule, for a bug that blanked the panel twice. Inside Body, within the per-base map,
// Body's `open` is the wrong base for every iteration but one — and undefined for all of them
// when nothing is expanded. It worked while the map only rendered the expanded body; the moment
// the bodies were always mounted for measuring, the rest threw.
//
// The first version only looked for `open.` and missed `base: open`, which is how the same bug
// came back with a different line in the stack. Anything matching the bare word is wrong inside
// the map: `isOpen` and `openId` do not match a case-sensitive `\bopen\b`, and no string in there
// says "open" alone.
//
// The scan stops at the end of the map. Past it, `open` is the right name again — the legend
// below reads `open ? ...` on purpose, and flagging that would be a false positive.
const mapStart = lines.findIndex((line) => line.includes('bases.map((base) =>'))
if (mapStart !== -1) {
  let mapEnd = lines.length - 1
  for (let i = mapStart + 1; i < lines.length; i += 1) {
    if (/^\s*\}\)\),\s*$/.test(lines[i])) {
      mapEnd = i
      break
    }
  }
  // Only a *value* use of the word is wrong. Each boundary here is a real case from the file:
  //   base: open,              value  -> flag
  //   open.nodes               value  -> flag
  //   open ? h(Note, ...)      value  -> flag
  //   open: isOpen             a property key (Collapsible's own prop) -> allow
  //   'data-open'              part of a hyphenated attribute name      -> allow
  //   isOpen / openId          not the standalone word at all           -> allow
  const bareOpen = /(?<![-\w.])open\b(?!\s*:)/
  for (let i = mapStart; i <= mapEnd; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('//')) continue
    if (bareOpen.test(lines[i])) {
      problems.push({
        line: i + 1,
        owner: 'Body',
        name: 'open',
        text: trimmed.slice(0, 100) + '   ← use `base` inside the per-base map',
      })
    }
  }
}

// NOTE: a rule for "a const read above its own declaration" was tried here and removed. It is a
// real bug class — it has blanked this panel twice — but the first version compared across
// components and mistook callback parameters for declarations, and fired on three pieces of correct
// code. Doing it properly needs the same component-scoped, parameter-aware treatment localNamesOf()
// gives the rule above; a noisy check is worse than none.

console.log('components: ' + components.map((entry) => entry.name).join(', '))
if (problems.length === 0) {
  console.log('\n  ok   no Body-scoped name is used outside Body')
  process.exit(0)
}
console.log('\n  FAIL these would throw only when they run:')
for (const problem of problems) {
  console.log(`    line ${problem.line} [${problem.owner}] uses "${problem.name}"`)
  console.log(`      ${problem.text}`)
}
process.exit(1)
