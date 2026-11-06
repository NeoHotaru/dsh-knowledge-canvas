/**
 * The model-facing tools.
 *
 * Six, deliberately: read, create a base, write a node, link two nodes, soft-remove a node,
 * and switch a base on or off. That is the set the user described — the model builds a
 * knowledge base, edits nodes, branches them, connects one node to another, and decides what
 * the Session should be reading — and nothing beyond it.
 *
 * Every write sets the node's `change` marker, because that marker is the only reason the
 * user can tell what the model touched. A tool that wrote silently would leave the panel
 * lying.
 *
 * Every write also invalidates the cached prompt outline, so the next assembly sees it. That
 * is a same-process call rather than a file watch: the writer and the cache live together.
 */

import { readFileSync } from 'node:fs'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { log } from './log.js'
import { attachmentPage, attachmentPaths } from './attachments.js'
import {
  addLink,
  assertId,
  describeBase,
  describeAttachments,
  describeNode,
  DIRNAME,
  listBases,
  loadBase,
  putImage,
  newBase,
  pathFor,
  removeBase,
  removeLink,
  setLinkNote,
  removeNode,
  saveBase,
  upsertNode,
} from './store.js'
import {
  pruneNodeInject, pruneCollapsed, readAttachmentMode, diaryBaseFor, isDiaryBase, readDiary, readLive, readNames, readSelection, readSessionSelection, writeName,
  writeSelection,
} from './state.js'
import { sessionIdOf } from './session.js'
import { invalidate, triggerOf, briefOf } from './outline.js'

/** The workspace directory the tools operate in, or a message naming what is missing. */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('this Session has no workspace directory, so there is nowhere to keep a knowledge base')
  }
  return cwd
}

/**
 * Refuse to touch a base that is switched off for this session.
 *
 * Three levels, matching how the panel reads them: a session's own list, the workspace default, and — when
 * there is no file at all — everything on. A switched-off base is still reachable by the user through the
 * panel; this only stops the model from working on something it cannot read.
 */
async function assertEnabled(cwd, baseId, sessionId, what) {
  // A diary belongs to the conversation keeping it. The outline hides it and the panel hides it; this stops a tool
  // that guesses the id from reaching it anyway. Reported as "no such base" rather than "not allowed", because to this
  // session it does not exist — and naming it would tell a model that something is there.
  if (isDiaryBase(baseId)) {
    // The diary a conversation may write is its own, named by a hash of its id. Another conversation's diary is not "switched
    // off" — it does not exist here, which is also what the error says.
    if (baseId !== diaryBaseFor(sessionId) || !(await readDiary(cwd, sessionId))) {
      throw new Error('there is no knowledge base "' + baseId + '" in this workspace')
    }
    // Keeping a diary means being able to write it. The enabled list is a different question — "is this base part of
    // the workspace's reading material" — and the diary answers to its own switch. Consulting both meant a session
    // that had just turned the diary on was still told the base was switched off, because the base existed before the
    // conversation did and so was never in its list.
    return
  }
  // Either it is there or it is not, and those are different answers. "switched off" for a base that does not exist sends the
  // model to a switch in the panel that is not there either.
  try {
    await loadBase(cwd, baseId)
  } catch {
    throw new Error('there is no knowledge base "' + baseId + '" in this workspace')
  }
  const enabled = await readSelection(cwd, sessionId)
  if (enabled === null || enabled.has(baseId)) return
  throw new Error(
    'knowledge base "' + baseId + '" is switched off, so it cannot be ' + what + '. '
    + 'Ask the user to switch it on in the knowledge panel if it should be. '
    + 'Do not write into it from memory: you cannot see what is already there.',
  )
}

/**
 * Copy one picture into the base and return the markdown line for it.
 *
 * The path is confined to the workspace on purpose: it is a model-supplied string, and without that check this becomes "copy any
 * readable file on this machine into a place the panel serves over HTTP".
 */
async function attachPicture(cwd, asked) {
  const inside = resolve(String(asked).trim())
  const root = resolve(cwd)
  if (inside !== root && !inside.startsWith(root + sep)) {
    throw new Error('image must be a file inside this workspace: ' + root)
  }
  let size = 0
  try {
    size = (await stat(inside)).size
  } catch {
    throw new Error('no such file: ' + inside)
  }
  if (size > 8 * 1024 * 1024) throw new Error('image is larger than 8 MB')
  const saved = await putImage(cwd, inside)
  return { line: '![](' + saved.rel + ')', rel: saved.rel, bytes: saved.bytes }
}

/** Pictures a node points at. */
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

const BASE_PROP = {
  type: 'string',
  description: 'Knowledge base id, i.e. the file name under .dsh-knowledge/ without .json.',
}

