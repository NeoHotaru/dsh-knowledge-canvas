import { readDiaryReplies, submitDiaryReply } from './diary-replies.js'
/**
 * The panel's write path.
 *
 * Until this existed the panel was a viewer: the client reads the workspace through the
 * workspace-files remote, and that remote has no write method — neither the client stub nor
 * the host service behind it. So everything the user did in the panel (edit a node, draw a
 * link, drag a box, flip a switch) lived in browser memory and died on reload.
 *
 * `ctx.webServer.register` is the hand-written route API, so this needs no generated client.
 * Three decisions shape the surface:
 *
 * - **The client never sends a path.** A route handler has no `exec`, so it cannot read the
 *   Session's workspace the way a tool does. The client sends a Session id and the handler
 *   resolves the workspace through `ctx.sessions`. Accepting a path from the browser would
 *   turn this into an arbitrary-file-write endpoint.
 * - **Writes require a JSON content type.** A cross-site `fetch` with that header triggers a
 *   CORS preflight, which this route never answers, so a page in another tab cannot write
 *   here. Form-encoded posts stay rejected.
 * - **The operations are separate from the HTTP layer**, so they can be exercised against a
 *   temporary directory without starting a server.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  addLink, assertId, DIRNAME, listBases, loadBase, purgeNode, removeBase, removeLink, setLinkNote, removeNode, renameBase, saveBase,
  revertNode, revertUnreviewed, upsertNode,
  mimeOfAny, putAssetBytes,
} from './store.js'
import { parseActivity } from './tools.js'
import {
  readAttachmentMode, writeAttachmentMode, DIARY_BASE_ID, basesInOrder, readColors, readInject, readNodeInject, writeNodeInject, pruneNodeInject, readLayout, readLive, readNames, readShapes, readSizes, readSelection,
  readWidths, writeInject, writeLive, readDiary, writeDiary, diaryBaseFor, isDiaryBase,
  writeBaseWidth, writeColors, writeLayout, writeShape, writeName, writeNodeBox, writeNodeWidth, writeOrder,
  writeSelection, readSessionSelection } from './state.js'
import { invalidate, refreshPolicies } from './outline.js'
import { log } from './log.js'
import { workspacesWithKnowledge } from './workspaces.js'

/** Everything this plugin serves lives under one prefix, so one route registration covers it. */
export const PREFIX = '/dsh-knowledge-tree'

/** A panel payload is a handful of node edits; anything larger is a mistake or an attack. */
const MAX_BODY = 512 * 1024

/** Switch bases on or off. Only the enabled ones reach the prompt. */
export async function setSelection(cwd, enabled, sessionId, scope) {
  if (!Array.isArray(enabled)) throw new Error('"enabled" must be an array of base ids')
  const bases = await listBases(cwd)
  const known = new Set(bases.map((base) => base.id))
  const wanted = []
  for (const raw of enabled) {
    const id = assertId(String(raw), 'base id')
    if (!known.has(id)) throw new Error(`no knowledge base "${id}" in ${DIRNAME}/`)
    if (!wanted.includes(id)) wanted.push(id)
  }
  // A session id on its own means "this session"; `scope: 'workspace'` means the default every session
  // inherits, which is what the settings page edits.
  const saved = await writeSelection(cwd, wanted, scope === 'workspace' ? undefined : sessionId)
  invalidate(cwd)
  return { enabled: saved }
}

/**
 * Save the order the user dragged the bases into.
 *
 * Ids that no longer exist are dropped rather than rejected: a drag can land while a model write is
 * removing a base, and losing the whole ordering to that race would be worse than losing one entry.
 * Ids the user has not placed keep their default position.
 */
export async function setOrder(cwd, order) {
  if (!Array.isArray(order)) throw new Error('"order" must be an array of base ids')
  const bases = await listBases(cwd)
  const known = new Set(bases.map((base) => base.id))
  const wanted = []
  for (const raw of order) {
    let id
    try {
      id = assertId(String(raw), 'base id')
    } catch {
      continue
    }
    if (known.has(id) && !wanted.includes(id)) wanted.push(id)
  }
  const saved = await writeOrder(cwd, wanted)
  invalidate(cwd)
  return { order: saved }
}

/** Remember where the user dragged one base's boxes. */
export async function setLayout(cwd, baseId, positions) {
  const id = assertId(String(baseId ?? ''), 'base id')
  const bases = await listBases(cwd)
  if (!bases.some((base) => base.id === id)) throw new Error(`no knowledge base "${id}" in ${DIRNAME}/`)
  const saved = await writeLayout(cwd, id, positions)
  return { base: id, positions: saved }
}

/**
 * Create a node from the panel.
 *
 * Separate from the edit path, which requires an existing node id. The new node is marked as an
 * addition, exactly as a model write is, so the user reviews their own writing through the same
 * channel — and it comes back with its id so the editor can open on it.
 */
/**
 * Create a node from the panel, optionally beneath an existing one.
 *
 * `parent` is the only structural relationship this can establish, and deliberately: a parent node is born as a
 * top-level one from the canvas menu. Inserting a new node *above* an existing one would have to either give the
 * target two parents — impossible with one `parent` field — or quietly reroute it out of its branch. Moving a node
 * within the tree is `setParent`, and it is a deliberate act.
 */
