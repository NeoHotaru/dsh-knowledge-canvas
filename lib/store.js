/**
 * The knowledge bases on disk.
 *
 * `<workspace>/.dsh-knowledge/<id>.json` plus `selection.json`. One file per base, because a
 * model edit should touch one file: git diffs stay readable and two edits to different bases
 * cannot clobber each other.
 *
 * Node's own `fs/promises` rather than a harness service, so the host half needs no API it
 * has not already been verified to have. `node:` builtins also dodge the trap that a
 * `link:`ed plugin resolves harness imports upward from the checkout and fails.
 *
 * `change` on a node is the review marker: 'added', 'modified', 'removed', or null for
 * nothing unreviewed. The tools below set it; the panel draws it.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { isDiary, isSealed, open, seal } from './seal.js'
import { join } from 'node:path'
import { attachmentPage, attachmentPaths } from './attachments.js'

/** Directory holding the bases, relative to the Session workspace. */
export const DIRNAME = '.dsh-knowledge'

/** Files in that directory that are not bases. */
const NOT_A_BASE = new Set(['selection.json', 'layout.json', '.attachment-settings.json'])

/** A base id becomes a file name, so it is constrained rather than escaped. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i

/** Reject anything that could leave the directory or name a file we do not own. */
export function assertId(id, what) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new Error(`${what} must match ${ID_RE} (letters, digits, dashes; max 64)`)
  }
  return id
}

function dirFor(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('cannot reach the knowledge bases: this Session has no workspace directory')
  }
  return join(cwd, DIRNAME)
}

/** Where one base lives. Exported so callers never build a path by hand. */
export function pathFor(cwd, id) {
  return join(dirFor(cwd), assertId(id, 'base id') + '.json')
}

/** Where removed bases go: still on disk, out of every listing. */
export function removedDir(cwd) {
  return join(dirFor(cwd), '.removed')
}

/**
 * Rename a base.
 *
 * Only the display name changes. The id is a file name and is also what link targets, the
 * selection file and the panel's layout entries refer to, so renaming it would mean rewriting
 * every one of those references — a different, riskier operation than what the user means by
 * renaming a row.
 */
export async function renameBase(cwd, id, name) {
  const clean = typeof name === 'string' ? name.trim() : ''
  if (!clean) throw new Error('a base name cannot be empty')
  const { base, path } = await loadBase(cwd, id)
  base.name = clean
  await saveBase(path, base)
  return clean
}

/**
 * Take a base out of play without destroying it.
 *
 * Nodes are soft-deleted because a vanished node leaves nothing to review. That reason does not
 * carry over to a whole base — one created by mistake should just stop existing — but the
 * opposite extreme is worse: a base can hold a lot of work, and "delete" should not be the one
 * irreversible action in the plugin. So it is moved into a subdirectory instead, which
 * `listBases` never looks in, and can be moved back by hand.
 *
 * @returns the path it now lives at.
 */
export async function removeBase(cwd, id) {
  // Load first, so a missing base fails with a message about the base rather than a bare ENOENT
  // about a path nobody typed.
  await loadBase(cwd, id)
  const target = join(removedDir(cwd), `${assertId(id, 'base id')}-${Date.now()}.json`)
  await mkdir(removedDir(cwd), { recursive: true })
  await rename(pathFor(cwd, id), target)
  return target
}