/** Read one base, one node, or list them all when `base` is omitted. */
const read = {
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        pictures: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['text', 'pictures'],
    },
    render: (_args, value) => [
      { type: 'text', text: String((value && value.text) || '') },
      ...(((value && value.pictures) || []).map((ref) => ({ type: 'image', attachment: ref }))),
    ],
  },
  name: 'knowledge_read',
  description:
    'Read a knowledge base: its tree of nodes with ids, titles, bodies, links, and which nodes '
    + 'still carry an unreviewed change marker. Omit `base` to list every base in this workspace, '
    + 'with a node and link count each. Read before writing, because every other tool here takes '
    + 'node ids that only this one tells you. '
    + 'Pass `node` to read a single node instead of the whole base: you get its body plus one line '
    + 'for everything it is connected to — its parent, its children, and its links — so following an '
    + 'association from the outline costs one node instead of a whole base. '
    + 'Attachment policy follows workspace settings: on-demand lists files only; required includes supported text and images. '
    + 'Use attachment to fetch one referenced asset and offset/limit to page text (up to 8000 characters).',
  parameters: {
    type: 'object',
    properties: {
      base: { ...BASE_PROP, description: BASE_PROP.description + ' Omit to list all.' },
      node: {
        type: 'string',
        description: 'A node id inside that base. Reads just this node and what it is connected to. '
          + 'The outline lists links as id pairs; this is how you find out what the other end says '
          + 'without pulling the whole base.',
      },
      attachment: { type: 'string', description: 'Exact assets/... path listed by this node. Requires base and node. Reads one file only.' },
      offset: { type: 'integer', minimum: 0, description: 'Text character offset, default 0.' },
      limit: { type: 'integer', minimum: 1, maximum: 8000, description: 'Maximum text characters, default 8000.' },
    },
    additionalProperties: false,
  },
  async execute(args, exec) {
    const cwd = cwdOf(exec)
    const mode = await readAttachmentMode(cwd)
    if (args?.attachment !== undefined && (!args.base || !args.node)) throw new Error('attachment requires base and node')
    if ((args?.offset !== undefined || args?.limit !== undefined) && args?.attachment === undefined) throw new Error('offset and limit require attachment')
    if (args && typeof args.base === 'string' && args.base.trim()) {
      const wanted = assertId(args.base.trim(), 'base id')
      // A base that is switched off is off for the model, not merely out of sight.
      await assertEnabled(cwd, wanted, sessionIdOf(exec), 'read')
      const { base } = await loadBase(cwd, wanted)
      const wantedNode = typeof args.node === 'string' && args.node.trim() ? args.node.trim() : null
      if (wantedNode) {
        const one = describeNode(base, wantedNode, briefOf, cwd, mode === 'required' && args.attachment === undefined)
        if (one === null) {
          // Not a silent empty string: that reads as "this node is empty", which is a different fact.
          throw new Error(
            'no node "' + wantedNode + '" in base "' + wanted + '". Read the base without `node` '
            + 'to see the ids it has.',
          )
        }
        const node = base.nodes.find((entry) => entry.id === wantedNode)
        if (args.attachment !== undefined) {
          if (!attachmentPaths(node).includes(args.attachment)) throw new Error('attachment must be an asset path referenced by this node')
          if (/\.(png|jpe?g|gif|webp)$/i.test(args.attachment)) return nodePictures(cwd, [node], [args.attachment])
          return { text: attachmentPage(cwd, node, args.attachment, args.offset, args.limit), pictures: [] }
        }
        return mode === 'required' ? nodePictures(cwd, [node], null, one) : { text: one, pictures: [] }
      }
      const attachments = base.nodes.filter((node) => attachmentPaths(node).length).map((node) =>
        'node ' + node.id + '\n' + describeAttachments(node, cwd, mode === 'required').join('\n')).join('\n')
      const text = describeBase(base) + (attachments ? '\n' + attachments : '')
      return mode === 'required' ? nodePictures(cwd, base.nodes, null, text) : { text, pictures: [] }
    }
    // Same rule as the outline and the panel: this session's own diary when it is keeping one, and no diary base otherwise.
    const allBases = await listBases(cwd)
    const sessionId = sessionIdOf(exec)
    const ownDiary = (await readDiary(cwd, sessionId)) ? diaryBaseFor(sessionId) : null
    const bases = allBases.filter((base) => !isDiaryBase(base.id) || base.id === ownDiary)
    if (bases.length === 0) {
      return { text: 'No knowledge bases in this workspace yet. Create one with knowledge_create_base.', pictures: [] }
    }
    return { text: bases
      .map((base) => `${base.id} — ${base.name} (${base.nodes.length} nodes, ${base.links.length} links)`)
      .join('\n'), pictures: [] }
  },
}