export async function createNodeFromPanel(cwd, baseId, { title, body, parent } = {}) {
  const id = assertId(String(baseId ?? ''), 'base id')
  const bases = await listBases(cwd)
  if (!bases.some((base) => base.id === id)) throw new Error(`no knowledge base "${id}" in ${DIRNAME}/`)
  const loaded = await loadBase(cwd, id)
  await pruneNodeInject(cwd, id, loaded.base.nodes.map((entry) => entry.id))
  const created = upsertNode(loaded.base, {
    // A node made from the panel is the user's, not the session's.
    by: null,
    title: typeof title === 'string' ? title : '',
    body: typeof body === 'string' ? body : '',
    parent: parent == null || parent === '' ? undefined : String(parent),
  })
  await saveBase(loaded.path, loaded.base)
  invalidate(cwd)
  return { base: id, node: created.node.id }
}

/**
 * Remove a node from the file for good.
 *
 * The second half of delete. Soft first is what makes a deletion reviewable and reversible; this is
 * what stops an unwanted node from sitting in the canvas forever. The store requires the soft step to
 * have happened, so a live node cannot be purged and its children cannot be orphaned by mistake.
 */
export async function purgeNodeFromPanel(cwd, baseId, nodeId) {
  const id = assertId(String(baseId ?? ''), 'base id')
  const loaded = await loadBase(cwd, id)
  const node = purgeNode(loaded.base, String(nodeId ?? ''))
  await saveBase(loaded.path, loaded.base)
  await pruneNodeInject(cwd, id, loaded.base.nodes.map((entry) => entry.id))
  invalidate(cwd)
  return { base: id, node: node.id }
}

/**
 * Mark one node removed, from the panel.
 *
 * Soft, and the button says so. The node keeps its place in the file, greyed and struck through, and
 * stops being injected into the prompt — which is the point, because a stale node is worse than no
 * node. Its children move up, so the branch is not lost.
 */
export async function removeNodeFromPanel(cwd, baseId, nodeId) {
  const id = assertId(String(baseId ?? ''), 'base id')
  const loaded = await loadBase(cwd, id)
  const node = removeNode(loaded.base, String(nodeId ?? ''))
  await saveBase(loaded.path, loaded.base)
  invalidate(cwd)
  return { base: id, node: node.id }
}

/**
 * Set a node box's width, either for one node or for a whole base.
 *
 * `node` decides which: present means that node alone, absent means every node in the base that has not
 * been given its own. Width is what the layout uses for the horizontal gap between siblings, so it is
 * range-checked in the store rather than trusted from the browser.
 */
export async function setWidth(cwd, baseId, { node, width, height } = {}) {
  const id = assertId(String(baseId ?? ''), 'base id')
  const bases = await listBases(cwd)
  if (!bases.some((base) => base.id === id)) throw new Error(`no knowledge base "${id}" in ${DIRNAME}/`)
  if (node) {
    // A node's box can carry a width, a height, or both — the edge drag sends one, the corner sends two.
    const sizes = await writeNodeBox(cwd, id, String(node), { w: width, h: height })
    return { base: id, sizes }
  }
  return { base: id, widths: await writeBaseWidth(cwd, id, width) }
}

/** Choose how a base is arranged. */
export async function setShape(cwd, baseId, shape) {
  const id = assertId(String(baseId ?? ''), 'base id')
  const bases = await listBases(cwd)
  if (!bases.some((base) => base.id === id)) throw new Error(`no knowledge base "${id}" in ${DIRNAME}/`)
  const shapes = await writeShape(cwd, id, String(shape ?? ''))
  return { base: id, shapes }
}

/** Remember the colour the user gave one node. */
export async function setColor(cwd, baseId, nodeId, color) {
  const id = assertId(String(baseId ?? ''), 'base id')
  // loadBase hands back { path, base }; reading .nodes off the wrapper finds nothing, which is how
  // this shipped — the colour test caught it rather than a user losing their colours.
  const { base } = await loadBase(cwd, id)
  const node = (base.nodes || []).find((entry) => entry.id === nodeId)
  if (!node) throw new Error(`no node "${nodeId}" in ${id}`)
  const colors = await readColors(cwd)
  const forBase = Object.assign({}, colors[id] || {})
  if (color === null || color === '') delete forBase[nodeId]
  else forBase[nodeId] = color
  const saved = await writeColors(cwd, id, forBase)
  return { base: id, colors: saved }
}

/** Change a base's display name. The id, and therefore the file name, stays put. */
export async function renameBaseFromPanel(cwd, baseId, name) {
  const id = assertId(String(baseId ?? ''), 'base id')
  const saved = await renameBase(cwd, id, name)
  invalidate(cwd)
  return { base: id, name: saved }
}

/**
 * Remove a whole base, and stop the selection from naming it.
 *
 * The same two steps the `knowledge_remove_base` tool performs, so the panel and the model
 * cannot end up with different ideas of what removing a base means.
 */
