/**
 * The two files that are not knowledge.
 *
 * `<workspace>/.dsh-knowledge/selection.json` says which bases the Session is reading — that
 * decides what goes into the prompt, so the model has a tool for it too.
 *
 * `<workspace>/.dsh-knowledge/layout.json` says where the user dragged the boxes. It is kept
 * apart from the bases on purpose: where a box sits is not knowledge, it must never reach the
 * prompt, and it should not show up as noise in the file the user reviews.
 *
 * Both writes are atomic-ish: written to a temporary name and renamed over the target, so a
 * crash or a concurrent reader never sees a half-written JSON file.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DIRNAME, listBases } from './store.js'
import { sessionFileStem } from './session.js'
import { log } from './log.js'

/**
 * Write JSON through a temporary file so readers never see a partial document.
 *
 * The temporary name carries the process and a counter. It used to be just `${path}.tmp`, which two
 * concurrent writers share: one writes its bytes, the other writes its own over the same file, and whichever
 * renames second installs a document that is half of each. That is how `layout.json` ended up with a stray
 * `"names": {}` and a second closing brace after the real end — and a file that no longer parses takes the
 * whole panel down with it.
 */
let temporaryCount = 0
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  temporaryCount += 1
  const temporary = `${path}.${process.pid}.${temporaryCount}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8')
    await rename(temporary, path)
  } catch (error) {
    // A failed write must not leave its scratch file behind for the next reader to trip over.
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Run one read-modify-write at a time, per file.
 *
 * `patchLayout` reads the file, merges one key, and writes the whole document back. Two of those overlapping
 * — which is exactly what a mode change produces, because it posts `mode` and `layout` together — means the
 * second read sees the state from before the first wrote, and the first change is silently dropped. Queueing
 * per path makes them sequential, so each merge sees the previous one's result.
 */
const writeQueues = new Map()
function serialize(key, job) {
  const previous = writeQueues.get(key) || Promise.resolve()
  const next = previous.then(job, job)
  // Kept as a settled promise so a rejected job does not poison every write that follows it.
  writeQueues.set(key, next.then(() => undefined, () => undefined))
  return next
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** The arrangements the panel offers. Kept here so a bad value cannot be stored. */
const SHAPES = new Set(['layers', 'radial', 'staircase', 'compact'])

/**
 * A session id as a file name.
 *
 * It used to be a whitelist, and the whitelist had no colon in it — so every QQ session, whose id is
 * `im:qq_…:dm:…:…`, was refused here. The refusal was thrown from a path helper, so the visible symptom was
 * not an error but silence: per-session switches did nothing on IM and fell back to the workspace default.
 *
 * Encoding instead of refusing keeps the directory safe and lets those sessions have their own list. A plain
 * id is unchanged, so existing `.sessions/*.json` files keep their names.
 */
function safeSessionId(sessionId) {
  return sessionFileStem(sessionId)
}

/** Where one session's own selection lives. */
export function sessionSelectionPath(cwd, sessionId) {
  return join(dirname(selectionPath(cwd)), '.sessions', safeSessionId(sessionId) + '.json')
}

/**
 * One session's own list, or null when it has none.
 *
 * Null and an empty set are different answers: null means "use the workspace default", and an empty set
 * means "this session reads nothing", which is a legitimate choice and has to remain expressible.
 */
export async function readSessionSelection(cwd, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  let raw = null
  try {
    raw = await readJson(sessionSelectionPath(cwd, sessionId))
  } catch {
    return null
  }
  if (!raw || !Array.isArray(raw.enabled)) return null
  return new Set(raw.enabled.filter((id) => typeof id === 'string'))
}

/** Set one session's own list. */
export async function writeSessionSelection(cwd, sessionId, enabled) {
  const path = sessionSelectionPath(cwd, sessionId)
  await mkdir(dirname(path), { recursive: true })
  const clean = [...enabled].filter((id) => typeof id === 'string')
  await writeJson(path, { version: 1, enabled: clean })
  return clean
}

/**
 * Which bases are injected whole: { [baseId]: 'full' }. Absent means the index, which is the default
 * because it is what every base did before this existed.
 */