/** Every base in the workspace, sorted by id; a missing directory is simply no bases. */
export async function listBases(cwd) {
  const dir = dirFor(cwd)
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const bases = []
  for (const name of names) {
    // selection.json and layout.json are state, not knowledge; they are skipped by name rather
    // than by shape, so a hand edit cannot make one look like a base.
    if (!name.endsWith('.json') || NOT_A_BASE.has(name)) continue
    try {
      // Same handling as loadBase: a sealed file is opened with the key its own id gives. Two readers, one format — the
      // one that forgets is the one the outline uses.
      const raw = await readFile(join(dir, name), 'utf8')
      const id = name.replace(/\.json$/, '')
      const parsed = isSealed(raw) ? open(id, raw) : JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') bases.push(parsed)
    } catch {
      // A hand-edited file that no longer parses must not take the whole listing down.
    }
  }
  return bases.sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

/** One base and the path it lives at. */
export async function loadBase(cwd, id) {
  const path = pathFor(cwd, id)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error(`no knowledge base "${id}" in ${DIRNAME}/; create it first, or check the id`)
  }
  // A sealed file is opened here, so every caller keeps working with a plain base object.
  const base = isSealed(text) ? open(id, text) : JSON.parse(text)
  if (!Array.isArray(base.nodes)) base.nodes = []
  if (!Array.isArray(base.links)) base.links = []
  return { base, path }
}

/** Write a base back, creating the directory when this is the first one. */
export async function saveBase(path, base) {
  await mkdir(join(path, '..'), { recursive: true })
  // A diary is written as ciphertext: the file name carries the base id, and the key is derived from it.
  const id = path.split(/[\\/]/).pop().replace(/\.json$/, '')
  await writeFile(path, isDiary(id) ? seal(id, base) : JSON.stringify(base, null, 2) + '\n', 'utf8')
}

/** A fresh base with one root node, so a new base is never an empty canvas. */
export function newBase(id, name, firstTitle, firstBody) {
  const label = typeof name === 'string' && name.trim() ? name.trim() : id
  const node = {
    id: 'n1',
    parent: null,
    title: typeof firstTitle === 'string' && firstTitle.trim() ? firstTitle.trim() : label,
    body: typeof firstBody === 'string' ? firstBody : '',
    change: 'added',
    // newBase does not go through upsertNode, so it stamps its own node. A root with no date would be
    // the one node whose age is unknown, and it is usually the oldest thing in the base.
    at: stamp(),
  }
  return { version: 1, id, name: label, nodes: [node], links: [] }
}

/**
 * The next free node id, following whatever prefix the base already uses.
 *
 * The prefix is taken from the ids in use rather than hardcoded. A base whose nodes are
 * `o1`/`o2`/`o3` must not suddenly grow an `n1` — that is how this was found: a node added to
 * a base that names its nodes with `o` came back as `n1`. And the result is checked against
 * the ids already present, because handing out a duplicate would make the tree ambiguous: two
 * nodes sharing one id, and a link that could mean either.
 */
function nextNodeId(base) {
  const used = new Set((base.nodes || []).map((node) => String(node.id)))
  const counts = new Map()
  let highest = 0
  for (const id of used) {
    const match = /^([A-Za-z]*)(\d+)$/.exec(id)
    if (!match) continue
    const prefix = match[1] || 'n'
    counts.set(prefix, (counts.get(prefix) || 0) + 1)
    highest = Math.max(highest, Number(match[2]))
  }
  let prefix = 'n'
  let best = 0
  for (const [candidate, count] of counts) {
    if (count > best) {
      best = count
      prefix = candidate
    }
  }
  let number = highest + 1
  while (used.has(prefix + number)) number += 1
  return prefix + number
}

/**
 * Create or update one node.
 *
 * A new node is marked 'added'; an existing one becomes 'modified'. That is the whole point
 * of the marker: the user opens the panel and sees what the model touched and has not looked
 * at yet.
 *
 * `reviewed: true` clears the marker instead, and is how the user's own edit says "I have
 * looked at this". That matters more than it looks: the marker is not only drawn in the panel,
 * it is injected into the prompt, so a marker that never clears tells the agent that something
 * is unreviewed forever.
 */