export async function removeBaseFromPanel(cwd, baseId) {
  const id = assertId(String(baseId ?? ''), 'base id')
  const parked = await removeBase(cwd, id)
  await pruneNodeInject(cwd, id, [])
  const selection = await readSelection(cwd)
  let dropped = false
  if (selection !== null && selection.has(id)) {
    selection.delete(id)
    await writeSelection(cwd, [...selection])
    dropped = true
  }
  invalidate(cwd)
  return { base: id, parked, droppedFromSelection: dropped }
}

/**
 * Apply the panel's pending changes for one base: node edits, hand-drawn links, deletions of
 * those links, and bare reviews.
 *
 * A user edit clears that node's review marker, because editing it is the act of looking at
 * it; `review` clears it without touching the text. Link creation and removal are both
 * idempotent — a retried request reports the state it found instead of failing — so a flaky
 * connection can neither lose a change nor double it.
 */
/**
 * Write the note on one link, from the panel.
 *
 * The model is required to write a note when it links two nodes — the note is what other sessions see in
 * their outline, and a line with nothing on it cannot be acted on. The user is not required to: they are the
 * only reader of their own panel. But they have to be able to, and this is that path — including the empty
 * case, which clears the note rather than storing a blank one.
 */
async function setLinkNoteFromPanel(cwd, payload) {
  const baseId = assertId(String(payload.base ?? ''), 'base id')
  const from = assertId(String(payload.from ?? ''), 'node id')
  const to = assertId(String(payload.to ?? ''), 'node id')
  const { base, path } = await loadBase(cwd, baseId)
  const link = setLinkNote(base, { from, to, note: payload.note })
  await saveBase(path, base)
  invalidate(cwd)
  return { link: { from: link.from, to: link.to, note: link.note || '' } }
}

/**
 * Move a node in the tree: give it a new parent, or lift it back to the top level.
 *
 * The panel could draw an association by hand but had no way to build structure — `parent` was reachable only from
 * the model's tool or from editing the JSON. So a base the user built alone stayed flat while the same base grown
 * by the model became a tree, and "这两条是父子关系" was a thing only one of the two writers could say.
 *
 * `upsertNode` owns the validation (existence, self-parenting, and loops), so this route adds none of its own —
 * two places checking the same invariant is how they drift apart.
 */
export async function setParent(cwd, baseId, { node, parent } = {}) {
  const id = assertId(String(baseId ?? ''), 'base id')
  const { base, path } = await loadBase(cwd, id)
  const target = String(node ?? '').trim()
  if (!target) throw new Error('setParent needs a node id')
  const parentId = parent === null || parent === undefined || String(parent).trim() === ''
    ? null
    : String(parent).trim()
  const updated = upsertNode(base, { node: target, parent: parentId })
  await saveBase(path, base)
  // The outline is a rendering of the tree, so structure moving makes it stale in a way a body edit does not.
  invalidate(cwd)
  return { base: id, node: updated.node.id, parent: parentId }
}

/**
 * The most recent knowledge-base calls, newest last.
 *
 * Read-only and cheap: the panel asks for this while a base is open so the reader can see that the model has been
 * in here — which until now was only visible by opening `activity.log` after the fact. The log is append-only and
 * one line per call, so tailing it costs one read and no writes.
 *
 * `session` narrows to one conversation. Without it every session's calls come back, which is what a workspace-level
 * view would want.
 */
export async function readActivity(cwd, { session, limit } = {}) {
  const file = join(cwd, DIRNAME, 'activity.log')
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    // No log yet is not a failure: this workspace has never had a knowledge-base call.
    return { entries: [] }
  }
  const want = typeof session === 'string' && session ? session : null
  const all = parseActivity(text)
  const entries = want ? all.filter((entry) => entry.session === want) : all
  const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20
  // The switch comes back with the entries: the panel decides whether to show the live line at all, and a second round
  // trip that could disagree with this one is a race for nothing.
  // The diary switch rides along: both are per-session flags the header renders, and one poll for two flags beats two
  // polls that can disagree.
  // `diaryBase` is this conversation's own diary name. The panel builds its list from the files on disk, so
  // without it the panel can only show or hide "the base called diary", which is no longer what it is called.
  return {
    // This conversation's own diary, by name: the panel builds its list from the files on disk.
    diaryBase: diaryBaseFor(want),
    live: await readLive(cwd),
    diary: await readDiary(cwd, want),
    entries: entries.slice(-count),
  }
}