export async function readInject(cwd) {
  const raw = await readJson(selectionPath(cwd))
  const inject = raw && typeof raw === 'object' ? raw.inject : undefined
  if (!inject || typeof inject !== 'object') return {}
  const clean = {}
  for (const [id, mode] of Object.entries(inject)) {
    if (mode === 'full' && typeof id === 'string' && id) clean[id] = 'full'
  }
  return clean
}

/** Set one base's injection mode. 'index' clears it, because index is the absence of a choice. */
export async function writeInject(cwd, baseId, mode) {
  const id = String(baseId || '')
  if (!id) throw new Error('injection mode needs a base id')
  const after = Object.assign({}, await readInject(cwd))
  if (mode === 'full') after[id] = 'full'
  else delete after[id]
  const raw = (await readJson(selectionPath(cwd))) || {}
  const enabled = Array.isArray(raw.enabled) ? raw.enabled : []
  const keep = (value) => (value && typeof value === 'object' ? value : undefined)
  await writeJson(selectionPath(cwd), {
    version: 1,
    enabled,
    ...(keep(raw.order) ? { order: raw.order } : {}),
    ...(Object.keys(after).length ? { inject: after } : {}),
  })
  return after
}

export function selectionPath(cwd) {
  return join(cwd, DIRNAME, 'selection.json')
}

export function layoutPath(cwd) {
  return join(cwd, DIRNAME, 'layout.json')
}

/**
 * Which bases are switched on.
 * @returns a Set of base ids, or null meaning "no file yet, so all of them".
 */
export async function readSelection(cwd, sessionId) {
  // A session with its own list answers with it; otherwise the workspace default does; and a workspace
  // with no file at all answers null, which callers already read as "all of them".
  const own = await readSessionSelection(cwd, sessionId)
  if (own !== null) return own
  const raw = await readJson(selectionPath(cwd))
  if (raw && Array.isArray(raw.enabled)) return new Set(raw.enabled.map(String))
  return null
}

/** Persist the enabled set. Any saved order is kept: a toggle is not a reordering. */
export async function writeSelection(cwd, enabled, sessionId) {
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    return writeSessionSelection(cwd, sessionId, enabled)
  }
  const clean = []
  for (const id of enabled) {
    const value = String(id)
    if (!clean.includes(value)) clean.push(value)
  }
  const order = await readOrder(cwd)
  const inject = await readInject(cwd)
  await writeJson(selectionPath(cwd), { version: 1, enabled: clean, ...(order ? { order } : {}),
    ...(Object.keys(inject).length ? { inject } : {}) })
  return clean
}

/**
 * The user's ordering of the bases, by id.
 *
 * Kept in the same file as the switches because it is the same kind of thing — how this workspace
 * wants its bases presented — and because it must cover bases that are switched off, which an
 * ordering derived from `enabled` could not do.
 *
 * @returns an array of ids, or null meaning "no order chosen, use the default".
 */
export async function readOrder(cwd) {
  const raw = await readJson(selectionPath(cwd))
  if (raw && Array.isArray(raw.order)) return raw.order.map(String)
  return null
}

/** Persist the ordering, leaving the switches as they are. */
export async function writeOrder(cwd, order) {
  const clean = []
  for (const id of order) {
    const value = String(id)
    if (!clean.includes(value)) clean.push(value)
  }
  const raw = await readJson(selectionPath(cwd))
  const enabled = raw && Array.isArray(raw.enabled) ? raw.enabled.map(String) : []
  const inject = await readInject(cwd)
  await writeJson(selectionPath(cwd), { version: 1, enabled, order: clean,
    ...(Object.keys(inject).length ? { inject } : {}) })
  return clean
}

/**
 * Every base, in the order the user arranged them.
 *
 * This is the order the panel lists them in and the order the prompt outline uses, so dragging the
 * most important base to the top is a real change rather than a cosmetic one. Anything the user has
 * not placed keeps the default position, relative to the other unplaced ones — `sort` is stable.
 */
export async function basesInOrder(cwd) {
  const bases = await listBases(cwd)
  const order = await readOrder(cwd)
  if (!order || order.length === 0) return bases
  const rank = new Map(order.map((id, index) => [id, index]))
  const placed = (base) => (rank.has(base.id) ? rank.get(base.id) : Number.MAX_SAFE_INTEGER)
  return bases.slice().sort((left, right) => placed(left) - placed(right))
}