/** Create a base, with one root node so it is usable immediately. */
const createBase = {
  name: 'knowledge_create_base',
  description:
    'Create a new knowledge base. Use this when the user asks to start one, or when a topic '
    + 'clearly deserves its own base rather than another branch. The new base starts with a '
    + 'single root node, marked as an unreviewed addition.',
  parameters: {
    type: 'object',
    properties: {
      id: { ...BASE_PROP, description: 'Id for the new base: letters, digits and dashes, max 64. Becomes the file name.' },
      name: { type: 'string', description: 'Display name. Defaults to the id.' },
      first_title: { type: 'string', description: 'Title of the root node. Defaults to the display name.' },
      first_body: { type: 'string', description: 'Body of the root node.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async execute(args, exec) {
    const cwd = cwdOf(exec)
    const id = assertId(String(args?.id ?? '').trim(), 'base id')
    // Not gated: a base being created is in no list yet, so there is nothing to be switched off.
    const existing = (await listBases(cwd)).find((base) => base.id === id)
    if (existing) throw new Error(`knowledge base "${id}" already exists`)
    const base = newBase(id, args?.name, args?.first_title, args?.first_body)
    // The root node is written by whoever created the base, and it was the one node in a new base with no
    // author. Set here rather than inside newBase, which has no idea who called it.
    const author = sessionIdOf(exec)
    if (author) base.nodes[0].by = author
    await pruneNodeInject(cwd, id, [])
    await pruneCollapsed(cwd, id, [])
    await saveBase(pathFor(cwd, id), base)
    invalidate(cwd)
    // Make it usable here, now.
    //
    // The session's own list was written when it started, so a base created afterwards is not in it and the next read or
    // write is refused as "switched off" — true of the list, false of the situation, and the user's only remedy was to
    // find the base in the panel and flip it by hand. A session with no list of its own is left alone: no list means
    // "all of them", and writing one here would turn that into a fixed list nobody asked for.
    try {
      // Either kind of list: this session's own, or the workspace default it inherits. Adding only to a session list left the
      // common case broken — no session file, a workspace list that does not name the new base, and the very next write refused.
      const own = await readSessionSelection(cwd, author)
      const current = own || (await readSelection(cwd, author))
      if (current && !current.has(id)) {
        await writeSelection(cwd, [...current, id], author)
      }
    } catch (error) {
      // Not worth failing the create for: the base exists, and the panel can still switch it on.
      log('FAIL adding a new base to the session list: ' + ((error && error.message) || error))
    }
    return `Created base "${id}" (${base.name}) with root node ${base.nodes[0].id}.`
  },
}

/** Create a node, or update one in place. */
const writeNode = {
  name: 'knowledge_write_node',
  description:
    'Write one node. Omit `node` to append a new node (it is marked as an unreviewed addition); '
    + 'pass an existing node id to change its title, body or parent (it is marked as an unreviewed '
    + 'modification). '
    + 'Decide `parent` on purpose; do not let it default. Both answers are right for different '
    + 'content: nodes that are genuinely peers belong side by side, and a base that is nothing but '
    + 'peers is a perfectly good base; a node that is a detail, a step, or one kind of an existing '
    + 'node belongs under that node. The question to ask about each new node is which of those it is '
    + '— if you would write "X: Y" and Y only makes sense as part of X, it is a child of X. The '
    + 'failure to avoid is neither flatness nor depth: it is answering that question the same way '
    + 'every time because the default is easier than deciding. '
    + 'The user sees these markers in the panel and reviews them there, so write only what the user '
    + 'asked for or what the evidence supports.',
  parameters: {
    type: 'object',
    properties: {
      session_name: {
        type: 'string',
        description: 'A short name for this conversation, e.g. what it is working on. Required the first '
          + 'time you write in a workspace, and used to label the nodes you write so the user can tell '
          + 'which session wrote what. After the first write it is ignored — the name does not change.',
      },
      base: BASE_PROP,
      node: { type: 'string', description: 'Existing node id to update. Omit to create a new node.' },
      title: { type: 'string', description: 'Node title. Required when creating.' },
      image: {
        type: 'string',
        description: 'Path to an image file inside this workspace (png/jpg/gif/webp/svg, up to 8 MB). It is copied into '
          + '.dsh-knowledge/assets and a markdown line pointing at it is appended to the body.',
      },
      body: {
        type: 'string',
        description: 'Node body: the note itself. End it with a line beginning 「什么时候该想起它:」 — '
          + 'that line becomes the node\'s one-line summary in the prompt, and a note that does not say '
          + 'when it applies is a note that gets read too late to help.',
      },
      parent: {
        // A plain string rather than a string-or-null union: a union is one more thing a
        // parameter validator can reject, and "root" says the same thing unambiguously.
        type: 'string',
        description: 'Id of the parent node, or "root" for a top-level node. Re-parenting an '
          + 'existing node moves its whole subtree.',
      },
    },
    required: ['base'],
    additionalProperties: false,
  },
  async execute(args, exec) {
    const cwd = cwdOf(exec)
    // A base that is switched off is off for the model, not merely out of sight.
    await assertEnabled(cwd, assertId(String(args?.base ?? '').trim(), 'base id'), sessionIdOf(exec), 'written to')
    const { base, path } = await loadBase(cwd, assertId(String(args?.base ?? '').trim(), 'base id'))
    const rawParent = args?.parent
    const parent = rawParent === undefined
      ? undefined
      : (rawParent === 'root' || rawParent === '' || rawParent === null ? null : String(rawParent).trim())
    // Named once. The name is stored with the layout, which is presentation: it labels nodes for the user
    // and never reaches the prompt.
    const sessionId = sessionIdOf(exec)
    const names = await readNames(cwd)
    const offered = typeof args?.session_name === 'string' ? args.session_name.trim().slice(0, 40) : ''
    if (sessionId && !names[sessionId] && !offered) {
      throw new Error(
        'before the first write in a workspace, pass session_name: a short name for this conversation, '
        + 'e.g. what you are working on. It labels the nodes you write so the user can tell which session '
        + 'wrote what. Write the node again with it.',
      )
    }
    if (sessionId && !names[sessionId] && offered) {
      await writeName(cwd, sessionId, offered)
    }

    // Whether this write revives a node that was marked removed: the panel draws it faded, and the reply should say the
    // opposite of what it said before rather than looking like an ordinary edit.
    const targetId = typeof args?.node === 'string' && args.node.trim() ? args.node.trim() : undefined
    const wasRemoved = targetId
      ? Boolean(base.nodes.find((entry) => entry.id === targetId && entry.change === 'removed'))
      : false
    // Pictures first: a bad path must fail before anything is written.
    let body = args?.body
    let attached = null
    if (typeof args?.image === 'string' && args.image.trim()) {
      attached = await attachPicture(cwd, args.image)
      body = (typeof body === 'string' && body.length > 0 ? body.replace(/\s+$/, '') + '\n\n' : '') + attached.line
    }
    if (!targetId) {
      await pruneNodeInject(cwd, base.id, base.nodes.map((entry) => entry.id))
      await pruneCollapsed(cwd, base.id, base.nodes.map((entry) => entry.id))
    }
    const result = upsertNode(base, {
      node: typeof args?.node === 'string' && args.node.trim() ? args.node.trim() : undefined,
      title: args?.title,
      body,
      parent,
      // Which session this is. The same lookup the outline cache uses, and the only handle that stays the
      // same across turns of one conversation.
      by: sessionIdOf(exec),
    })
    await saveBase(path, base)
    invalidate(cwd)
    // Say when this landed, and whether the node is retrievable.
    //
    // The stamp is half of an answer to "is the outline I am reading newer than my write?". The other half is
    // on the outline's base header, and the two are meant to be compared: a test session could not tell
    // whether a node it had just written was already in the injected index, and the failure mode of guessing
    // wrong is to decide the write did not take and write it again — leaving duplicates in the base.
    //
    // In index mode a node is reached through its trigger line, so a body without one has nothing for the
    // model to match against, and nothing said so.
    const stamp = result.node.at ? ` (at ${result.node.at})` : ''
    const missingTrigger = result.node.body && String(result.node.body).trim() && !triggerOf(result.node.body).found
    const warning = missingTrigger
      ? '\n\n⚠ 这条没有触发行，所以它在索引模式下几乎不会被取到 —— 模型只有标题可以匹配。'
        + '在正文最后一行加一句：什么时候该想起它：<什么情况下这条适用>。'
      : ''
    if (wasRemoved) {
      return `Restored node ${result.node.id} "${result.node.title}" in base "${base.id}" — it had been marked removed.`
        + stamp + picture + warning
    }
    const picture = attached
      ? ` Attached ${attached.rel} (${Math.round(attached.bytes / 1024)} KB).`
      : ''
    return (result.created
      ? `Added node ${result.node.id} "${result.node.title}" to base "${base.id}".`
      : `Updated node ${result.node.id} "${result.node.title}" in base "${base.id}".`) + stamp + warning
  },
}

/** Connect two nodes. */
const link = {
  name: 'knowledge_link',
  description:
    'Link two nodes in the same base. A link is an association, not a parent-child relation: use '
    + 'it when one node refers to something another node explains, for example a step that says '
    + '"read the manual first" and the node that says where the manual lives. The link is drawn as '
    + 'a dashed line in the panel. '
    + 'A `note` is required, and it is most of the link\'s value. The note is what another session '
    + 'sees in its outline, and it is the only reason that session would ever follow the line: a link '
    + 'with nothing on it says "these two are related" and nothing about when following it is worth '
    + 'doing, which is not enough to act on. Write it the way you would write a trigger line — the '
    + 'situation in which the reader wants the other end. '
    + 'Call it again on the same pair to rewrite that note; the pair stays as it is and only the note '
    + 'changes, so a note that turned out to be wrong is worth fixing rather than living with.',
  parameters: {
    type: 'object',
    properties: {
      base: BASE_PROP,
      from: { type: 'string', description: 'Node id the association starts from.' },
      to: { type: 'string', description: 'Node id it points at.' },
      note: {
        type: 'string',
        description: 'One line on why they are related — and specifically, when following the link is '
          + 'useful. It reaches other sessions through the outline, so write it for a reader who has '
          + 'only the two titles.',
      },
    },
    required: ['base', 'from', 'to', 'note'],
    additionalProperties: false,
  },
  async execute(args, exec) {
    const cwd = cwdOf(exec)
    // A base that is switched off is off for the model, not merely out of sight.
    await assertEnabled(cwd, assertId(String(args?.base ?? '').trim(), 'base id'), sessionIdOf(exec), 'linked in')
    const { base, path } = await loadBase(cwd, assertId(String(args?.base ?? '').trim(), 'base id'))
    // The schema requires the key; it cannot require that the key says anything. An empty note is exactly the
    // failure this requirement exists to prevent, and it would otherwise pass silently — the same shape as the
    // missing trigger line, and the same reason it is checked here rather than trusted.
    const note = typeof args?.note === 'string' ? args.note.trim() : ''
    if (!note) {
      throw new Error(
        'knowledge_link needs a note saying why these two nodes are related and when following the link is '
        + 'useful. It is not decoration: the note is what other sessions see in their outline, and a link '
        + 'with nothing on it cannot be acted on. Write it like a trigger line, then call this again.',
      )
    }
    const from = String(args?.from ?? '').trim()
    const to = String(args?.to ?? '').trim()

    // A second call on the same pair updates the note instead of refusing.
    //
    // It used to throw `already linked`, and that made a note permanent: the note is a sentence about *when*
    // following the link is useful, and those get rewritten as understanding improves. Refusing the rewrite
    // left only one way to fix a note — delete the link and draw it again — and this tool has no delete, so a
    // wrong note could only be corrected by editing the JSON by hand. Two sessions reported hitting that
    // before it was fixed here.
    //
    // The note stays required, including on an update: an empty one is still exactly the failure the
    // requirement exists to prevent.
    const pair = (link) => (link.from === from && link.to === to) || (link.from === to && link.to === from)
    const existing = base.links.find(pair)
    if (existing) {
      const before = typeof existing.note === 'string' ? existing.note : ''
      if (before === note) {
        return `${existing.from} <-> ${existing.to} in base "${base.id}" already carries exactly that note. `
          + 'Nothing changed.'
      }
      setLinkNote(base, { from, to, note })
      await saveBase(path, base)
      invalidate(cwd)
      return `Updated the note on ${existing.from} <-> ${existing.to} in base "${base.id}".`
    }

    const added = addLink(base, { from, to, note })
    await saveBase(path, base)
    invalidate(cwd)
    return `Linked ${added.from} <-> ${added.to} in base "${base.id}".`
  },
}

/** Remove the association between two nodes. */
const unlink = {
  name: 'knowledge_unlink',
  description:
    'Remove the association between two nodes. The nodes stay; only the dashed line goes. '
    + 'Use it when a note says the two are related and they are not, or when the connection was drawn by mistake. '
    + 'Removing a link a user drew by hand is a change they did not ask for — say so in your reply rather than doing it silently.',
  parameters: {
    type: 'object',
    properties: {
      base: BASE_PROP,
      from: { type: 'string', description: 'One end of the link.' },
      to: { type: 'string', description: 'The other end.' },
    },
    required: ['base', 'from', 'to'],
    additionalProperties: false,
  },
  async execute(args, exec) {
    const cwd = cwdOf(exec)
    const id = assertId(String(args?.base ?? '').trim(), 'base id')
    await assertEnabled(cwd, id, sessionIdOf(exec), 'unlinked')
    const { base, path } = await loadBase(cwd, id)
    const from = String(args?.from ?? '').trim()
    const to = String(args?.to ?? '').trim()
    removeLink(base, { from, to })
    await saveBase(path, base)
    invalidate(cwd)
    return `Removed the link between ${from} and ${to} in base "${base.id}". The nodes are unchanged.`
  },
}

/** Soft-remove a node. */
const remove = {
  name: 'knowledge_remove_node',
  description:
    'Mark a node as removed. The node is kept in the base and shown greyed out with a removal '
    + 'marker, so the user can see what went and undo it by hand; its children move up to its '
    + 'parent, and its links go away. Never use this to hide a mistake: tell the user instead.',
  parameters: {
    type: 'object',
    properties: {
      base: BASE_PROP,
      node: { type: 'string', description: 'Node id to mark as removed.' },
    },
    required: ['base', 'node'],
    additionalProperties: false,
  },
  async execute(args, exec) {
    const cwd = cwdOf(exec)
    // A base that is switched off is off for the model, not merely out of sight.
    await assertEnabled(cwd, assertId(String(args?.base ?? '').trim(), 'base id'), sessionIdOf(exec), 'changed')
    const { base, path } = await loadBase(cwd, assertId(String(args?.base ?? '').trim(), 'base id'))
    const node = removeNode(base, String(args?.node ?? '').trim())
    await saveBase(path, base)
    invalidate(cwd)
    return `Marked node ${node.id} "${node.title}" as removed in base "${base.id}".`
  },
}

/**
 * Switch a base on or off for this Session.
 *
 * An enabled base is the only thing injected into the system prompt, so this is what decides
 * whether the agent is reading a knowledge base at all. It is also the control the panel's
 * switches show — the panel reads the same file; it just cannot write it yet.
 */
const select = {
  name: 'knowledge_select',
  description:
    'Switch a knowledge base on or off. Only the switched-on bases are put in the system prompt as '
    + 'an outline, which is how the knowledge actually reaches you in later turns. Use it when the '
    + 'user asks to enable, disable, or "start using" a base. The panel in the right sidebar shows '
    + 'the same switches.',
  parameters: {
    type: 'object',
    properties: {
      base: BASE_PROP,
      enabled: {
        type: 'boolean',
        description: 'true to switch it on, false to switch it off. Omit to toggle it.',
      },
    },
    required: ['base'],
    additionalProperties: false,
  },
  async execute(args, exec) {
    const cwd = cwdOf(exec)
    const id = assertId(String(args?.base ?? '').trim(), 'base id')
    const bases = await listBases(cwd)
    if (!bases.some((base) => base.id === id)) {
      throw new Error(`no knowledge base "${id}" in ${DIRNAME}/; check the id with knowledge_read`)
    }

    const path = join(cwd, DIRNAME, 'selection.json')
    let current = []
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'))
      if (raw && Array.isArray(raw.enabled)) current = raw.enabled.map(String)
    } catch {
      // No selection file yet: start from every base being on, which is what the outline
      // module assumes while the file is missing.
      current = bases.map((base) => base.id)
    }
    const on = new Set(current)
    const wanted = typeof args?.enabled === 'boolean' ? args.enabled : !on.has(id)
    if (wanted) on.add(id)
    else on.delete(id)

    const enabled = bases.map((base) => base.id).filter((candidate) => on.has(candidate))
    await writeFile(path, JSON.stringify({ version: 1, enabled }, null, 2) + '\n', 'utf8')
    invalidate(cwd)
    return `Base "${id}" is now ${wanted ? 'on' : 'off'}. Enabled: ${enabled.join(', ') || '(none)'}.`
  },
}

/**
 * Take a whole base out of play.
 *
 * Separate from `knowledge_remove_node`, which only marks a node: a base created by mistake
 * should stop existing, while a base full of work should not be one command away from gone.
 * This moves the file aside instead of unlinking it, and reports where it went.
 */
const removeBaseTool = {
  name: 'knowledge_remove_base',
  description:
    'Remove one whole knowledge base. It is moved to .dsh-knowledge/.removed/ rather than '
    + 'deleted, so it can be restored by hand, and it is dropped from the enabled set so nothing '
    + 'refers to a base that no longer exists. Use it to undo a base created by mistake, or when '
    + 'the user asks to get rid of one — not for retiring a single node, which is '
    + 'knowledge_remove_node.',
  parameters: {
    type: 'object',
    properties: { base: BASE_PROP },
    required: ['base'],
    additionalProperties: false,
  },
  async execute(args, exec) {
    const cwd = cwdOf(exec)
    const id = assertId(String(args?.base ?? '').trim(), 'base id')
    // A base that is switched off is off for the model, not merely out of sight.
    await assertEnabled(cwd, id, sessionIdOf(exec), 'removed')
    const target = await removeBase(cwd, id)
    await pruneNodeInject(cwd, id, [])
    await pruneCollapsed(cwd, id, [])

    // Drop it from the enabled set too, or the selection would keep naming a base that no
    // longer lists — harmless to the outline, but a lie in the file.
    const selection = await readSelection(cwd)
    let dropped = false
    if (selection !== null && selection.has(id)) {
      selection.delete(id)
      await writeSelection(cwd, [...selection])
      dropped = true
    }
    invalidate(cwd)
    return `Removed base "${id}"${dropped ? ' (and switched it off)' : ''}. `
      + `It is at ${target} — move the file back into ${DIRNAME}/ to restore it.`
  },
}

/** Every tool this bundle contributes, in the order they are worth reading. */
async function nodePictures(cwd, nodes, selected = null, text = '') {
  const all = [...new Set(nodes.flatMap(attachmentPaths))].filter((path) => /\.(png|jpe?g|gif|webp)$/i.test(path))
    .filter((path) => !selected || selected.includes(path))
  const rels = all.slice(0, 6)
  const notes = [text]
  if (all.length > 6) notes.push('Only the first 6 pictures are included; fetch remaining pictures individually with knowledge_read attachment.')
  if (!rels.length) return { text: text || 'No supported pictures on these nodes.', pictures: [] }
  if (!hostAttachments) return { text: notes.concat('Pictures were NOT delivered: host attachment service is unavailable.').join('\n'), pictures: [] }
  const files = []
  for (const rel of rels) {
    const suffix = '.' + rel.split('.').pop().toLowerCase().replace('jpeg', 'jpg')
    try {
      files.push({ data: readFileSync(resolve(cwd, '.dsh-knowledge', rel)), mediaType: IMAGE_MIME[suffix], name: rel.split('/').pop() })
    } catch {
      notes.push('Picture missing or unreadable: ' + rel)
    }
  }
  if (!files.length) return { text: notes.join('\n'), pictures: [] }
  try {
    const saved = await hostAttachments.saveImages(files)
    const pictures = (Array.isArray(saved) ? saved : []).map((ref) => ref.image || ref)
    notes.push(pictures.length + ' picture(s) delivered: ' + files.map((file) => file.name).join(', '))
    if (pictures.length !== files.length) notes.push('Warning: the host returned fewer pictures than requested.')
    return { text: notes.join('\n'), pictures }
  } catch (error) {
    return { text: notes.concat('Pictures were NOT delivered: ' + error.message).join('\n'), pictures: [] }
  }
}

const showImages = {
  name: 'knowledge_show_images',
  description: 'Show the pictures attached to a node. knowledge_read gives their paths; this hands the pictures themselves to the '
    + 'model, so a screenshot in a note can be looked at without guessing which file matters.',
  parameters: {
    type: 'object',
    properties: {
      base: BASE_PROP,
      node: { type: 'string', description: 'Node id whose pictures to show.' },
    },
    required: ['base', 'node'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        pictures: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
      required: ['text', 'pictures'],
    },
    render: (_args, value) => [
      { type: 'text', text: String((value && value.text) || '') },
      ...(((value && value.pictures) || []).map((ref) => ({ type: 'image', attachment: ref }))),
    ],
  },
  isConcurrencySafe: () => true,
  async execute(args, exec) {
    const cwd = cwdOf(exec)
    const wanted = assertId(String((args && args.base) || '').trim(), 'base id')
    await assertEnabled(cwd, wanted, sessionIdOf(exec), 'read')
    const { base } = await loadBase(cwd, wanted)
    const id = String((args && args.node) || '').trim()
    const node = base.nodes.find((entry) => entry.id === id)
    if (!node) throw new Error('no node "' + id + '" in base "' + wanted + '"')
    return nodePictures(cwd, [node])
  },
}

const RAW_TOOLS = [read, createBase, writeNode, link, unlink, remove, select, removeBaseTool, showImages]

/**
 * Append one line describing a tool call, so a session's use of the base can be read afterwards.
 *
 * Deliberately terse: one line per call, with what it touched. This is a log for reading, not a store
 * for querying.
 */
/**
 * Read the activity log back into records.
 *
 * Lives next to `note` on purpose: the writer and the reader are the two halves of one format, and splitting them
 * across files is how a field list drifts. The separator is padded with two spaces on each side so a session id or
 * a node title containing a pipe does not split a record in half.
 *
 * `what` is optional — `knowledge_link` records only the base — so the tail is read from the end and the middle is
 * whatever is left.
 */
export function parseActivity(text) {
  const out = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split('  |  ')
    if (parts.length < 4) continue
    const took = parts[parts.length - 1]
    const what = parts.length > 4 ? parts.slice(3, -1).join('  |  ') : ''
    out.push({
      at: parts[0],
      session: parts[1],
      tool: parts[2],
      what,
      took,
    })
  }
  return out
}