export async function applyChanges(cwd, baseId, { edits, links, removeLinks, review }) {
  const id = assertId(String(baseId ?? ''), 'base id')
  const { base, path } = await loadBase(cwd, id)
  const result = {
    base: id, edited: [], reviewed: [], linksAdded: [], linksAlreadyPresent: [], linksRemoved: [],
  }

  for (const edit of Array.isArray(edits) ? edits : []) {
    if (!edit || typeof edit !== 'object') continue
    const node = String(edit.node ?? '').trim()
    if (!node) throw new Error('every edit needs a node id')
    if (typeof edit.title !== 'string' && typeof edit.body !== 'string') continue
    upsertNode(base, {
      node,
      title: typeof edit.title === 'string' ? edit.title : undefined,
      body: typeof edit.body === 'string' ? edit.body : undefined,
      reviewed: true,
      // The panel is the user, and an explicit null clears whatever a model had put here. Omitting it would
      // leave the previous session's name on a node the user has just rewritten.
      by: null,
    })
    result.edited.push(node)
  }

  // Accepting a change without changing it. Without this the only way to clear a marker would
  // be to make a pointless edit, which trains the user to touch text just to nod at it.
  for (const raw of Array.isArray(review) ? review : []) {
    const node = String(raw ?? '').trim()
    if (!node) continue
    upsertNode(base, { node, reviewed: true })
    result.reviewed.push(node)
  }

  for (const link of Array.isArray(links) ? links : []) {
    if (!link || typeof link !== 'object') continue
    const from = String(link.from ?? '').trim()
    const to = String(link.to ?? '').trim()
    const note = typeof link.note === 'string' && link.note.trim() ? link.note.trim() : undefined
    try {
      addLink(base, { from, to, note })
      result.linksAdded.push({ from, to })
    } catch (error) {
      const message = (error && error.message) || ''
      if (/already/i.test(message)) result.linksAlreadyPresent.push({ from, to })
      else throw error
    }
  }

  for (const link of Array.isArray(removeLinks) ? removeLinks : []) {
    if (!link || typeof link !== 'object') continue
    const from = String(link.from ?? '').trim()
    const to = String(link.to ?? '').trim()
    try {
      removeLink(base, { from, to })
      result.linksRemoved.push({ from, to })
    } catch (error) {
      // Undo of something already gone is not a failure: the desired end state holds.
      const message = (error && error.message) || ''
      if (!/not linked/.test(message)) throw error
    }
  }

  if (result.edited.length || result.reviewed.length
    || result.linksAdded.length || result.linksRemoved.length) {
    await saveBase(path, base)
    invalidate(cwd)
  }
  return result
}

/** Read back everything the panel needs to render its controls. */
export async function readPanelState(cwd, sessionId) {
  const allBases = await basesInOrder(cwd)
  // The diary is one conversation's, not the workspace's. A session that is not keeping one should not even see it in
  // the list — the prompt filter stops it being read, and this stops it being offered.
  const ownDiary = (await readDiary(cwd, sessionId)) ? diaryBaseFor(sessionId) : null
  const bases = allBases.filter((base) => !isDiaryBase(base.id) || base.id === ownDiary)
  const selection = await readSelection(cwd)
  return {
    bases: bases.map((base) => base.id),
    // No file yet means every base is on, which is what the outline module assumes too.
    enabled: selection === null ? bases.map((base) => base.id) : [...selection],
    // The settings page renders a recorder checkbox per workspace, so the flag has to come back with the entry.
    // The one unwrapped await in this loop before now: an exception here aborted the whole list, and every workspace
    // after it disappeared from the settings page without a word. Same defensive shape as the fields above it.
    live: await readLive(cwd).catch(() => false),
      attachmentMode: await readAttachmentMode(cwd),
    inject: await readInject(cwd),
    nodeInject: await readNodeInject(cwd),
    positions: await readLayout(cwd),
    colors: await readColors(cwd),
    // `shapes`, not `modes`: how a base is drawn. The injection switch is `inject` in selection.json, and
    // naming this one `modes` invited exactly the confusion a test session ran into.
    shapes: await readShapes(cwd),
    widths: await readWidths(cwd),
    sizes: await readSizes(cwd),
  }
}

