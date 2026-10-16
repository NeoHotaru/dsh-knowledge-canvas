/**
 * The outline that goes into the system prompt.
 *
 * Only the enabled bases, and only their outline — ids, titles, structure and the review
 * markers. Node bodies stay out and are fetched with `knowledge_read`, for two reasons the
 * system-prompt docs are explicit about:
 *
 *   "Persona prefixes, suffixes, and plugin text are repeated per request"
 *   "Any change may invalidate reuse from the first changed token"
 *
 * So the injected text is the smallest thing that still tells the model what exists, and it
 * stays byte-identical between changes so the prompt prefix keeps being reused.
 *
 * The section's text provider is synchronous, so this cannot read files at assembly time. The
 * outline is cached per workspace and refreshed in the background: after our own tools write,
 * and lazily when a reader finds the cache stale. A refresh never blanks the outline — the
 * previous text stands until the new one is ready — because an empty prompt for one turn is
 * worse than a slightly old one.
 */

import { listBases } from './store.js'
import { basesInOrder, readInject, readSelection } from './state.js'
import { log } from './log.js'

/** Kept on a timer so a hand edit to a file shows up within a turn or two. */
const STALE_MS = 4000

/**
 * The cache key: a workspace, and the session whose selection it was built from.
 *
 * The session is part of it because two sessions in one workspace can now read different bases. A shared
 * entry would serve one session the other's outline, which is worse than a slow rebuild.
 */
function cacheKey(cwd, sessionId) {
  return cwd + '\u0000' + (typeof sessionId === 'string' ? sessionId : '')
}

/** key -> { text, at }. `at: 0` means "known stale, refresh requested". */
const cache = new Map()
const refreshing = new Set()

/** Workspaces already reported, so the log gets one line each instead of one per assembly. */
const reported = new Set()
let reportedNoCwd = false

const CHANGE_LABEL = { added: '新增', modified: '修改', removed: '已废弃' }

/** Today as YYYY-MM-DD. Local, because the question it answers is which day that was for the reader. */
export function today() {
  const now = new Date()
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
    + '-' + String(now.getDate()).padStart(2, '0')
}

/**
 * The date of a node, or an empty string.
 *
 * Empty while the node is old: past a couple of weeks the exact day stops changing how much to trust it,
 * and a date on every line is noise that repeats. A date in the future is a clock disagreement rather
 * than information, so it is left out too.
 */
export function ageOf(at) {
  const parsed = whenOf(at)
  if (!parsed) return ''
  const days = Math.floor((Date.now() - parsed.time) / 86400000)
  if (days < 0 || days > 14) return ''
  // Today and yesterday by name, with the clock time: "今天 14:32" says more than the date does, and it
  // is what a reader checks when asking whether something is still true.
  if (days === 0) return '今天' + (parsed.clock ? ' ' + parsed.clock : '')
  if (days === 1) return '昨天' + (parsed.clock ? ' ' + parsed.clock : '')
  return parsed.date
}

/**
 * Parse a stamp in either form: `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`.
 *
 * Both exist: nodes written before the time was recorded carry only a date, and reading them as if they
 * had a time would invent one.
 */
