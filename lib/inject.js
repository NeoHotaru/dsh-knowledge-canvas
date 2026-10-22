/**
 * Hand knowledge to the model at the moment it reaches for a file.
 *
 * ## Why this exists
 *
 * The base's outline goes into the system prompt, and the protocol asks the model to look before acting. On
 * 2026-10-15 that failed in the plainest possible way: the author of this plugin changed `lib/state.js`,
 * which needs a restart, said "refresh will do", and `o10` — the node saying exactly that — was in context
 * the whole time. Writing more, or writing it more forcefully, does not fix that: a reminder competes with
 * everything else in a long context and loses.
 *
 * So this does not remind. It attaches the relevant nodes to the *result of the tool call that is about to
 * touch the file*, which is the one place the model is certainly reading. It cannot be skipped by not
 * thinking of it.
 *
 * ## Why it digs instead of reading named arguments
 *
 * The tool dispatcher is reached through a cordis proxy: `String(fn)` is `function () { [native code] }`, so
 * the parameter list cannot be read off it, and the shapes logged by a probe are the only other source. Every
 * guess about a service's surface in this project has cost a restart (see the `slots` note in index.js), so
 * this walks the arguments it is handed and looks for the things it needs — a path and a tool name — wherever
 * they sit. A shape it does not recognise simply produces no injection, which is the safe failure.
 *
 * @module dsh-knowledge-tree/inject
 */

// Delivery verified through the real Harness agent loop.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Whether action-time notes are switched off for a workspace.
 *
 * A sentinel file rather than a constant, because this exists to be *switched*: comparing what a session does
 * with the notes against what it does without them needs the two runs to differ in exactly one thing. Editing
 * the rules and restarting would also change the process; dropping a file in changes nothing else, and takes
 * effect on the next call rather than the next boot.
 *
 * `<workspace>/.dsh-knowledge/.no-action-notes`
 */
export function notesDisabled(workspace) {
  if (!workspace) return false
  try {
    return existsSync(join(workspace, '.dsh-knowledge', '.no-action-notes'))
  } catch {
    return false
  }
}

/** Files whose edits need the host-restart rule, and the nodes that explain why. */
const RULES = [
  {
    // Anything under lib/, plus the plugin entry point: changes here are loaded only at startup.
    match: /(^|[\\/])lib[\\/]|(^|[\\/])index\.js$/i,
    nodes: ['o4', 'o10'],
    why: '改的是宿主那一半',
  },
  {
    // The panel's own file: a browser file, so a refresh is enough — but the mistakes here have been about
    // verifying that what runs is what was written.
    match: /(^|[\\/])client\.js$/i,
    nodes: ['o4', 'o19'],
    why: '改的是面板那一半',
  },
]

/** Every string in `value`, to a bounded depth, so a path can be found wherever it is nested. */
function stringsIn(value, depth = 0, out = []) {
  if (depth > 4 || out.length > 40) return out
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsIn(item, depth + 1, out)
    return out
  }
  if (value && typeof value === 'object') {
    let keys = []
    try {
      keys = Object.keys(value)
    } catch {
      return out
    }
    for (const key of keys.slice(0, 30)) {
      try {
        stringsIn(value[key], depth + 1, out)
      } catch { /* a getter that throws is not our business */ }
    }
  }
  return out
}

/** The arguments of a call, flattened to strings. */
export function describeArgs(callArgs) {
  const strings = []
  for (const arg of callArgs) stringsIn(arg, 0, strings)
  return strings
}

/** The workspace a file belongs to: the nearest ancestor holding `.dsh-knowledge`. */
export function workspaceOf(filePath) {
  if (typeof filePath !== 'string' || !filePath) return ''
  let at = filePath.replace(/[\\/][^\\/]*$/, '')
  for (let depth = 0; depth < 12 && at; depth += 1) {
    try {
      if (existsSync(join(at, '.dsh-knowledge'))) return at
    } catch { /* an unreadable path is not a workspace */ }
    const up = at.replace(/[\\/][^\\/]*$/, '')
    if (up === at) break
    at = up
  }
  return ''
}

/** Which rule, if any, this call matches. */
export function ruleFor(strings) {
  // A writing tool: the name appears among the arguments as `write` / `edit`, and a path appears too.
  const writes = strings.some((item) => item === 'write' || item === 'edit')
  if (!writes) return null
  for (const rule of RULES) {
    const path = strings.find((item) => typeof item === 'string' && rule.match.test(item))
    if (path) return { rule, path }
  }
  return null
}

/** The note appended to a tool result. Deliberately short: it is read in passing, not studied. */
export function noteFor(rule, nodeTexts) {
  const lines = ['', '────────────────────────────────', '这个文件属于「' + rule.why + '」——先看这两条：']
  for (const id of rule.nodes) {
    const text = nodeTexts[id]
    if (text) lines.push('', '· ' + id + '：' + text)
  }
  lines.push('', '（来自知识库；这行是系统按你正在改的文件附上的，不需要你回答。）')
  return lines.join('\n')
}