/** The field separator, shared by the writer and the reader. Padded so a title containing a pipe cannot break a row. */
const ACTIVITY_SEP = '  |  '

/** One line of `activity.log`, from the pieces a record has. */
function activityRecord(at, sessionId, tool, what, tail) {
  // Placeholders rather than omission: a dropped field shifts every column after it, which is how a line ends up reading
// `kb-verify,,3ms`.
return [at, sessionId || '(no session)', tool, what || '-', tail || '-'].join(ACTIVITY_SEP)
}

/** A timestamp in the same shape the records use, local time. */
function activityStamp() {
  const two = (value) => String(value).padStart(2, '0')
  const now = new Date()
  return now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate())
    + ' ' + two(now.getHours()) + ':' + two(now.getMinutes()) + ':' + two(now.getSeconds())
}

/**
 * A record written before the tool runs, so a reader can tell "running now" from "has not happened yet".
 *
 * Only written when the workspace asks for it — see `readLive`. It doubles the file's growth, and the finished record
 * is the one an audit needs; this one exists for the panel's live line.
 */
async function noteStart(cwd, sessionId, tool, args) {
  try {
    const what = [args && args.base, args && args.node, args && args.title, args && args.attachment]
      .filter((part) => typeof part === 'string' && part).join(' / ')
    const file = join(cwd, '.dsh-knowledge', 'activity.log')
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, activityRecord(activityStamp(), sessionId, tool, what, 'running') + '\n', 'utf8')
  } catch {
    // Same rule as the finished record: a log is not worth failing a tool for, and a missing start line only costs
    // the live indicator for that one call.
  }
}