export function whenOf(at) {
  if (typeof at !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(at.trim())
  if (!match) return null
  const time = new Date(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    match[4] === undefined ? 0 : Number(match[4]),
    match[5] === undefined ? 0 : Number(match[5]),
  ).getTime()
  if (!Number.isFinite(time)) return null
  return {
    time,
    date: match[1] + '-' + match[2] + '-' + match[3],
    clock: match[4] === undefined ? '' : match[4] + ':' + match[5],
  }
}

/** How much of a body's first line is worth injecting. */
const GIST_LIMIT = 72

/**
 * The first sentence of a body, shortened.
 *
 * A title says a node exists; this says what it claims. The outline carried titles alone, so a base full
 * of hard-won lessons reached the model as a list of headings it had no reason to open — the same lessons
 * were then relearned in the session that had them in context the whole time.
 *
 * Kept short and derived from the body, so the injected text stays small and changes only when the
 * knowledge does.
 */
export function gistOf(body) {
  return textOf(body, triggerOf(body).text)
}

/**
 * The trigger line, and whether there was one at all.
 *
 * The index falls back to the node's first sentence when a body has no trigger, which means a node written
 * without one is **indistinguishable from a node written with one** — and the trigger is the half that
 * decides whether the claim is ever retrieved. A test session asked for exactly this: a lint that marks the
 * gap, so a base full of untriggered nodes stops looking healthy.
 *
 * @returns `{ text, found }` — `text` is empty when there is no trigger.
 */
export function triggerOf(body) {
  const raw = String(body || '')
  // A trigger says when the node applies. The protocol puts it last, under one of these headings — so the
  // *last* occurrence wins. It used to take the first (`exec` without `/g`), which broke the moment a body
  // quoted the phrase earlier than the trigger itself: `o24` wrote "…从标题到「什么时候该想起它：」整段都在…"
  // while describing a verification, and the outline showed that quoted fragment as the node's summary. A
  // summary that silently comes from the wrong sentence is worse than no summary, because it still looks
  // like one.
  const pattern = /(?:什么时候该想起它|什么时候用|什么时候会用到|何时该想起|when to recall|when to use)[*\s]*[:：]\s*([^\n]+)/gi
  let trigger = null
  for (let found = pattern.exec(raw); found !== null; found = pattern.exec(raw)) trigger = found
  return { text: trigger ? trigger[1] : '', found: trigger !== null }
}

/** The one-line form of a stretch of body text: trimmed, unmarked, cut at a boundary. */
function textOf(body, source) {
  const flat = String(source === undefined || source === null || source === '' ? String(body || '') : source)
    .replace(/\s+/g, ' ')
    .replace(/\*/g, '')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '')
    .replace(/[—–-]{1,2}\s*$/, '')
    .trim()
  if (flat.length === 0) return ''
  if (flat.length <= GIST_LIMIT) return flat
  // Cut at a sentence, a clause, or failing both at the limit — whichever comes first, so the result
  // reads as a phrase rather than as a truncation.
  const window = flat.slice(0, GIST_LIMIT + 12)
  for (const stop of ['。', '！', '？', '. ', '；', ';', '，', ',', '、', '：', ':']) {
    const at = window.indexOf(stop)
    if (at > 2) return window.slice(0, at + (stop === '. ' ? 0 : 1))
  }
  return flat.slice(0, GIST_LIMIT) + '…'
}

/** The injected text for one workspace, or an empty string when there is nothing to say. */
/** How much text one fully-injected base may add. Beyond this it falls back to the index. */
const INJECT_LIMIT = 24000

/**
 * A base written out in full: every current node's title and body, in the same order the index uses.
 *
 * Removed nodes are left out for the same reason the index leaves them out — they are retired knowledge,
 * and putting them in front of the model as if they were current is worse than not mentioning them. They
 * still appear in the removed list the index prints.
 */
function flattenBase(base) {
  const children = new Map()
  for (const node of base.nodes || []) {
    const key = node.parent === undefined ? null : node.parent
    if (!children.has(key)) children.set(key, [])
    children.get(key).push(node)
  }
  const out = []
  const walk = (parent, depth) => {
    for (const node of children.get(parent) || []) {
      if (node.change === 'removed') continue
      const when = ageOf(node.at)
      // The review marker goes in, because full injection is the mode where it matters most: the bodies are
      // all present, so the only thing the reader still cannot see is which of them the user has not looked
      // at yet. Without it the richer mode answers a strictly smaller set of questions than the index does —
      // a test session found exactly that, and it is not a trade anyone chose.
      const mark = node.change && CHANGE_LABEL[node.change] ? '  [' + CHANGE_LABEL[node.change] + ']' : ''
      out.push('  '.repeat(depth) + '## ' + node.title + '  (' + node.id + ')' + mark
        + (when ? '  (' + when + ')' : ''))
      if (node.body && node.body.trim()) out.push(node.body.trim())
      out.push('')
      walk(node.id, depth + 1)
    }
  }
  walk(null, 0)
  return out.join('\n').trim()
}

/**
 * One base's size and its newest stamp, as a suffix for its heading in the outline.
 *
 * This exists to answer a question the reader otherwise has to guess at: *is the text I am looking at newer
 * than the node I just wrote?* A test session could not tell, and the failure mode of guessing wrong is to
 * conclude the write did not take and write it again, leaving duplicates in the base. `knowledge_write_node`
 * reports the node's own `at`, so the two are meant to be compared: if the node's stamp is later than this
 * one, this outline was assembled before that write and there is nothing to fix.
 *
 * Node count is included because it moves for the same reason and costs nothing.
 */
function freshnessOf(base) {
  const nodes = base.nodes || []
  let newest = ''
  for (const node of nodes) {
    if (typeof node.at === 'string' && node.at > newest) newest = node.at
  }
  return `  ·  ${nodes.length} 节点` + (newest ? '  ·  最新 ' + newest : '')
}

/**
 * One node as a single line: id, title, review mark, and the trigger when it has one.
 *
 * Shared with `describeNode` in the store. The two used to build this line independently, which is the shape
 * of mistake `o31` is about: two renderings of the same thing, each free to forget a field. The core lives
 * here; the outline adds the timestamp and the missing-trigger mark on top, visibly, at its own call site.
 */