function send(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // No permissive CORS on purpose: writes must stay same-origin.
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body is too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Every Session the host will name, or an empty array when it will not name any.
 *
 * The method that lists sessions is not contractual and has already been guessed wrong once, so the
 * plausible names are tried in order and the result is validated rather than trusted. Returning an empty
 * array is a real answer — the settings page then shows the workspace of the session that asked, which is
 * the only one it can prove exists.
 */
function allSessions(ctx) {
  const service = ctx.sessions
  if (!service) return []
  const attempts = ['list', 'all', 'ids', 'values', 'recent']
  for (const name of attempts) {
    if (typeof service[name] !== 'function') continue
    try {
      const value = service[name]()
      if (!Array.isArray(value)) continue
      // Either ids, or session-like objects; both are handled by the caller.
      return value
    } catch {
      // A method that exists and throws is not the one; try the next.
    }
  }
  return []
}

/**
 * The workspaces this host knows about, each with the bases it holds and which are on.
 *
 * A workspace is named by a Session id, never a path: the browser picks from this list and the host
 * resolves it, which is the rule this route family has followed since it was written.
 */
/**
 * @param home where this installation keeps its `sessions/` directory. Explicit rather than read from the environment
 *   here, so a test can say "no disk" instead of inheriting the machine it happens to run on.
 */
export async function listWorkspaces(ctx, currentSessionId, home = process.env.DSH_HOME) {
  const seen = new Map()
  const add = (sessionId, cwd) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return
    if (!seen.has(cwd)) seen.set(cwd, sessionId)
  }
  for (const entry of allSessions(ctx)) {
    try {
      const session = typeof entry === 'string' ? ctx.sessions.get(entry) : entry
      add(session && session.header ? session.header.id : undefined, session && session.header ? session.header.cwd : undefined)
    } catch {
      // One unreadable Session must not cost the whole list.
    }
  }
  // The session that asked is always present, whether or not the enumeration worked.
  try {
    const current = ctx.sessions.get(currentSessionId)
    add(currentSessionId, current && current.header ? current.header.cwd : undefined)
  } catch {
    // Nothing: the list is simply what it is.
  }

  const out = []
  for (const [cwd, sessionId] of seen) {
    let bases = []
    try {
      bases = await listBases(cwd)
    } catch {
      bases = []
    }
    let enabled = null
    try {
      const selection = await readSelection(cwd)
      enabled = selection === null ? null : [...selection]
    } catch {
      enabled = null
    }
    let inject = {}
    try {
      inject = await readInject(cwd)
    } catch {
      inject = {}
    }
    out.push({
      sessionId,
      name: cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || cwd,
      cwd,
      // 'full' injects the bodies, 'index' only the summary. Absence means index, which is what every
      // base did before this existed.
      bases: bases.map((base) => ({ id: base.id, name: base.name, mode: inject[base.id] || 'index' })),
      // null means "every base", which is what a workspace with no selection file means.
      enabled,
      // The settings page draws the recorder switch from this. It was added to `readPanelState` first by mistake —
      // the same `enabled:` line exists in both functions — so the panel knew the flag and the settings page did not.
      live: await readLive(cwd).catch(() => false),
      attachmentMode: await readAttachmentMode(cwd),
    })
  }
  // What the enumeration actually produced, and who it thought was asking. Two wrong theories about why the
  // settings page listed one workspace instead of three is one too many; this line answers it next time the page is
  // opened.
  log('workspaces: asked by ' + String(currentSessionId ?? '(none)') + ', ' + seen.size + ' cwd(s): '
    + ([...seen.keys()].join(', ') || '(none)'))
  // Every workspace that has a knowledge base, worked out from the session store on disk.
  //
  // The enumeration above only answers for sessions this process is holding, so the same request returned one workspace
  // or three depending on what had been opened. The store is not like that: a workspace that ran a session once keeps a
  // directory there.
  const known = new Set(out.map((entry) => entry.cwd))
  for (const cwd of workspacesWithKnowledge(home)) {
    if (known.has(cwd)) continue
    let bases = []
    try {
      bases = await listBases(cwd)
    } catch {
      bases = []
    }
    if (bases.length === 0) continue
    let enabled = null
    try {
      const selection = await readSelection(cwd)
      enabled = selection === null ? null : [...selection]
    } catch {
      enabled = null
    }
    let inject = {}
    try {
      inject = await readInject(cwd)
    } catch {
      inject = {}
    }
    out.push({
      // No session of its own, so its switches write the workspace default — the honest scope for a workspace nothing
      // is currently running in.
      sessionId: null,
      name: cwd.split(/[\\/]/).filter(Boolean).slice(-1)[0] || cwd,
      cwd,
      bases: bases.map((base) => ({ id: base.id, name: base.name, mode: inject[base.id] || 'index' })),
      enabled,
      live: await readLive(cwd).catch(() => false),
      attachmentMode: await readAttachmentMode(cwd),
    })
  }

  out.sort((left, right) => left.cwd.localeCompare(right.cwd))
  return out
}

/** The workspace of one Session, resolved on the host. The browser never names a directory. */
async function workspaceOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('a Session id is required')
  let session
  try {
    session = ctx.sessions && typeof ctx.sessions.get === 'function' ? await ctx.sessions.get(sessionId) : undefined
  } catch {
    session = undefined
  }
  if (session && session.header) {
    const cwd = session.header.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('that Session has no workspace directory')
    return cwd
  }

  // Restored tabs can read workspace files before an Agent/Session is resident. Read only the
  // host-owned creation header: do not resume an agent or load/replay its conversation log.
  const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
  if (!persistence || typeof persistence.open !== 'function') throw new Error('that Session has no workspace directory')
  const handle = await persistence.open(sessionId, 'read')
  try {
    const header = handle.header
    if (!header || header.id !== sessionId) throw new Error('the stored Session identity does not match')
    const cwd = header.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('that Session has no workspace directory')
    return cwd
  } finally {
    await handle.close()
  }
}
/**
 * The workspace a write applies to.
 *
 * A request may name one, because the settings page edits workspaces other than the current one. The name is only honoured when
 * it is a workspace this process already knows about: a resident session's cwd, or a directory with a knowledge folder. Anything
 * else is refused — otherwise this route would write wherever a request pointed.
 */
async function workspaceForWrite(ctx, payload) {
  const asked = typeof payload?.workspace === 'string' ? payload.workspace.trim() : ''
  if (!asked) return workspaceOf(ctx, payload?.session)

  const resolved = resolve(asked)
  const home = process.env.DSH_HOME
  const known = new Set(workspacesWithKnowledge(home).map((cwd) => resolve(cwd)))
  for (const entry of allSessions(ctx)) {
    try {
      const session = typeof entry === 'string' ? ctx.sessions.get(entry) : entry
      const cwd = session && session.header ? session.header.cwd : undefined
      if (typeof cwd === 'string' && cwd.length > 0) known.add(resolve(cwd))
    } catch {
      // One unreadable Session must not block the rest.
    }
  }
  if (!known.has(resolved)) throw new Error(`unknown workspace "${asked}"`)
  return resolved
}