export function upsertNode(base, { node, title, body, parent, reviewed, by }) {
  const existing = node ? base.nodes.find((entry) => entry.id === node) : undefined
  if (node && !existing) throw new Error(`node "${node}" is not in this base`)

  if (!existing) {
    if (typeof title !== 'string' || !title.trim()) throw new Error('a new node needs a title')
    if (parent && !base.nodes.some((entry) => entry.id === parent)) {
      throw new Error(`parent "${parent}" is not in this base`)
    }
    const created = {
      id: nextNodeId(base),
      parent: parent || null,
      title: title.trim(),
      body: typeof body === 'string' ? body : '',
      change: 'added',
      at: stamp(),
      history: [{ at: stamp(), ...(typeof by === 'string' && by.length > 0 ? { by } : {}) }],
      ...(typeof by === 'string' && by.length > 0 ? { by } : {}),
    }
    base.nodes.push(created)
    return { node: created, created: true }
  }

  if (parent !== undefined) {
    if (parent !== null && !base.nodes.some((entry) => entry.id === parent)) {
      throw new Error(`parent "${parent}" is not in this base`)
    }
    if (parent === existing.id) throw new Error('a node cannot be its own parent')
    // And it cannot be moved under something that is already beneath it: that closes a loop, and a loop in a
    // tree is not a shape anything downstream knows how to draw or walk. The check walks up from the proposed
    // parent, which is the only path that can lead back to this node.
    for (let cursor = parent; cursor; ) {
      if (cursor === existing.id) {
        throw new Error(`"${parent}" is below "${existing.id}" already, so that would make a loop`)
      }
      const up = base.nodes.find((entry) => entry.id === cursor)
      cursor = up && up.parent ? up.parent : null
    }
    existing.parent = parent
  }
  // The version that is about to be overwritten, captured **before** anything is written over it.
  //
  // This used to record only `{ at, by }` — when a node was changed and by which session — and the previous
  // title and body were never stored anywhere. The user's summary of that was exact: it is a local git with
  // commit dates and no commit contents, so "what did it say before" was unanswerable, not merely unshown.
  //
  // Each entry describes the version it replaced: what that version said, who wrote it, and when. The node
  // itself is the current version, so the node plus its history is the whole timeline. Entries written before
  // this change have no title or body; the panel has to read those as "no version recorded" rather than as an
  // empty one.
  //
  // Oldest last would make the panel's list read backwards, so new entries go on the end and the oldest
  // falls off the front.
  const previous = {
    at: existing.at,
    ...(typeof existing.by === 'string' && existing.by.length > 0 ? { by: existing.by } : {}),
    title: existing.title,
    body: existing.body,
  }
  if (typeof title === 'string' && title.trim()) existing.title = title.trim()
  if (typeof body === 'string') existing.body = body
  if (!Array.isArray(existing.history)) existing.history = []
  existing.history.push(previous)
  existing.at = stamp()
  if (existing.history.length > HISTORY_LIMIT) {
    existing.history = existing.history.slice(existing.history.length - HISTORY_LIMIT)
  }
  // Three states, because two conflated writing with reviewing: a string means a model wrote it, null means
  // the user did (the panel says so explicitly), and undefined means this write is not about authorship at
  // all — a review must not erase the name of whoever wrote the text being reviewed.
  if (typeof by === 'string' && by.length > 0) existing.by = by
  else if (by === null) delete existing.by
  if (reviewed === true) delete existing.change
  else existing.change = 'modified'
  return { node: existing, created: false }
}

/** Link two nodes. The pair is unordered for duplicate purposes, so A→B and B→A collide. */
export function addLink(base, { from, to, note }) {
  for (const id of [from, to]) {
    if (!base.nodes.some((entry) => entry.id === id)) throw new Error(`node "${id}" is not in this base`)
  }
  if (from === to) throw new Error('a node cannot be linked to itself')
  const clash = base.links.some(
    (link) => (link.from === from && link.to === to) || (link.from === to && link.to === from),
  )
  if (clash) throw new Error(`"${from}" and "${to}" are already linked`)
  const link = { from, to }
  if (typeof note === 'string' && note.trim()) link.note = note.trim()
  base.links.push(link)
  return link
}