/** The default width of a node box. */
export const DEFAULT_WIDTH = 176;
/** The range a width is allowed to take. Below this the text is unreadable; above it a row cannot fit. */
export const MIN_WIDTH = 120;
export const MAX_WIDTH = 720;
/** A box shorter than this cannot show a title; taller than this and the canvas is all one node. */
export const MIN_HEIGHT = 40;
export const MAX_HEIGHT = 2000;

/**
 * Read layout.json and write it back with one field replaced.
 *
 * Every field is named here and nowhere else. The three writers that used to do this themselves each
 * carried a copy of the whole shape, so each was a place to forget a field and silently drop it.
 */
async function patchLayout(cwd, patch) {
  // Serialized: a mode change posts two patches at once, and without this the second would read the file
  // before the first had written it and drop the first one's key.
  return serialize(layoutPath(cwd), async () => {
    const raw = (await readJson(layoutPath(cwd))) || {}
    const keep = (value) => (value && typeof value === 'object' ? value : {})
    await writeJson(layoutPath(cwd), {
      version: 1,
      positions: keep(raw.positions),
      colors: keep(raw.colors),
      // `modes` was the old name for this and reads as the injection switch; see readShapes. Dropping it from
      // this list is what migrates the file: patchLayout rebuilds from these keys, so a key that is neither
      // listed nor in the patch does not survive the next write.
      shapes: keep(raw.shapes || raw.modes),
      widths: keep(raw.widths),
      sizes: keep(raw.sizes),
      // What the user calls each session. Presentation, like the colours: it must not reach the prompt.
      names: keep(raw.names),
      ...patch,
    })
  })
}

/** What the user calls each session: { [sessionId]: name }. Never reaches the prompt. */
export async function readNames(cwd) {
  const raw = await readJson(layoutPath(cwd))
  const names = raw && typeof raw === 'object' ? raw.names : undefined
  if (!names || typeof names !== 'object') return {}
  const clean = {}
  for (const [id, name] of Object.entries(names)) {
    // A name is a label, not a document. Trimmed, bounded, and empty means "no name".
    if (typeof name === 'string' && name.trim()) clean[id] = name.trim().slice(0, 40)
  }
  return clean
}

/** Set one session's name, or clear it with an empty string. */
export async function writeName(cwd, sessionId, name) {
  // No character whitelist here, and that is the point. This id becomes a key in layout.json, not a file
  // name, so nothing about it can escape anywhere — but the same regex that guarded the path was copied
  // here, and it rejected every IM session's id (`im:qq_…:dm:…`) for containing colons. Naming a session
  // then failed with "unusable session id", which is the same silent-shape failure as o15 by another door.
  const id = String(sessionId || '')
  if (!id) throw new Error('a name needs a session')
  const all = Object.assign({}, await readNames(cwd))
  const clean = typeof name === 'string' ? name.trim().slice(0, 40) : ''
  if (clean) all[id] = clean
  else delete all[id]
  await patchLayout(cwd, { names: all })
  return all
}

/** Dragged box positions: { [baseId]: { [nodeId]: { x, y } } }. */
export async function readLayout(cwd) {
  const raw = await readJson(layoutPath(cwd))
  if (!raw || typeof raw !== 'object') return {}
  const positions = raw.positions
  return positions && typeof positions === 'object' ? positions : {}
}