/**
 * Build the route handler. Kept as a factory so `index.js` owns registration and disposal.
 * @param ctx - the plugin context, for `ctx.sessions`.
 * @returns an HTTP handler owning the full response lifecycle.
 */
export function createHandler(ctx) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(PREFIX)) {
      send(res, 404, { ok: false, error: 'not found' })
      return
    }
    const action = url.pathname.slice(PREFIX.length).replace(/^\/+|\/+$/g, '')

    try {
      // Its own branch, above the state branch: nesting it inside that one made it require
      // action === 'state' as well, which no /workspaces request can satisfy.
      if (req.method === 'GET' && action === 'workspaces') {
        send(res, 200, { ok: true, workspaces: await listWorkspaces(ctx, url.searchParams.get('session')) })
        return
      }

      if (req.method === 'GET' && action === 'state') {
        const session = url.searchParams.get('session')
        const cwd = await workspaceOf(ctx, session)
        send(res, 200, { ok: true, ...(await readPanelState(cwd, session)) })
        return
      }

      // The sprite grid, as bytes.
      //
      // Served rather than embedded: as a data URI the sheet made the panel bundle 547 KB, and every panel load paid
      // for it. This way the bytes are fetched once by the browser and cached, and replacing the art no longer means
      // rebuilding client.js.
      // A picture attached to a node. The path is matched against a whitelist, so there is no ".." to filter: anything else is
  // simply not this shape.
  if (action === 'asset') {
    // By workspace, not by session: an <img> request carries no session of its own, and a picture belongs to the workspace it
    // is stored in. The same guard as every other write applies — an unknown workspace is refused.
    // Either names the workspace: the panel only has a session id, a link or a script may have the path. `workspace` wins when
    // both are present, and an unknown one is still refused.
    const askedWorkspace = url.searchParams.get('workspace')
    const cwd = askedWorkspace
      ? await workspaceForWrite(ctx, { workspace: askedWorkspace })
      : await workspaceOf(ctx, url.searchParams.get('session'))
    const rel = String(url.searchParams.get('path') || '')
    if (!/^assets\/[a-f0-9]{16}\.[a-z0-9]{1,12}$/.test(rel)) {
      send(res, 400, { ok: false, error: 'not an asset path' })
      return
    }
    try {
      const bytes = await readFile(join(cwd, '.dsh-knowledge', rel))
      res.writeHead(200, { 'content-type': mimeOfAny(rel), 'cache-control': 'public, max-age=31536000, immutable' })
      res.end(bytes)
    } catch {
      send(res, 404, { ok: false, error: 'no such image' })
    }
    return
  }

  if (req.method === 'GET' && /^whale(-[a-z]+)?\.png$/.test(action)) {
        try {
          // The action comes from the URL, so it is checked above against a narrow shape and then used as a file name. A
          // whitelist rather than sanitising: the only names that exist are these three.
          const here = dirname(fileURLToPath(import.meta.url))
          const bytes = await readFile(join(here, '..', 'assets', action))
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' })
          res.end(bytes)
        } catch (error) {
          send(res, 404, { ok: false, error: 'no sprite in the package: ' + ((error && error.message) || error) })
        }
        return
      }

      if (req.method !== 'PUT' && req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'use GET /state or PUT an action' })
        return
      }

      // A JSON content type is what makes a cross-site write fail its preflight.
      const type = String(req.headers['content-type'] ?? '')
      if (!type.toLowerCase().includes('application/json')) {
        send(res, 415, { ok: false, error: 'content-type must be application/json' })
        return
      }

      const raw = await readBody(req)
      let payload
      try {
        payload = raw ? JSON.parse(raw) : {}
      } catch {
        send(res, 400, { ok: false, error: 'body is not valid JSON' })
        return
      }
      if (!payload || typeof payload !== 'object') {
        send(res, 400, { ok: false, error: 'body must be a JSON object' })
        return
      }

      if (action === 'diaryreplies' || action === 'diaryreply') {
        if (payload.workspace !== undefined) throw new Error('日记回复只能发送到当前会话，不能指定其他工作区')
        const session = payload.session
        const cwd = await workspaceOf(ctx, session)
        if (action === 'diaryreplies') {
          const replies = await readDiaryReplies(cwd, session, payload.base, payload.node)
          send(res, 200, { ok: true, replies })
        } else {
          const result = await submitDiaryReply(ctx, cwd, session, payload)
          send(res, 200, { ok: true, ...result })
        }
        return
      }

      const cwd = await workspaceForWrite(ctx, payload)

      if (action === 'attachmentMode') {
        const attachmentMode = await writeAttachmentMode(cwd, payload.mode)
        send(res, 200, { ok: true, attachmentMode })
        return
      }
      if (action === 'selection') {
        // The settings page flips the recorder through this same PUT: it is a workspace-level flag, and the page
        // already knows which workspace it is editing. One route for one page beats two that can disagree.
        if (typeof payload.live === 'boolean') await writeLive(cwd, payload.live);
        send(res, 200, { ok: true, ...(await setSelection(cwd, payload.enabled, payload.session, payload.scope)),
          // Without this the panel has no way to learn the new state, so its copy of the flag never changes.
          live: await readLive(cwd) })
        return
      }
      // A picture pasted or dropped into the editor. The bytes come in base64 because that is what a FileReader gives us; the
  // size cap is checked before decoding so a big paste fails fast rather than after allocating it.
  // One asset as base64, for the panel: it cannot read the file itself, and a node handed to the conversation should carry its
  // pictures and documents instead of a line of markdown pointing at them.
  if (action === 'assetBytes') {
    const rel = String(payload.path || '')
    if (!/^assets\/[a-f0-9]{16}\.[a-z0-9]{1,12}$/.test(rel)) {
      send(res, 400, { ok: false, error: 'not an asset path' })
      return
    }
    try {
      const bytes = await readFile(join(cwd, '.dsh-knowledge', rel))
      if (bytes.length > 8 * 1024 * 1024) {
        send(res, 400, { ok: false, error: 'asset is larger than 8 MB' })
        return
      }
      send(res, 200, {
        ok: true,
        name: rel.split('/').pop(),
        mime: mimeOfAny(rel),
        base64: Buffer.from(bytes).toString('base64'),
      })
    } catch {
      send(res, 404, { ok: false, error: 'no such asset' })
    }
    return
  }
  if (action === 'putAsset') {
    const ext = String(payload.ext || '').toLowerCase()
    const base64 = String(payload.base64 || '')
    if (!base64) {
      send(res, 400, { ok: false, error: 'no image data' })
      return
    }
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length > 8 * 1024 * 1024) {
      send(res, 400, { ok: false, error: 'image is larger than 8 MB' })
      return
    }
    const saved = await putAssetBytes(cwd, bytes, '.' + ext)
    send(res, 200, { ok: true, rel: saved.rel, bytes: saved.bytes })
    return
  }
  if (action === 'createNode') {
        send(res, 200, {
          ok: true,
          ...(await createNodeFromPanel(cwd, payload.base, {
            title: payload.title,
            body: payload.body,
            parent: payload.parent,
          })),
        })
        return
      }
      if (action === 'purgeNode') {
        send(res, 200, { ok: true, ...(await purgeNodeFromPanel(cwd, payload.base, payload.node)) })
        return
      }
      if (action === 'removeNode') {
        send(res, 200, { ok: true, ...(await removeNodeFromPanel(cwd, payload.base, payload.node)) })
        return
      }
      if (action === 'live') {
        // A boolean writes; its absence reads. One action for both, so the panel cannot ask for one and get the other.
        const live = typeof payload.on === 'boolean'
          ? await writeLive(cwd, payload.on)
          : await readLive(cwd);
        send(res, 200, { ok: true, live });
        return
      }
      if (action === 'diary') {
        // Per session: `on` writes this session's answer, and its absence reads the effective one.
        const session = payload.session
        const diary = typeof payload.on === 'boolean'
          ? await writeDiary(cwd, payload.on, session)
          : await readDiary(cwd, session);
        send(res, 200, { ok: true, diary });
        return
      }
      if (action === 'diary-get') {
        // The panel cannot read this one off disk: it is sealed. Only the conversation that keeps it may ask for the plain
        // text, and only by the name it is already allowed to see.
        const own = diaryBaseFor(payload.session)
        const wanted = String(payload.id || '')
        if (!own || wanted !== own || !(await readDiary(cwd, payload.session))) {
          send(res, 404, { ok: false, error: 'there is no knowledge base "' + wanted + '" in this workspace' })
          return
        }
        try {
          const { base } = await loadBase(cwd, wanted)
          send(res, 200, { ok: true, base })
        } catch (error) {
          send(res, 404, { ok: false, error: String((error && error.message) || error) })
        }
        return
      }
      if (action === 'revert') {
        // Undo every unreviewed change in one base. The button lives next to the read counters, because 'unreviewed' is the
        // same set those counters describe.
        // A node id makes it precise: undo that one node's change and nothing else.
  if (typeof payload.node === 'string' && payload.node.trim()) {
    const id = assertId(String(payload.base || ''), 'base id')
    const { base, path: file } = await loadBase(cwd, id)
    const what = revertNode(base, assertId(payload.node.trim(), 'node id'))
    if (what) {
      await saveBase(file, base)
      await pruneNodeInject(cwd, id, base.nodes.map((entry) => entry.id))
      invalidate(cwd)
    }
    send(res, 200, { ok: true, reverted: what || 'nothing' })
    return
  }
  // No base named means every base: the header button is "undo everything I have not looked at yet".
        const wanted = typeof payload.base === 'string' && payload.base.trim()
          ? [assertId(payload.base.trim(), 'base id')]
          : null
        const ids = wanted || (await listBases(cwd)).map((entry) => entry.id)
        const total = { added: 0, modified: 0, removed: 0 }
        for (const id of ids) {
          try {
                                const { base, path: file } = await loadBase(cwd, id)
                    const counts = revertUnreviewed(base)
            if (counts.added + counts.modified + counts.removed > 0) {
              await saveBase(file, base)
              await pruneNodeInject(cwd, id, base.nodes.map((entry) => entry.id))
              total.added += counts.added
              total.modified += counts.modified
              total.removed += counts.removed
            }
          } catch {
            // One unreadable base is not a reason to leave the others alone.
          }
        }
        invalidate(cwd)
        send(res, 200, { ok: true, reverted: total })
        return
      }
      if (action === 'activity') {
        send(res, 200, {
          ok: true,
          ...(await readActivity(cwd, { session: payload.session, limit: payload.limit })),
        })
        return
      }
      if (action === 'parent') {
        send(res, 200, {
          ok: true,
          ...(await setParent(cwd, payload.base, { node: payload.node, parent: payload.parent })),
        })
        return
      }
      if (action === 'width') {
        send(res, 200, {
          ok: true,
          ...(await setWidth(cwd, payload.base, {
            node: payload.node,
            width: payload.width,
            height: payload.height,
          })),
        })
        return
      }
      if (action === 'shape') {
        send(res, 200, { ok: true, ...(await setShape(cwd, payload.base, payload.shape)) })
        return
      }
      if (action === 'color') {
        send(res, 200, {
          ok: true,
          ...(await setColor(cwd, payload.base, payload.node, payload.color)),
        })
        return
      }
      if (action === 'order') {
        send(res, 200, { ok: true, ...(await setOrder(cwd, payload.order)) })
        return
      }
      // The panel writes one line into the host log, on purpose and by hand.
      //
      // Added because "the canvas is heavy with a big base" took seven wrong guesses: each theory was
      // checked by reading the code, and none survived contact with the machine. The measurement that would
      // settle it lives in the browser — the one place this side cannot look — so the browser reports.
      // A diagnostic, not a feature: nothing calls it unless someone is chasing a frame budget.
      if (action === 'diag') {
        log('panel diag: ' + String(payload.text ?? '').slice(0, 500))
        send(res, 200, { ok: true })
        return
      }
      if (action === 'nodeInject') {
        const baseId = String(payload.base ?? '')
        const nodeId = String(payload.node ?? '')
        if (!['inherit', 'full', 'index'].includes(payload.mode)) throw new Error('invalid node injection mode')
        const visible = await readPanelState(cwd, payload.session)
        if (!visible.bases.includes(baseId)) throw new Error('this knowledge base is not available to this Session')
        const { base } = await loadBase(cwd, baseId)
        if (!base.nodes.some((node) => node.id === nodeId)) throw new Error('no such node')
        const nodeInject = await writeNodeInject(cwd, baseId, nodeId, payload.mode)
        await refreshPolicies(cwd)
        send(res, 200, { ok: true, nodeInject })
        return
      }
      if (action === 'inject') {
        if (typeof payload.session !== 'string' || payload.session.length === 0) {
          throw new Error('an injection mode needs the Session it applies to')
        }
        const baseId = String(payload.base ?? '')
        if (!baseId) throw new Error('an injection mode needs a base id')
        if (payload.mode !== 'full' && payload.mode !== 'index') {
          throw new Error('an injection mode is either full or index')
        }
        const inject = await writeInject(cwd, baseId, payload.mode)
        // The prompt is built from this, so the cached outline is now wrong.
        await refreshPolicies(cwd)
        send(res, 200, { ok: true, inject })
        return
      }

      if (action === 'name') {
        if (typeof payload.session !== 'string' || payload.session.length === 0) {
          throw new Error('a name needs the Session it belongs to')
        }
        // The workspace comes from whichever session the panel is looking at, and the id is the one being
        // named: the panel passes its own id in `session`, because that is what resolves the workspace.
        const target = typeof payload.target === 'string' && payload.target ? payload.target : payload.session
        send(res, 200, { ok: true, names: await writeName(cwd, target, payload.name) })
        return
      }

      if (action === 'layout') {
        send(res, 200, { ok: true, ...(await setLayout(cwd, payload.base, payload.positions)) })
        return
      }
      if (action === 'rename') {
        send(res, 200, { ok: true, ...(await renameBaseFromPanel(cwd, payload.base, payload.name)) })
        return
      }
      if (action === 'remove') {
        send(res, 200, { ok: true, ...(await removeBaseFromPanel(cwd, payload.base)) })
        return
      }
      if (action === 'linkNote') {
        send(res, 200, { ok: true, ...(await setLinkNoteFromPanel(cwd, payload)) })
        return
      }
      if (action === 'changes') {
        send(res, 200, {
          ok: true,
          ...(await applyChanges(cwd, payload.base, {
            edits: payload.edits,
            links: payload.links,
            removeLinks: payload.removeLinks,
            review: payload.review,
          })),
        })
        return
      }

      send(res, 404, { ok: false, error: `unknown action "${action}"` })
    } catch (error) {
      // The message is shown in the panel, so it has to be the real reason rather than a
      // generic failure: "no knowledge base \"x\"" is actionable, "500" is not.
      send(res, 400, { ok: false, error: (error && error.message) || String(error) })
    }
  }
}