/**
 * Remove one link, the pair being unordered.
 *
 * Needed because hand-drawn links now save immediately, so "undo my last drag" has to be a
 * real deletion. A button that only removed the line from the panel while the file kept it
 * would be lying about what is stored.
 */
/**
 * Set or clear the note on an existing link, the pair being unordered.
 *
 * The model is required to write one when it links two nodes — the note is what another session sees in its
 * outline, and a link with nothing on it cannot be acted on. The user is not: they are the only reader of
 * their own panel, so the consequence of a bare line is theirs to accept. But they must be able to write one,
 * and this is that path. An empty note removes it rather than storing an empty string, so "no note" has one
 * representation in the file.
 */
export function setLinkNote(base, { from, to, note }) {
  const link = base.links.find(
    (entry) => (entry.from === from && entry.to === to) || (entry.from === to && entry.to === from),
  )
  if (!link) throw new Error(`"${from}" and "${to}" are not linked`)
  const text = typeof note === 'string' ? note.trim() : ''
  if (text) link.note = text
  else delete link.note
  return link
}

export function removeLink(base, { from, to }) {
  const index = base.links.findIndex(
    (link) => (link.from === from && link.to === to) || (link.from === to && link.to === from),
  )
  if (index === -1) throw new Error(`"${from}" and "${to}" are not linked`)
  return base.links.splice(index, 1)[0]
}

/**
 * Soft-delete: the node stays, marked 'removed'.
 *
 * A real delete would leave nothing for the user to review, and the marker is the whole
 * point. Its children are re-parented to its parent so the tree does not lose a branch.
 */
export function removeNode(base, nodeId) {
  const index = base.nodes.findIndex((entry) => entry.id === nodeId)
  if (index === -1) throw new Error(`node "${nodeId}" is not in this base`)
  const node = base.nodes[index]
  if (node.change === 'removed') throw new Error(`node "${nodeId}" is already marked removed`)
  base.nodes.forEach((entry) => {
    if (entry.parent === nodeId) entry.parent = node.parent
  })
  node.change = 'removed'
  base.links = base.links.filter((link) => link.from !== nodeId && link.to !== nodeId)
  return node
}

/**
 * Remove a removed node for good.
 *
 * Requiring the soft step first is not a formality: that step has already re-parented the node's
 * children and dropped its links, so by the time this runs there is nothing left to damage. Purging a
 * live node would silently orphan its children.
 */
export function purgeNode(base, nodeId) {
  const index = base.nodes.findIndex((entry) => entry.id === nodeId)
  if (index === -1) throw new Error(`node "${nodeId}" is not in this base`)
  const node = base.nodes[index]
  if (node.change !== 'removed') {
    throw new Error(`node "${nodeId}" is not removed yet — mark it removed first so its children move up`)
  }
  base.nodes.splice(index, 1)
  return node
}

/**
 * Today, as YYYY-MM-DD.
 *
 * Date and time, to the minute.
 *
 * A date answers "how long ago"; the time answers "was this part of the same session", which is the unit
 * that matters when the trail is for code. Local, because the person reading the file is the one who
 * cares which evening it was.
 */
/** How many edits a node remembers. Ten describes the recent life of a note; all of it would be a log. */
/**
 * Undo every unreviewed change in one base, and say how many of each kind went back.
 *
 * `history` already keeps the previous title and body of every write, so a modified node can really be restored rather than
 * merely un-flagged. Reviewed nodes are left alone: marking a node read is the user saying they accept it.
 *
 * @returns `{ added, modified, removed }` — how many were undone, by kind.
 */