export function briefOf(node) {
  const flag = node.change ? `  [${CHANGE_LABEL[node.change] || node.change}]` : ''
  const gist = gistOf(node.body)
  return `${node.id}  ${node.title}${flag}${gist ? ' — ' + gist : ''}`
}

export function renderOutline(bases, enabled, inject) {
  const chosen = enabled === null ? bases : bases.filter((base) => enabled.has(base.id))
  if (chosen.length === 0) return ''
  const full = inject && typeof inject === 'object' ? inject : {}

  const lines = [
    '知识库（指令见前文。今天：' + today() + '）',
    '',
    '有两种库:**带"全文"的，正文已经在这里，直接照着做**；其余只给摘要，',
    '需要时用 knowledge_read 取。**读一堆不相关的正文比不读更糟。**',
  ]
  for (const base of chosen) {
    lines.push('')
    // A base the user marked for full injection: its bodies go in as they are, and no summary is needed
    // because the reader is not being asked to decide anything.
    const whole = full[base.id] === 'full' ? flattenBase(base) : null
    if (whole && whole.length <= INJECT_LIMIT) {
      lines.push(`「${base.name}」(${base.id}) —— 全文${freshnessOf(base)}`)
      lines.push('')
      lines.push(whole)
      continue
    }
    lines.push(`「${base.name}」(${base.id})${freshnessOf(base)}`)
    if (whole) {
      // Marked full but too large. Saying so is the honest option: silently injecting it would spend the
      // budget, and silently indexing it would look like the setting did not apply.
      lines.push(`  （这一库标记了全文注入，但有 ${whole.length} 字，超过 ${INJECT_LIMIT} —— 临时按摘要给。`)
      lines.push('   如果它是重要的，把它拆成几个库；如果它不重要，把全文注入关掉。）')
    }
    const children = new Map()
    for (const node of base.nodes || []) {
      const key = node.parent === undefined ? null : node.parent
      if (!children.has(key)) children.set(key, [])
      children.get(key).push(node)
    }
    const removed = []
    const emitted = new Set()
    const walk = (parent, depth) => {
      for (const node of children.get(parent) || []) {
        // A node marked removed is not current knowledge: injecting it as part of the tree
        // would tell the model to keep using something the user has retired. It is reported
        // separately instead, so the model knows it exists and does not simply re-add it.
        if (node.change === 'removed') {
          removed.push(node)
          continue
        }
        const trigger = triggerOf(node.body)
        const when = ageOf(node.at)
        // A node with no trigger is marked, because otherwise it is indistinguishable from one with a
        // trigger: the gist falls back to the first sentence and reads exactly like a trigger line. The
        // trigger is what makes a node retrievable at all in index mode — without it the model has the
        // title and nothing to match against — so an unmarked gap is a base that looks healthy and is not.
        const noTrigger = node.body && node.body.trim() && !trigger.found ? '  （无触发器）' : ''
        // `briefOf` carries the core the single-node view shares; the timestamp and the missing-trigger mark
        // are this renderer's own additions, so they stay here where they can be seen.
        lines.push(`${'  '.repeat(depth + 1)}- ${briefOf(node)}${when ? '  (' + when + ')' : ''}${noTrigger}`)
        emitted.add(node.id)
        walk(node.id, depth + 1)
      }
    }
    walk(null, 0)
    // Anything unreachable — a hand edit that left a node under a missing parent — still has
    // to appear, or the model would never learn it exists.
    for (const node of base.nodes || []) {
      if (emitted.has(node.id) || node.change === 'removed') continue
      lines.push(`  - ${node.id}  ${node.title}  (父节点缺失)`)
    }
    if (removed.length) {
      lines.push(`  已废弃（不要再用）：${removed.map((node) => `${node.id} ${node.title}`).join('，')}`)
    }
    if ((base.links || []).length) {
      // The note, not just the ids.
      //
      // A line saying `o3<->o2` tells a reader that two nodes are connected and nothing about whether
      // following it is worth doing — so the association is visible and unusable, which is barely better than
      // absent. The note is the whole reason the link exists, and it is also the only part another session
      // could act on. Links drawn before this reach the outline without one; they are marked rather than
      // hidden, on the same reasoning as the missing-trigger mark above.
      lines.push('  关联：' + base.links.map((link) => {
        const ends = `${link.from}<->${link.to}`
        return link.note ? `${ends}（${link.note}）` : `${ends}（无注释：说明什么时候该顺着它走）`
      }).join('，'))
    }
  }
  return lines.join('\n')
}