/**
 * Which arrangement each base uses. One of layers, radial, staircase, compact.
 *
 * Presentation, like the colours: it says how the reader wants to look at a base, not what the base
 * contains, so it stays out of the base files and out of the prompt.
 *
 * Stored under `shapes`, and it used to be stored under `modes` — a name that collided with the thing it
 * has nothing to do with. The real injection switch is `inject` in selection.json, and a test session read
 * `modes: { ops: 'layers' }`, took it for that switch, changed it, and wrote the wrong conclusion into its
 * knowledge base before working out what it had actually touched. `layout.json` is not where injection lives;
 * this field is about how boxes are drawn.
 *
 * The old key is still read, so existing workspaces keep their arrangement — and it is rewritten here, on
 * read, rather than left for the next layout write. Leaving it was the first version: `patchLayout` rebuilds
 * the file from its own key list, so dropping `modes` from that list *would* remove it — but only when
 * something writes, and the things that write are dragging and resizing. A test session then read
 * `layout.json` three times, found `modes: {}` still there each time, and reasonably reported the rename as
 * not having taken effect. A decoy field that survives until an unrelated user action is still a decoy.
 *
 * So: if only the old key is present, fold it into `shapes` and write once. Guarded by the key's absence, so
 * it happens at most once per workspace, and it cannot throw into a read.
 */
export async function readShapes(cwd) {
  const raw = await readJson(layoutPath(cwd))
  const held = raw && typeof raw === 'object' ? (raw.shapes || raw.modes) : undefined
  const clean = {}
  if (held && typeof held === 'object') {
    for (const [base, shape] of Object.entries(held)) {
      if (SHAPES.has(shape)) clean[base] = shape
    }
  }
  const stale = raw && typeof raw === 'object' && raw.shapes === undefined && raw.modes !== undefined
  if (stale) {
    try {
      await patchLayout(cwd, { shapes: clean })
    } catch (error) {
      // A read that fails because its migration failed is worse than a stale key. The next read retries.
      log('could not migrate layout.modes: ' + ((error && error.message) || error))
    }
  }
  return clean
}

/** Set one base's arrangement, leaving every other field alone. */
export async function writeShape(cwd, baseId, shape) {
  if (!SHAPES.has(shape)) throw new Error('unknown layout shape "' + shape + '"')
  const shapes = Object.assign({}, await readShapes(cwd), { [baseId]: shape })
  // No `modes: undefined` here: patchLayout rebuilds the file from its own key list, so dropping `modes`
  // from that list is what removes the old key, once, on the next write.
  await patchLayout(cwd, { shapes })
  return shapes
}

/** Node colours: { [baseId]: { [nodeId]: '#rrggbb' } }. Presentation, never knowledge. */
export async function readColors(cwd) {
  const raw = await readJson(layoutPath(cwd))
  if (!raw || typeof raw !== 'object') return {}
  const colors = raw.colors
  return colors && typeof colors === 'object' ? colors : {}
}

/** Replace one base's colours, leaving every other field alone. */
export async function writeColors(cwd, baseId, colors) {
  const all = Object.assign({}, await readColors(cwd))
  const clean = {}
  for (const [nodeId, value] of Object.entries(colors || {})) {
    // Only a plain six-digit hex survives: this value is written straight into a style attribute.
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) clean[nodeId] = value.toLowerCase()
  }
  all[baseId] = clean
  await patchLayout(cwd, { colors: all })
  return clean
}

/** Replace one base's positions, leaving every other field alone. */
export async function writeLayout(cwd, baseId, positions) {
  const all = Object.assign({}, await readLayout(cwd))
  const clean = {}
  for (const [nodeId, spot] of Object.entries(positions || {})) {
    if (!spot || typeof spot !== 'object') continue
    const x = Number(spot.x)
    const y = Number(spot.y)
    // Coordinates come from a browser, so they are checked rather than trusted.
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    clean[nodeId] = { x: Math.round(x), y: Math.round(y) }
  }
  all[baseId] = clean
  await patchLayout(cwd, { positions: all })
  return clean
}