export function revertUnreviewed(base) {
  const counts = { added: 0, modified: 0, removed: 0 }
  if (!base || !Array.isArray(base.nodes)) return counts

  // Added last, because dropping a node reparents its children and has to happen after the children were considered.
  const gone = new Set()
  for (const node of base.nodes) {
    if (node.change === 'added') gone.add(node.id)
  }

  const kept = []
  for (const node of base.nodes) {
    if (gone.has(node.id)) {
      counts.added += 1
      continue
    }
    if (node.change === 'removed') {
      // Honest limit: a removal has already re-parented this node's children and dropped its links, so undoing it brings the
      // node back **without** them. The flag is the only thing left to clear.
      delete node.change
      counts.removed += 1
      kept.push(node)
      continue
    }
    if (node.change === 'modified' && Array.isArray(node.history) && node.history.length > 0) {
      const previous = node.history[node.history.length - 1]
      if (typeof previous.title === 'string') node.title = previous.title
      if (typeof previous.body === 'string') node.body = previous.body
      node.history.pop()
      delete node.change
      counts.modified += 1
    }
    kept.push(node)
  }

  if (gone.size > 0) {
    // Children of a reverted addition move up to its parent, exactly as a removal does.
    for (const node of kept) {
      if (gone.has(node.parent)) {
        const parent = base.nodes.find((entry) => entry.id === node.parent)
        node.parent = parent && !gone.has(parent.parent) ? parent.parent : null
      }
    }
    base.nodes = kept
    base.links = (base.links || []).filter((link) => !gone.has(link.from) && !gone.has(link.to))
  } else {
    base.nodes = kept
  }

  return counts
}

/**
 * Undo the unreviewed change on one node.
 *
 * @returns `'added' | 'modified' | 'removed' | null` — what was undone, or null when the node was clean.
 */
export function revertNode(base, nodeId) {
  const node = (base.nodes || []).find((entry) => entry.id === nodeId)
  if (!node) throw new Error(`node "${nodeId}" is not in this base`)

  if (node.change === 'added') {
    base.nodes = base.nodes.filter((entry) => entry.id !== nodeId)
    for (const child of base.nodes) {
      if (child.parent === nodeId) child.parent = node.parent || null
    }
    base.links = (base.links || []).filter((link) => link.from !== nodeId && link.to !== nodeId)
    return 'added'
  }
  if (node.change === 'removed') {
    // The node comes back without its old children and links: those were re-parented and dropped when it was removed.
    delete node.change
    return 'removed'
  }
  if (node.change === 'modified' && Array.isArray(node.history) && node.history.length > 0) {
    const previous = node.history[node.history.length - 1]
    if (typeof previous.title === 'string') node.title = previous.title
    if (typeof previous.body === 'string') node.body = previous.body
    node.history.pop()
    delete node.change
    return 'modified'
  }
  return null
}

/** 内容寻址：同一张图只有一个文件。返回相对 .dsh-knowledge 的路径（`assets/<name>`）。 */
export async function putImageBytes(cwd, bytes, ext) {
  const { createHash } = await import('node:crypto')
  // `ext` arrives already checked and normalised by the caller (putImage / putAssetBytes). Validating again with the
  // picture-only rule rejected everything that was not an image — the second check undid the first.
  const name = createHash('sha256').update(bytes).digest('hex').slice(0, 16) + ext
  const dir = join(dirFor(cwd), 'assets')
  await mkdir(dir, { recursive: true })
  const target = join(dir, name)
  // Written only when new, so two writers of the same picture do not fight over it.
  if (!existsSync(target)) await writeFile(target, bytes)
  return { rel: 'assets/' + name, bytes: bytes.length }
}

/** 从磁盘上的文件挂图：读出来交给 putImageBytes，哈希只有那一处算。 */
export async function putImage(cwd, sourcePath) {
  const bytes = await readFile(sourcePath)
  return putImageBytes(cwd, bytes, extOf(sourcePath))
}

/** 只允许这几种图片，别的扩展名不猜类型。 */
export function extOf(file) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(file))
  const ext = match ? match[1].toLowerCase() : ''
  const allowed = { png: '.png', jpg: '.jpg', jpeg: '.jpg', gif: '.gif', webp: '.webp', svg: '.svg' }
  if (!allowed[ext]) throw new Error('only png, jpg, gif, webp and svg can be attached')
  return allowed[ext]
}