let noteFailed = false

async function note(cwd, sessionId, tool, args, result, took, error) {
  try {
    // The id, when this call did not carry one: a create has no id until it has run, and the returned sentence
    // names it (`Added node o46 "..."`). Reading our own sentence is a coupling — it breaks silently if the wording
    // changes — but the alternative is a panel line that cannot be taken back to a node.
    const resultId = !(args && args.node) && typeof result === 'string'
      ? (/(?:node)\s+([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(result) || [])[1]
      : undefined
    // Joined here, not left as an array: an array reaching the record becomes `a,b,c` through toString, which is what made
    // the log read like a list of ids glued together.
    const what = [args && args.base, (args && args.node) || resultId, args && args.title, args && args.attachment]
      .filter((part) => typeof part === 'string' && part).join(' / ')
    const shape = result === undefined || result === null ? ''
      : typeof result === 'string' ? ' ' + result.length + ' chars'
        : typeof result.text === 'string' ? ' ' + result.text.length + ' chars ' + (result.pictures || []).length + ' pictures'
          : ' ' + typeof result
    const outcome = error ? ' FAILED ' + (error.message || error) : shape
    const line = activityRecord(activityStamp(), sessionId, tool, what, took + 'ms' + outcome)
    const file = join(cwd, '.dsh-knowledge', 'activity.log')
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, line + '\n', 'utf8')
  } catch (error) {
    // A log is not worth failing a tool for, so this does not rethrow. But it does report — once — because
    // swallowing silently is how a broken instrument came to look exactly like an unused one: every call
    // threw a ReferenceError and the file stayed empty.
    if (!noteFailed) {
      noteFailed = true
      log('FAIL writing the activity log (reporting once): ' + ((error && error.message) || error))
    }
  }
}

/** Set once the tool exec shape has been reported. */
let execShapeLogged = false

/** The same tools, with each call recorded. */
/**
 * The host attachment service, handed in by index.js. It is the only route from a file on disk to an image block in a
 * tool result; null when the host does not expose it, and every use is guarded.
 */
let hostAttachments = null

export function useHostAttachments(service) {
  hostAttachments = service && typeof service.saveImages === 'function' ? service : null
}

export const TOOLS = RAW_TOOLS.map((tool) => Object.assign({}, tool, {
  async execute(args, exec) {
    const started = Date.now()
    // Once: what a tool's exec actually carries. The provider finds the id on its agent and this does not,
    // and the two are supposed to be looking at the same object.
    if (!execShapeLogged) {
      execShapeLogged = true
      const shape = (value, label) => {
        try {
          return label + '=[' + Object.keys(value || {}).join(',') + ']'
        } catch {
          return label + '=(unreadable)'
        }
      }
      const agent = exec && exec.agent
      const session = agent && agent.session
      log('tool exec shape: exec=' + shape(exec, '')
        + ' agent=' + (agent ? Object.keys(agent).join(',') : 'none')
        + ' session=' + (session ? Object.keys(session).join(',') : 'none')
        + ' header=' + (session && session.header ? Object.keys(session.header).join(',') : 'none')
        + ' id-found=' + JSON.stringify(sessionIdOf(agent)))
    }
    try {
      // The start line is written only when this workspace asked for it. Reading the switch costs one small file read
      // per call, which is the price of not caching a setting the user can flip while the process runs.
      const live = await readLive(cwdOf(exec))
      if (live) await noteStart(cwdOf(exec), sessionIdOf(exec), tool.name, args)
      const result = await tool.execute(args, exec)
      await note(cwdOf(exec), sessionIdOf(exec), tool.name, args, result, Date.now() - started, null)
      return result
    } catch (error) {
      await note(cwdOf(exec), sessionIdOf(exec), tool.name, args, null, Date.now() - started, error)
      throw error
    }
  },
}))