/** A width coming from a browser: whole pixels, inside the readable range. */
function cleanWidth(value) {
  const width = Math.round(Number(value))
  if (!Number.isFinite(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
    throw new Error('a node width must be between ' + MIN_WIDTH + ' and ' + MAX_WIDTH + ' pixels')
  }
  return width
}

/** Per-base widths: { [baseId]: number }. Every node in that base uses it unless it has its own. */
export async function readWidths(cwd) {
  const raw = await readJson(layoutPath(cwd))
  const widths = raw && typeof raw === 'object' ? raw.widths : undefined
  if (!widths || typeof widths !== 'object') return {}
  const clean = {}
  for (const [base, value] of Object.entries(widths)) {
    const width = Number(value)
    if (Number.isFinite(width) && width >= MIN_WIDTH && width <= MAX_WIDTH) clean[base] = Math.round(width)
  }
  return clean
}

/** Set one base's width. */
export async function writeBaseWidth(cwd, baseId, width) {
  const all = Object.assign({}, await readWidths(cwd), { [baseId]: cleanWidth(width) })
  await patchLayout(cwd, { widths: all })
  return all
}

/** Per-node widths: { [baseId]: { [nodeId]: number } }. */
export async function readSizes(cwd) {
  const raw = await readJson(layoutPath(cwd))
  const sizes = raw && typeof raw === 'object' ? raw.sizes : undefined
  if (!sizes || typeof sizes !== 'object') return {}
  const clean = {}
  for (const [base, perNode] of Object.entries(sizes)) {
    if (!perNode || typeof perNode !== 'object') continue
    const kept = {}
    for (const [nodeId, value] of Object.entries(perNode)) {
      // A bare number is what this field used to hold: a width. Reading it as one keeps the file that is
      // already on disk working, with no migration step to get wrong.
      const box = typeof value === 'number' ? { w: value } : value
      if (!box || typeof box !== 'object') continue
      const entry = {}
      const width = Number(box.w)
      if (Number.isFinite(width) && width >= MIN_WIDTH && width <= MAX_WIDTH) entry.w = Math.round(width)
      const height = Number(box.h)
      if (Number.isFinite(height) && height >= MIN_HEIGHT && height <= MAX_HEIGHT) entry.h = Math.round(height)
      if (Object.keys(entry).length > 0) kept[nodeId] = entry
    }
    clean[base] = kept
  }
  return clean
}

/** A height coming from a browser: whole pixels, inside the range a box can be. */
function cleanHeight(value) {
  const height = Math.round(Number(value))
  if (!Number.isFinite(height) || height < MIN_HEIGHT || height > MAX_HEIGHT) {
    throw new Error('a node height must be between ' + MIN_HEIGHT + ' and ' + MAX_HEIGHT + ' pixels')
  }
  return height
}

/**
 * Set one node's box, merging with whatever is already there.
 *
 * Merging matters: the edge drag can change the width while the corner drag changes both, and a write
 * that replaced the whole entry would drop the half it was not told about.
 */
export async function writeNodeBox(cwd, baseId, nodeId, box = {}) {
  const all = Object.assign({}, await readSizes(cwd))
  const current = Object.assign({}, all[baseId] && all[baseId][nodeId])
  if (box.w !== undefined) current.w = cleanWidth(box.w)
  if (box.h !== undefined) current.h = cleanHeight(box.h)
  if (Object.keys(current).length === 0) throw new Error('a node box needs a width or a height')
  all[baseId] = Object.assign({}, all[baseId], { [nodeId]: current })
  await patchLayout(cwd, { sizes: all })
  return all
}

/** Set one node's width, leaving its height as it was. */
export async function writeNodeWidth(cwd, baseId, nodeId, width) {
  return writeNodeBox(cwd, baseId, nodeId, { w: width })
}

/**
 * How wide one node box should be.
 *
 * Pure, and the order is the whole of it: a node's own width, then its base's, then the default. It is
 * also the input to the horizontal gap between siblings, which is why it is a separate function with
 * tests rather than an expression inside the layout.
 */
export function sizeOfNode(widths, sizes, baseId, nodeId) {
  const own = sizes && sizes[baseId] ? sizes[baseId][nodeId] : undefined
  const box = {};
  const width = own && typeof own === 'object' ? own.w : own
  if (Number.isFinite(width)) box.w = width
  else if (Number.isFinite(widths ? widths[baseId] : undefined)) box.w = widths[baseId]
  else box.w = DEFAULT_WIDTH
  const height = own && typeof own === 'object' ? own.h : undefined
  // Undefined rather than a default: no height means the box grows with its text, which is the normal
  // case and not something to invent a number for.
  if (Number.isFinite(height)) box.h = height
  return box
}

/** The width alone, for the layout, which cares about the gap rather than the shape. */
export function widthOf(widths, sizes, baseId, nodeId) {
  return sizeOfNode(widths, sizes, baseId, nodeId).w
}