/** 一张图的 MIME，按扩展名；白名单之外不可能的。 */
export function mimeOf(rel) {
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[extOf(rel)]
}

/**
 * What may be attached. Everything, except the things that run when they are opened: the point of the list is not to judge what
 * is useful — a log, a diff, a lockfile and a notebook are all worth keeping — but to keep executables and installers out of a
 * directory that is served over HTTP.
 */
const REFUSED = new Set([
  'exe', 'dll', 'msi', 'msix', 'scr', 'com', 'cpl', 'sys', 'drv', 'ocx',
  'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'jar',
  'app', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'ipa',
]);

export function extOfAny(file) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(file))
  const ext = match ? match[1].toLowerCase() : ''
  if (!ext) throw new Error('a file needs an extension to be attached')
  if (REFUSED.has(ext)) throw new Error('this kind of file cannot be attached: .' + ext)
  return '.' + ({ jpeg: 'jpg' }[ext] || ext)
}

/** 附件的 MIME：图片按图，其它按下载。 */
export function mimeOfAny(rel) {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(String(rel)) || [])[1] || ''
  const table = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
    csv: 'text/csv; charset=utf-8', json: 'application/json', yaml: 'text/yaml; charset=utf-8', yml: 'text/yaml; charset=utf-8',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
  }
  return table[ext.toLowerCase()] || 'application/octet-stream'
}

/** 存任意附件：与图片同一条内容寻址路径，只有扩展名校验不同。 */
export async function putAssetBytes(cwd, bytes, ext) {
  return putImageBytes(cwd, bytes, extOfAny('x' + ext))
}

export const HISTORY_LIMIT = 10

function stamp() {
  const now = new Date()
  const two = (value) => String(value).padStart(2, '0')
  return now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate())
    + ' ' + two(now.getHours()) + ':' + two(now.getMinutes())
}

/** A compact, model-facing view of one base: structure, content, and what is unreviewed. */
export function describeBase(base) {
  const lines = [`base "${base.id}" — ${base.name} (${base.nodes.length} nodes, ${base.links.length} links)`]
  const children = new Map()
  for (const node of base.nodes) {
    const key = node.parent === undefined ? null : node.parent
    if (!children.has(key)) children.set(key, [])
    children.get(key).push(node)
  }
  const walk = (parent, depth) => {
    for (const node of children.get(parent) || []) {
      const flag = node.change ? `  [${node.change}]` : ''
      // No history here on purpose: this is the text a model receives, and bookkeeping is not knowledge.
      const when = node.at ? `  (${node.at})` : ''
      // The structure line stays one line; the body gets its own, indented, verbatim.
      //
      // It used to share the line and therefore had to be flattened and cut at 120 characters — and since
      // this is exactly what `knowledge_read` returns, the tool whose stated job is "its tree of nodes with
      // ids, titles, bodies, links" was handing back a fifth of a body with its newlines removed. A model
      // read `o4` as far as "所以必须重" and then went around the tool to open the JSON.
      //
      // No cap here: the point of this view is the bodies. The outline is where brevity is the requirement,
      // and it has its own renderer for that.
      lines.push(`${'  '.repeat(depth)}- ${node.id}  ${node.title}${flag}${when}`)
      if (node.body) {
        for (const line of String(node.body).split('\n')) {
          lines.push(line.trim() ? `${'  '.repeat(depth)}    ${line.trimEnd()}` : '')
        }
      }
      walk(node.id, depth + 1)
    }
  }
  walk(null, 0)
  const orphans = base.nodes.filter(
    (node) => node.parent && !base.nodes.some((entry) => entry.id === node.parent),
  )
  for (const node of orphans) lines.push(`- ${node.id}  ${node.title}  (parent missing)`)
  if (base.links.length) {
    lines.push('links:')
    for (const link of base.links) {
      const note = link.note ? ` — ${link.note}` : ''
      lines.push(`  ${link.from} <-> ${link.to}${note}`)
    }
  }
  return lines.join('\n')
}