/** Rebuild one workspace's cached outline. Never throws; a failure keeps the previous text. */
export async function refresh(cwd, sessionId) {
  if (typeof cwd !== 'string' || cwd.length === 0) return
  // Keyed by the Session as well as the workspace. Two Sessions in one workspace need different outlines —
  // each has its own switched-off bases — so de-duplicating by workspace alone meant whichever asked second
  // was silently skipped and kept the other one's answer. The same mistake the cache key would have made.
  const running = cacheKey(cwd, sessionId)
  if (refreshing.has(running)) return
  refreshing.add(running)
  try {
    // In the order the user arranged them: the prompt lists the most important base first, which
    // is the whole reason the panel lets them be dragged around.
    const bases = await basesInOrder(cwd)
    const enabled = await readSelection(cwd, sessionId)
    // Which bases the user marked for full injection. Passing it here is what makes the setting do anything:
    // without it the mode is stored, shown in the panel, and never read — the failure this project keeps
    // writing notes about.
    const inject = await readInject(cwd)
    const text = renderOutline(bases, enabled, inject)
    // Marked provisional when there was no Session id to build it under: the next assembly, with a real id,
    // must rebuild rather than serve this. `needsRefresh` reads the flag.
    cache.set(cacheKey(cwd, sessionId), {
      text,
      at: Date.now(),
      provisional: !(typeof sessionId === 'string' && sessionId.length > 0),
    })
    // One line per workspace: proof the outline was built at all, without logging every turn.
    if (!reported.has(cwd)) {
      reported.add(cwd)
      const whole = Object.keys(inject).length
      log(`outline built for ${cwd}: ${bases.length} base(s), ${whole} injected in full, `
        + `${text.length} chars, injected=${text.length > 0}`)
    }
  } catch (error) {
    log(`FAIL building the outline for ${cwd}: ${(error && error.message) || error}`)
  } finally {
    refreshing.delete(running)
  }
}

/** True when a workspace has no outline yet, or its cached one has aged past the timer. */
export function needsRefresh(cwd, sessionId) {
  if (typeof cwd !== 'string' || cwd.length === 0) return false
  const entry = cache.get(cacheKey(cwd, sessionId))
  // A provisional entry — built before this Session's id could be read — is always "needs rebuilding", so the
  // moment the id is known the answer is recomputed against that Session's own switches.
  if (entry && entry.provisional) return true
  return !entry || Date.now() - entry.at > STALE_MS
}

/**
 * The synchronous value the system-prompt section reads.
 * @param cwd - the Session's workspace directory.
 * @returns the cached outline, or an empty string when nothing has been built yet.
 */
export function outlineFor(cwd, sessionId) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    // Worth one line ever: it separates "the outline is empty" from "there was nowhere to
    // look", which are otherwise the same symptom in the UI.
    if (!reportedNoCwd) {
      reportedNoCwd = true
      log('an assembly ran without a Session workspace, so no outline could be injected')
    }
    return ''
  }
  // A Session whose id is not readable yet — on the first turn the header is still being filled, and the
  // probe caught exactly that: an empty id in the provider and a real one moments later in the tools.
  //
  // What matters is what not to do with it. Caching under the empty key permanently would freeze this
  // Session's answer as the *workspace* answer for the conversation, so "this Session turns a base off"
  // would silently never apply. Deleting the entry instead blanks the outline for a turn, which is the
  // failure the STALE_MS path was written to avoid.
  //
  // So it is stored marked provisional and served normally. `needsRefresh` treats a provisional entry as
  // always stale, so the next assembly — once the header carries an id — rebuilds it under the real one.
  const provisional = !(typeof sessionId === 'string' && sessionId.length > 0)
  const entry = cache.get(cacheKey(cwd, sessionId))
  if (!entry) {
    void refresh(cwd, sessionId)
    return ''
  }
  if (provisional) {
    void refresh(cwd, sessionId)
    return entry.text
  }
  if (Date.now() - entry.at > STALE_MS) {
    // Stale: keep serving the old text while a fresh one is built.
    cache.set(cacheKey(cwd, sessionId), { text: entry.text, at: Date.now() })
    void refresh(cwd, sessionId)
  }
  return entry.text
}

/** Mark one workspace's outline stale and rebuild it, after this plugin's tools have written. */
export function invalidate(cwd) {
  // Every session in this workspace, because the write could have been to any base they read.
  for (const key of [...cache.keys()]) {
    if (key.startsWith(cwd + '\u0000')) cache.set(key, { text: cache.get(key).text, at: 0 })
  }
  void refresh(cwd)
}