/**
 * One node, its body, and one line for every node it is connected to.
 *
 * Added because reading a base was all-or-nothing, and the outline lists links as id pairs — so a model that
 * saw `o3 <-> o2` and wanted to know what `o2` said had to pull the entire base to find out. That makes
 * following an association a large step instead of a small one, which is the wrong shape for the thing links
 * exist to express. This is the small one.
 *
 * The neighbours are printed as the same one line the outline uses — id, title, trigger — so the model can
 * decide whether to read one without paying for it first. Parents and children count as neighbours along with
 * the links: "what is this connected to" has three answers here, not one.
 *
 * `brief` is passed in rather than imported. This module is imported *by* `outline.js`, so reaching back for
 * its formatter would be a cycle — and copying the formatter here would be a second implementation of the
 * trigger rule, which is the mistake `o31` is about.
 *
 * @param brief - `(node) => string`, the outline's one-line form.
 * @returns the text, or null when there is no such node. The caller decides how to say that; a silent empty
 * string would read as "this node is empty", which is a different and more confusing fact.
 */
export function describeNode(base, nodeId, brief, workspace, inlineAttachments = true) {
  const byId = new Map()
  for (const node of base.nodes) byId.set(node.id, node)
  const node = byId.get(nodeId)
  if (!node) return null

  const flag = node.change ? `  [${node.change}]` : ''
  const when = node.at ? `  (${node.at})` : ''
  const lines = [`base "${base.id}" — ${base.name}`, `${node.id}  ${node.title}${flag}${when}`]

  lines.push('')
  lines.push(node.body && String(node.body).trim() ? String(node.body).trimEnd() : '(no body)')

  lines.push(...describeAttachments(node, workspace, inlineAttachments))

  const parent = node.parent ? byId.get(node.parent) : null
  const children = base.nodes.filter((entry) => entry.parent === node.id)
  const links = base.links.filter((link) => link.from === node.id || link.to === node.id)

  const related = []
  if (parent) related.push(['parent', brief(parent), ''])
  // A parent that is not in the base is worth saying out loud; the outline flags those too.
  if (node.parent && !parent) related.push(['parent', node.parent + '  (missing from this base)', ''])
  for (const child of children) related.push(['child', brief(child), ''])
  for (const link of links) {
    const otherId = link.from === node.id ? link.to : link.from
    const other = byId.get(otherId)
    related.push(['link', other ? brief(other) : otherId + '  (missing from this base)', link.note || ''])
  }

  if (related.length) {
    lines.push('')
    lines.push('related:')
    for (const [kind, text, note] of related) {
      lines.push(`  ${kind.padEnd(6)} ${text}${note ? '  — ' + note : ''}`)
    }
  }
  return lines.join('\n')
}

/** Render file metadata, optionally with supported text. */
export function describeAttachments(node, workspace, inlineAttachments = false) {
  const refs = attachmentPaths(node)
  if (!refs.length) return []
  const lines = ['', 'attachments:']
  for (const rel of refs) {
    const absolute = workspace ? join(workspace, '.dsh-knowledge', rel) : rel
    try {
      const size = statSync(absolute).size
      lines.push('  ' + absolute + '  (' + Math.round(size / 1024) + ' KB)')
    } catch {
      lines.push('  ' + absolute + '  (missing)')
      continue
    }
    if (!inlineAttachments) {
      lines.push('  (on-demand: use knowledge_read with this base, node, and attachment="' + rel + '"; text supports offset/limit)')
      continue
    }
    // Pictures are delivered as image blocks by the tool, never decoded as text.
    if (/\.(png|jpe?g|gif|webp)$/i.test(rel) || !workspace) continue
    try {
      lines.push(attachmentPage(workspace, node, rel))
    } catch {
      lines.push('  (attachment text could not be extracted; use a suitable file reader)')
    }
  }
  return lines
}
