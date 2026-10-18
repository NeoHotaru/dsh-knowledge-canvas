// Exercise the store against a throwaway directory, so the logic is checked without a reload.
// Run: node test-store.mjs

import { officeText } from './lib/office.js'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addLink, assertId, describeBase, listBases, loadBase, newBase, pathFor, revertNode, revertUnreviewed, removeNode, saveBase, upsertNode,
} from './lib/store.js'
import { TOOLS, parseActivity } from './lib/tools.js'
// As a namespace as well as by name: the cache tests drive refresh/needsRefresh/outlineFor as a sequence,
// and reading them from one object makes that sequence obvious.
import * as outline from './lib/outline.js'
import * as seed from './lib/seed.js'
import { sessionFileStem, sessionIdOf } from './lib/session.js'

let passed = 0
let failed = 0
function check(label, condition, detail) {
  if (condition) { passed += 1; console.log('  ok   ' + label) }
  else { failed += 1; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')) }
}

const cwd = await mkdtemp(join(tmpdir(), 'kbt-'))
console.log('workspace: ' + cwd + '\n')

// --- id validation -----------------------------------------------------------
console.log('id validation')
check('plain id passes', assertId('flow', 'base id') === 'flow')
check('dashes and digits pass', assertId('ops-2', 'base id') === 'ops-2')
for (const bad of ['../escape', 'a/b', 'a\\b', '', 'x'.repeat(65), 'a b', '.hidden']) {
  let threw = false
  try { assertId(bad, 'base id') } catch { threw = true }
  check('rejects ' + JSON.stringify(bad), threw)
}

// --- empty workspace ---------------------------------------------------------
console.log('\nempty workspace')
check('no bases yet', (await listBases(cwd)).length === 0)
check('listing a missing base throws', await loadBase(cwd, 'nope').then(() => false, () => true))

// --- create ------------------------------------------------------------------
console.log('\ncreate')
const base = newBase('flow', '发布流程', '发布流程', '打包 校验 上传')
await saveBase(pathFor(cwd, 'flow'), base)
check('base lists', (await listBases(cwd)).some((entry) => entry.id === 'flow'))
check('root node marked added', base.nodes[0].change === 'added')
check('root node has no parent', base.nodes[0].parent === null)

// --- write nodes -------------------------------------------------------------
console.log('\nwrite nodes')
const loaded1 = await loadBase(cwd, 'flow')
const a = upsertNode(loaded1.base, { title: '鎵撳寘', body: 'scripts/build.mjs', parent: 'n1' })
const b = upsertNode(loaded1.base, { title: '鏍￠獙', body: 'COMPATIBILITY.md', parent: 'n1' })
check('new node marked added', a.created === true && a.node.change === 'added')
check('ids increment', a.node.id === 'n2' && b.node.id === 'n3')
check('parent recorded', a.node.parent === 'n1')
check('update marks modified', (() => {
  const updated = upsertNode(loaded1.base, { node: 'n2', body: 'changed' })
  return updated.created === false && updated.node.change === 'modified' && updated.node.body === 'changed'
})(), JSON.stringify(loaded1.base.nodes[1]))
check('unknown parent rejected', (() => {
  try { upsertNode(loaded1.base, { title: 'x', parent: 'zzz' }); return false } catch { return true }
})())
check('new node without title rejected', (() => {
  try { upsertNode(loaded1.base, { body: 'no title' }); return false } catch { return true }
})())
check('update of missing node rejected', (() => {
  try { upsertNode(loaded1.base, { node: 'n99', body: 'x' }); return false } catch { return true }
})())
check('self-parent rejected', (() => {
  try { upsertNode(loaded1.base, { node: 'n2', parent: 'n2' }); return false } catch { return true }
})())

// Id generation: found by adding a node to a base whose ids are o1/o2/o3 and getting back n1.
console.log('\nid generation')
const prefixed = newBase('prefixed', '鍓嶇紑娴嬭瘯', '测试', '')
const first = upsertNode(prefixed, { title: '测试', parent: 'n1' })
check('a base with no numbered ids falls back to n', first.node.id === 'n2', first.node.id)
const oBase = { version: 1, id: 'o', name: 'o', nodes: [{ id: 'o1', parent: null, title: 'a' }], links: [] }
check('an o-prefixed base keeps its prefix',
  upsertNode(oBase, { title: 'b', parent: 'o1' }).node.id === 'o2')
const collision = {
  version: 1,
  id: 'c',
  name: 'c',
  nodes: [{ id: 'n1', parent: null, title: 'a' }, { id: 'n2', parent: null, title: 'b' }],
  links: [],
}
check('ids increment past the highest in use',
  upsertNode(collision, { title: 'c' }).node.id === 'n3',
  upsertNode(collision, { title: 'c' }).node.id)

// Mixed prefixes: the majority prefix wins, and the number continues past every prefix's
// highest so it can never land on an id that is already taken.
const mixed = {
  version: 1,
  id: 'm',
  name: 'm',
  nodes: [
    { id: 'n1', parent: null, title: 'a' },
    { id: 'n2', parent: null, title: 'b' },
    { id: 'o9', parent: null, title: 'c' },
  ],
  links: [],
}
check('a mixed base keeps the majority prefix and never reuses a number',
  upsertNode(mixed, { title: 'd' }).node.id === 'n10',
  upsertNode(mixed, { title: 'd' }).node.id)

// --- links -------------------------------------------------------------------
console.log('\nlinks')
addLink(loaded1.base, { from: 'n2', to: 'n3', note: '测试' })
check('link added', loaded1.base.links.length === 1 && loaded1.base.links[0].note === '测试')
check('duplicate rejected', (() => {
  try { addLink(loaded1.base, { from: 'n2', to: 'n3' }); return false } catch { return true }
})())
check('reverse duplicate rejected', (() => {
  try { addLink(loaded1.base, { from: 'n3', to: 'n2' }); return false } catch { return true }
})())
check('self link rejected', (() => {
  try { addLink(loaded1.base, { from: 'n2', to: 'n2' }); return false } catch { return true }
})())
check('link to missing node rejected', (() => {
  try { addLink(loaded1.base, { from: 'n2', to: 'n99' }); return false } catch { return true }
})())

// --- remove ------------------------------------------------------------------
console.log('\nremove')
const before = loaded1.base.nodes.length
removeNode(loaded1.base, 'n3')
check('node kept, not deleted', loaded1.base.nodes.length === before)
check('marked removed', loaded1.base.nodes.find((n) => n.id === 'n3').change === 'removed')
check('its links dropped', loaded1.base.links.length === 0)
check('double remove rejected', (() => {
  try { removeNode(loaded1.base, 'n3'); return false } catch { return true }
})())

// re-parenting on remove
const loaded2 = await loadBase(cwd, 'flow')
upsertNode(loaded2.base, { title: 'middle', parent: 'n1' })
const mid = loaded2.base.nodes[loaded2.base.nodes.length - 1]
upsertNode(loaded2.base, { title: 'leaf', parent: mid.id })
removeNode(loaded2.base, mid.id)
check('child re-parented to grandparent',
  loaded2.base.nodes.find((n) => n.title === 'leaf').parent === 'n1')

// --- persistence -------------------------------------------------------------
console.log('\npersistence')
await saveBase(loaded1.path, loaded1.base)
const reread = await loadBase(cwd, 'flow')
check('round-trips through disk', reread.base.nodes.find((n) => n.id === 'n3').change === 'removed')

// --- describe ----------------------------------------------------------------
console.log('\ndescribe')
const text = describeBase(loaded2.base)
check('mentions the base', text.includes('base "flow"'))
check('marks the removal', /\[removed\]/.test(describeBase(loaded1.base)))
check('indents by depth', /\n  - /.test(text))

// --- hand-edited garbage -----------------------------------------------------
console.log('\nrobustness')
await saveBase(pathFor(cwd, 'broken'), { version: 1, id: 'broken', name: 'broken', nodes: 'not an array' })
const broken = (await listBases(cwd)).find((entry) => entry.id === 'broken')
check('broken file still lists', Boolean(broken), 'listing threw or dropped it')
const loaded3 = await loadBase(cwd, 'broken')
check('nodes coerced to an array', Array.isArray(loaded3.base.nodes))
check('links coerced to an array', Array.isArray(loaded3.base.links))

// --- the prompt outline -------------------------------------------------------
console.log('\noutline')
const { gistOf, renderOutline, refresh, outlineFor, invalidate } = await import('./lib/outline.js')
const sample = await loadBase(cwd, 'flow')

const everything = renderOutline([sample.base], null)
check('mentions the base name and id', everything.includes('发布流程') && everything.includes('flow'))
check('does not dump bodies', !everything.includes('scripts/build.mjs'))
check('carries the review markers', everything.includes('[新增]') || everything.includes('[修改]'))
check('indents by depth', /\n {4}- n2/.test(everything),
  JSON.stringify(everything.split('\n').slice(3, 6)))
check('keeps a removed node out of the tree', !/^\s*- n3 /m.test(everything))
check('but still reports it as retired', /已废弃/.test(everything), everything.split('\n').slice(-2).join(' / '))
check('tells the model how to get bodies', everything.includes('knowledge_read'))
check('nothing enabled injects nothing', renderOutline([sample.base], new Set()) === '')
check('an unrelated selection injects nothing', renderOutline([sample.base], new Set(['nope'])) === '')
const twoBases = renderOutline([sample.base, newBase('other', '测试')], new Set(['flow']))
check('a matching selection injects only that base',
  twoBases.includes('flow') && !twoBases.includes('测试'))

// Links are dropped when a node is removed, so make one here to see the line render.
const linked = await loadBase(cwd, 'flow')
addLink(linked.base, { from: 'n2', to: 'n1', note: '测试' })
check('lists links', renderOutline([linked.base], null).includes('关联：n2<->n1'),
  renderOutline([linked.base], null).split('\n').slice(-1)[0])

await refresh(cwd)
const cached = outlineFor(cwd)
check('outlineFor returns the cached text', cached.includes('flow'), JSON.stringify(cached.slice(0, 60)))
check('an un-refreshed workspace returns empty rather than throwing',
  outlineFor(join(cwd, 'never-refreshed')) === '')

invalidate(cwd)
check('invalidate keeps the old text on hand instead of blanking it',
  outlineFor(cwd).includes('flow'), 'the prompt went empty for a turn')
await new Promise((resolve) => setTimeout(resolve, 80))
check('the rebuilt outline is still there', outlineFor(cwd).includes('flow'))

// --- the panel's write path ---------------------------------------------------
console.log('\nwrite path')
const routes = await import('./lib/routes.js')
const workspacesModule = await import('./lib/workspaces.js')
const state = await import('./lib/state.js')

// A base of its own, so these checks do not depend on what the earlier ones left behind.
const panelSeed = newBase('panel', '闈㈡澘娴嬭瘯', '测试', '')
await saveBase(pathFor(cwd, 'panel'), panelSeed)
const panelLoaded = await loadBase(cwd, 'panel')
const panelChild = upsertNode(panelLoaded.base, {
  title: '测试', body: '测试', parent: panelLoaded.base.nodes[0].id,
})
await saveBase(panelLoaded.path, panelLoaded.base)
const ROOT = panelLoaded.base.nodes[0].id
const CHILD = panelChild.node.id

check('no selection file means every base is on',
  (await routes.readPanelState(cwd)).enabled.length >= 3)
check('an unknown base is rejected', await routes.setSelection(cwd, ['panel', 'ghost'])
  .then(() => false, (error) => /no knowledge base/.test(error.message)))
check('a malformed base id is rejected', await routes.setSelection(cwd, ['../etc/passwd'])
  .then(() => false, () => true))
check('a non-array is rejected', await routes.setSelection(cwd, 'panel')
  .then(() => false, () => true))

// --- the activity log, read back ------------------------------------------------------
// The panel asks for this while a base is open, so "did the model ever come in here" stops requiring the user to
// open a log file after the fact. The parser lives next to the writer on purpose: they are two halves of one
// format, and the failure this guards against is a field list drifting apart.
console.log('\nthe activity log, read back')
const parsed = parseActivity([
  '2026-10-16 18:57:38  |  session-a  |  knowledge_read  |  ops / o36  |  3ms 2495 chars',
  '2026-10-16 19:18:41  |  session-a  |  knowledge_link  |  ops  |  14ms 75 chars',
  '',
  'this line is not a record',
].join('\n'))
check('a record with a node is split into its parts',
  parsed.length === 2 && parsed[0].tool === 'knowledge_read' && parsed[0].what === 'ops / o36'
    && parsed[0].took === '3ms 2495 chars', JSON.stringify(parsed[0]))
// A link names its base, and nothing else — so the four-field shape is exercised by a call that names no base
  // at all, which the parser reads from the end for exactly that reason.
  check('a link records only the base', parsed[1] && parsed[1].what === 'ops' && parsed[1].took === '14ms 75 chars',
  JSON.stringify(parsed[1]))
check('and a line that is not a record is dropped', !parsed.some((entry) => entry.tool.includes('not a record')))

const actCwd = await mkdtemp(join(tmpdir(), 'kbact-'))
await mkdir(join(actCwd, '.dsh-knowledge'), { recursive: true })
await writeFile(join(actCwd, '.dsh-knowledge', 'activity.log'), [
  '2026-10-16 10:00:00  |  session-a  |  knowledge_read  |  ops / o1  |  2ms 100 chars',
  '2026-10-16 10:00:05  |  session-b  |  knowledge_read  |  ops / o2  |  2ms 100 chars',
  '2026-10-16 10:00:09  |  session-a  |  knowledge_write_node  |  ops / 三  |  8ms 40 chars',
].join('\n') + '\n')
const ownSession = await routes.readActivity(actCwd, { session: 'session-a' })
check('the panel sees only its own session',
  ownSession.entries.length === 2 && ownSession.entries.every((entry) => entry.session === 'session-a'),
  JSON.stringify(ownSession.entries))
check('newest last, so the panel can read the tail',
  ownSession.entries[1] && ownSession.entries[1].tool === 'knowledge_write_node', JSON.stringify(ownSession.entries.at(-1)))
check('and the limit keeps only the end', (await routes.readActivity(actCwd, { limit: 1 })).entries.length === 1)
// A read names its node; a write used to name only the title, because a new node has no id until it has been written.
// The panel line is meant to be usable — you should be able to take the id from it and look the node up.
const writeCwd = await mkdtemp(join(tmpdir(), 'kbactwrite-'))
await saveBase(pathFor(writeCwd, 'notes'), newBase('notes', '笔记', '根', '正文。'))
const activityWriteTool = TOOLS.find((tool) => tool.name === 'knowledge_write_node')
const activityWriteExec = { agent: { session: { header: { cwd: writeCwd, id: 'sess-w' } } } }
await activityWriteTool.execute({ base: 'notes', title: '一篇', body: '正文。', session_name: '测试' }, activityWriteExec)
const writeLog = await readFile(join(writeCwd, '.dsh-knowledge', 'activity.log'), 'utf8')
const writeLine = parseActivity(writeLog).filter((entry) => entry.tool === 'knowledge_write_node').pop()
// The bug the diary test surfaced: the session's enabled list is a snapshot from when it started, so a base the model
// creates is missing from it — and the next write is refused as "switched off". The user had to flip it by hand.
const freshCwd = await mkdtemp(join(tmpdir(), 'kbcreate-'))
await saveBase(pathFor(freshCwd, 'keep'), newBase('keep', '保留', '根', '正文。'))
await state.writeSelection(freshCwd, ['keep'], 'sess-c')
const createTool = TOOLS.find((tool) => tool.name === 'knowledge_create_base')
const freshExec = { agent: { session: { header: { cwd: freshCwd, id: 'sess-c' } } } }
await createTool.execute({ id: 'brand-new', name: '新库' }, freshExec)
const afterCreate = await state.readSelection(freshCwd, 'sess-c')
// The two-writer bug: `writeSessionSelection` owns `enabled`, `writeDiary` owns `diary`, and each rebuilt the file from
// scratch. Turning the diary on, then creating a base, then writing was a three-step race the conversation always lost.
// revert undo: one call puts a base back to the state the user last accepted.
const revertCwd = await mkdtemp(join(tmpdir(), 'kbrevert-'))
await saveBase(pathFor(revertCwd, 'bag'), newBase('bag', '袋子', '根', '原来那句。'))

// Modify the root, exactly as a model edit does.
const working = await loadBase(revertCwd, 'bag')
// `node` is what makes this an edit rather than an append: without it upsertNode creates a new node.
upsertNode(working.base, { node: working.base.nodes[0].id, title: '改过的标题', body: '改后的句子。' })
await saveBase(working.path, working.base)

// Add one node, without touching it again afterwards.
const adding = await loadBase(revertCwd, 'bag')
upsertNode(adding.base, { title: '新加的', body: '新的。' })
await saveBase(adding.path, adding.base)

const pending = await loadBase(revertCwd, 'bag')
const counts = revertUnreviewed(pending.base)
await saveBase(pending.path, pending.base)
const revertedBase = await loadBase(revertCwd, 'bag')
check('revert undo takes back exactly what it says',
  counts.added === 1 && counts.modified === 1, JSON.stringify(counts))
check('and the modified node is back to its previous text',
  revertedBase.base.nodes[0].body === '原来那句。' && revertedBase.base.nodes[0].title === '根',
  revertedBase.base.nodes[0].title + ' / ' + revertedBase.base.nodes[0].body)
check('and the added node is gone, leaving only the root',
  revertedBase.base.nodes.length === 1, revertedBase.base.nodes.map((node) => node.id).join())
check('and nothing is left marked unreviewed',
  revertedBase.base.nodes.every((node) => !node.change),
  revertedBase.base.nodes.map((node) => node.change).join())

// One node at a time: the report asked for this, and the header button is the blunt version of it.
const singleCwd = await mkdtemp(join(tmpdir(), 'kbsingle-'))
await saveBase(pathFor(singleCwd, 'pair'), newBase('pair', '一对', '甲', '甲的原文。'))
const singleLoad = await loadBase(singleCwd, 'pair')
upsertNode(singleLoad.base, { node: singleLoad.base.nodes[0].id, title: '甲改过', body: '甲改后的。' })
upsertNode(singleLoad.base, { title: '乙', body: '乙的原文。' })
await saveBase(singleLoad.path, singleLoad.base)
const flagged = await loadBase(singleCwd, 'pair')
const what = revertNode(flagged.base, flagged.base.nodes[0].id)
await saveBase(flagged.path, flagged.base)
const settled = await loadBase(singleCwd, 'pair')
check('undo one node reports what it undid', what === 'modified', String(what))
check('undo one node leaves the others', settled.base.nodes.length === 2
  && settled.base.nodes[1].change === 'added', settled.base.nodes.map((n) => n.change).join())
check('and that node is back to its previous text',
  settled.base.nodes[0].body === '甲的原文。' && !settled.base.nodes[0].change, settled.base.nodes[0].body)

// A revival says so: "Updated" for a node the panel draws as removed hid what had actually happened.
const reviveCwd = await mkdtemp(join(tmpdir(), 'kbrevive-'))
await saveBase(pathFor(reviveCwd, 'rv'), newBase('rv', '复活', '根', '正文。'))
const reviveExec = { agent: { session: { header: { cwd: reviveCwd, id: 'rv-session' } } } }
const built = await loadBase(reviveCwd, 'rv')
upsertNode(built.base, { title: '第二个', body: '正文。' })
const second = built.base.nodes[built.base.nodes.length - 1].id
await saveBase(built.path, built.base)
await activityWriteTool.execute({ base: 'rv', node: second, title: '第二个', session_name: '测试' }, reviveExec)
const removal = await loadBase(reviveCwd, 'rv')
removeNode(removal.base, second)
await saveBase(removal.path, removal.base)
check('a write into a removed node says Restored',
  await activityWriteTool.execute({ base: 'rv', node: second, body: '复活后。' }, reviveExec)
    .then((value) => /Restored/.test(String(value)), (error) => 'refused: ' + error.message))

// The two writers that rebuild selection.json must not drop what they do not own.
const flagCwd = await mkdtemp(join(tmpdir(), 'kbflag-'))
await saveBase(pathFor(flagCwd, 'one'), newBase('one', '一', '根', '正文。'))
await saveBase(pathFor(flagCwd, 'two'), newBase('two', '二', '根', '正文。'))
await state.writeSelection(flagCwd, ['one', 'two'])
await state.writeLive(flagCwd, true)
await state.writeOrder(flagCwd, ['two', 'one'])
check('live survives reordering', await state.readLive(flagCwd) === true)

await state.writeInject(flagCwd, 'one', 'full')
check('live survives a change to one base injection mode', await state.readLive(flagCwd) === true)
check('and the injection mode is the one that was asked for',
  (await state.readInject(flagCwd)).one === 'full')

const bothCwd = await mkdtemp(join(tmpdir(), 'kbboth-'))
await state.writeDiary(bothCwd, true, 'keeper')
const keepCreate = TOOLS.find((tool) => tool.name === 'knowledge_create_base')
await keepCreate.execute({ id: 'fresh', name: '新库' }, { agent: { session: { header: { cwd: bothCwd, id: 'keeper' } } } })
// From a live session: a base that does not exist was reported as "switched off", which sends the model to a switch that is
// not there either. Missing and switched-off are different answers.
check('a missing base says it is missing, not that it is switched off',
  await activityWriteTool.execute({ base: 'no-such-base', title: 'x', body: 'y' },
    { agent: { session: { header: { cwd: bothCwd, id: 'keeper' } } } })
    .then(() => false, (error) => /no knowledge base/.test(error.message) && !/switched off/.test(error.message)))

// And: a session that inherits the workspace list must get the base it just created. It used to be added only to a session's
// own list, so the common case — no session file, a workspace list that does not name it — was refused on the next call.
const inheritCwd = await mkdtemp(join(tmpdir(), 'kbinherit-'))
await saveBase(pathFor(inheritCwd, 'existing'), newBase('existing', '旧库', '根', '正文。'))
await state.writeSelection(inheritCwd, ['existing'])
await keepCreate.execute({ id: 'brand-new-2', name: '新库' }, { agent: { session: { header: { cwd: inheritCwd, id: 'inheritor' } } } })
check('a created base joins the list the session inherits',
  await activityWriteTool.execute({ base: 'brand-new-2', title: '第一篇', body: '正文。', session_name: '测试' },
    { agent: { session: { header: { cwd: inheritCwd, id: 'inheritor' } } } })
    .then((value) => String(value).includes('第一篇'), (error) => 'refused: ' + error.message))

check('creating a base keeps the diary switch on', (await state.readDiary(bothCwd, 'keeper')) === true)
check('and turning it off does not invent a base list',
  (await state.writeDiary(bothCwd, false, 'keeper')) === false
    && (await state.readSelection(bothCwd, 'keeper')) === null)

check('a base created mid-conversation is usable at once',
  Boolean(afterCreate) && afterCreate.has('brand-new') && afterCreate.has('keep'),
  afterCreate ? [...afterCreate].join() : 'no list')
check('and the write tool accepts it',
  await activityWriteTool.execute(
    { base: 'brand-new', title: '第一篇', body: '正文。', session_name: '测试' }, freshExec,
  ).then((value) => String(value).includes('第一篇'), (error) => 'refused: ' + error.message))

check('the record of a write names the node it wrote',
  Boolean(writeLine) && writeLine.what.includes('notes')
    && /(^|[^A-Za-z0-9])n[0-9]+([^0-9]|$)/.test(writeLine.what), writeLine && writeLine.what)

check('a workspace with no log yet is empty, not an error',
  (await routes.readActivity(await mkdtemp(join(tmpdir(), 'kbnolog-')), {})).entries.length === 0)

// The live switch lives in selection.json next to `enabled`. That file is rebuilt whole on every toggle, so the one
// thing worth testing is that it survives — a setting that disappears when you flip an unrelated switch is worse than
// no setting, because nobody would connect the two.
const liveCwd = await mkdtemp(join(tmpdir(), 'kblive-'))
for (const id of ['one', 'two']) await saveBase(pathFor(liveCwd, id), newBase(id, id, '测试', ''))
check('the live switch starts off', (await state.readLive(liveCwd)) === false)
check('turning it on sticks', (await state.writeLive(liveCwd, true)) === true && (await state.readLive(liveCwd)))
await state.writeSelection(liveCwd, ['one'])
check('and toggling a base keeps it', (await state.readLive(liveCwd)) === true,
  JSON.stringify([...(await state.readSelection(liveCwd))]))
check('the base switch still took effect', [...(await state.readSelection(liveCwd))].join() === 'one')
await state.writeLive(liveCwd, false)
check('turning it off drops the field rather than storing false',
  (await state.readLive(liveCwd)) === false
    && !JSON.stringify(await state.readSelection(liveCwd)).includes('live'))
check('and the bases are still there', [...(await state.readSelection(liveCwd))].join() === 'one')
// The diary belongs to a conversation. There is no workspace default for it — that fallback is exactly what made one
// session's diary show up in all of them — so the tests state the two halves of that rule.
check('a session with no diary flag is not keeping one', (await state.readDiary(liveCwd, 'nobody')) === false)
check('and asking without a session is false too, not a guess at a default', (await state.readDiary(liveCwd)) === false)
check('turning it on without a session is refused',
  await state.writeDiary(liveCwd, true).then(() => false, (error) => /belongs to a conversation/.test(error.message)))
await state.writeDiary(liveCwd, true, 'keeper')
check('turning it on for one session sticks', (await state.readDiary(liveCwd, 'keeper')) === true)
check('and it does not leak into the workspace', (await state.readDiary(liveCwd)) === false
  && (await state.readDiary(liveCwd, 'other')) === false)
await state.writeDiary(liveCwd, false, 'keeper')
check('turning it off drops the field rather than storing false',
  (await state.readDiary(liveCwd, 'keeper')) === false
    && !JSON.stringify(await state.readSelection(liveCwd, 'keeper')).includes('diary'))
// Scoped per session. The thing that must not happen is "one session writes, every session writes".
check('a session starts off', (await state.readDiary(liveCwd, 's-1')) === false)
await state.writeDiary(liveCwd, true, 's-1')
check('turning it on for one session leaves the other session off',
  (await state.readDiary(liveCwd, 's-1')) === true && (await state.readDiary(liveCwd, 's-2')) === false)
check('and it does not become the workspace default',
  (await state.readDiary(liveCwd)) === false && (await state.readDiary(liveCwd, 's-3')) === false)
// A session with its own answer must keep it even when the workspace default changes underneath.
await state.writeDiary(liveCwd, false, 's-2')
check('one session keeping a diary leaves the others alone',
  (await state.readDiary(liveCwd, 's-1')) === true
    && (await state.readDiary(liveCwd, 's-2')) === false
    && (await state.readDiary(liveCwd, 's-3')) === false)
check('and a session file that exists for its base list keeps that list',
  await (async () => {
    await state.writeSelection(liveCwd, ['two'], 's-4')
    await state.writeDiary(liveCwd, true, 's-4')
    const list = await state.readSelection(liveCwd, 's-4')
    return Boolean(list) && [...list].join() === 'two' && (await state.readDiary(liveCwd, 's-4')) === true
  })())

// `parent` used to be reachable only from the model's tool. So a base the user built alone stayed flat, and
// "these two are parent and child" was a thing only one of the two writers could say.
console.log('\nbuilding structure from the panel')
// The diary is private to the session that keeps one, even though it lives in the same workspace. Without this, a work
// session's outline carries someone's diary — same workspace, same base list.
const diaryCwd = await mkdtemp(join(tmpdir(), 'kbdiary-'))
await saveBase(pathFor(diaryCwd, 'ops'), newBase('ops', '运维', '工作', '正文。'))
// The base belongs to one conversation: its name is a hash of that conversation's id.
const diaryBase = state.diaryBaseFor('diary-session')
await saveBase(pathFor(diaryCwd, diaryBase), newBase(diaryBase, '日记', '今天', '正文。'))
const diaryOutlineOf = async (session) => {
  await outline.refresh(diaryCwd, session)
  return outline.outlineFor(diaryCwd, session)
}
const workOutline = await diaryOutlineOf('work-session')
check('a work session does not see the diary base', !workOutline.includes('日记'),
  workOutline.slice(0, 120))
check('but it still sees the work base', workOutline.includes('运维'))
await state.writeDiary(diaryCwd, true, 'diary-session')
const diaryOutline = await diaryOutlineOf('diary-session')
check('the diary base is in the outline only for the session that keeps one',
  diaryOutline.includes('日记') && diaryOutline.includes('运维'), diaryOutline.slice(0, 160))
check('and the other session is untouched by that switch', !(await diaryOutlineOf('another-session')).includes('日记'))
const workPanel = await routes.readPanelState(diaryCwd, 'work-session')
check('the panel list hides the diary base',
  !workPanel.bases.some((id) => id.startsWith('diary-')) && workPanel.bases.includes('ops'), JSON.stringify(workPanel.bases))
const diaryPanel = await routes.readPanelState(diaryCwd, 'diary-session')
// A tool that guesses the id must get the same answer as a session that never saw it — which is the whole point of
// hiding it in the first two layers.
const diaryReadTool = TOOLS.find((tool) => tool.name === 'knowledge_read')
const diaryExecFor = (session) => ({ agent: { session: { header: { cwd: diaryCwd, id: session } } } })
check('the read tool refuses the diary from a session that is not keeping one',
  await diaryReadTool.execute({ base: diaryBase }, diaryExecFor('work-session')).then(() => false, (error) => /no knowledge base/.test(error.message)))
await state.writeDiary(diaryCwd, true, 'diary-session')
check('and allows it for a session that is',
  await diaryReadTool.execute({ base: diaryBase }, diaryExecFor('diary-session')).then((value) => String(value).includes('日记'), () => false))

// The case that surfaced in a live session: the diary base already exists (someone made it earlier), the session turns
// the diary on, but that session's enabled list was written before the base existed — so the base is not in it. Writing
// has to work anyway: keeping a diary means being able to write it.
await state.writeSelection(diaryCwd, ['ops'], 'diary-session')
await state.writeDiary(diaryCwd, true, 'diary-session')
check('a diary written by a session whose list predates the base still works',
  await diaryReadTool.execute({ base: diaryBase }, diaryExecFor('diary-session'))
    .then((value) => String(value).includes('日记'), (error) => false))

// o47's four judgements, in one place: two conversations keeping diaries must not see each other's, and each must see its
// own. The name is a hash of the conversation id, so the two are different by construction — what needs asserting is that
// every layer agrees on which one is whose.
const twoCwd = await mkdtemp(join(tmpdir(), 'kbtwo-'))
const firstBase = state.diaryBaseFor('conv-a')
const secondBase = state.diaryBaseFor('conv-b')
await saveBase(pathFor(twoCwd, firstBase), newBase(firstBase, '甲', '今天', '正文。'))
await saveBase(pathFor(twoCwd, secondBase), newBase(secondBase, '乙', '今天', '正文。'))
check('two conversations get two diaries', firstBase !== secondBase)
await state.writeDiary(twoCwd, true, 'conv-a')

const twoTool = TOOLS.find((tool) => tool.name === 'knowledge_read')
const twoExec = (session) => ({ agent: { session: { header: { cwd: twoCwd, id: session } } } })
check('a conversation reads its own diary',
  await twoTool.execute({ base: firstBase }, twoExec('conv-a'))
    .then((value) => String(value).includes('甲'), () => false))
check('and not the other conversation\'s',
  await twoTool.execute({ base: secondBase }, twoExec('conv-a')).then(() => false, () => true))
check('the other conversation cannot read it either',
  await twoTool.execute({ base: firstBase }, twoExec('conv-b')).then(() => false, () => true))
const twoPanel = await routes.readPanelState(twoCwd, 'conv-a')
// Sealing: the point is that a file read outside the plugin yields nothing, while the plugin itself is unaware of it.
const sealedCwd = await mkdtemp(join(tmpdir(), 'kbseal-'))
const sealedId = state.diaryBaseFor('conv-sealed')
const sealedBase = newBase(sealedId, '日记', '今天', '这句话不该出现在磁盘上。')
await saveBase(pathFor(sealedCwd, sealedId), sealedBase)
const sealedText = await readFile(pathFor(sealedCwd, sealedId), 'utf8')
check('a diary is not stored as plain text',
  !sealedText.includes('这句话不该出现在磁盘上') && sealedText.includes('aes-256-gcm'), sealedText.slice(0, 40))
check('and reads back through the normal path',
  (await loadBase(sealedCwd, sealedId)).base.nodes[0].body === '这句话不该出现在磁盘上。')
check('and is listed with its content, not as an empty base',
  (await listBases(sealedCwd)).some((base) => base.id === sealedId && base.nodes.length > 0))
check('a tampered file is refused rather than silently empty',
  await (async () => {
    const path = pathFor(sealedCwd, sealedId)
    const broken = JSON.parse(sealedText)
    broken.data = broken.data.slice(0, 8)
    await saveBase(pathFor(sealedCwd, 'other'), newBase('other', 'other', 'x', 'y'))
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, JSON.stringify(broken), 'utf8')
    return loadBase(sealedCwd, sealedId).then(() => false, () => true)
  })())

check('the panel shows only its own diary',
  twoPanel.bases.includes(firstBase) && !twoPanel.bases.includes(secondBase),
  JSON.stringify(twoPanel.bases))

check('and shows it to the session that keeps one',
  diaryPanel.bases.includes(diaryBase) && diaryPanel.bases.includes('ops'), JSON.stringify(diaryPanel.bases))

const treeCwd = await mkdtemp(join(tmpdir(), 'kbtree-'))
await saveBase(pathFor(treeCwd, 'tree'), {
  version: 1, id: 'tree', name: 'tree',
  nodes: [
    { id: 'r', parent: null, title: '根', body: '正文。' },
    { id: 'a', parent: 'r', title: '甲', body: '正文。' },
    { id: 'b', parent: null, title: '乙', body: '正文。' },
  ],
  links: [],
})
const readTree = async () => (await loadBase(treeCwd, 'tree')).base
const byId = (bases, id) => bases.nodes.find((node) => node.id === id)

const childMade = await routes.createNodeFromPanel(treeCwd, 'tree', { title: '子', parent: 'a' })
check('a child is created under the node it names',
  byId(await readTree(), childMade.node).parent === 'a', childMade.node)

// A parent is not created above an existing node — it is created at the top level from the canvas menu and given
// children afterwards. Inserting one above would either give the target two parents (impossible: one `parent`
// field) or reroute it out of its branch as a side effect. So there is no `above` on this path at all.
const afterChild = await readTree()
const knownIds = new Set(afterChild.nodes.map((node) => node.id))
check('creating from the panel leaves every parent pointer resolvable',
  afterChild.nodes.every((node) => node.parent === null || knownIds.has(node.parent)),
  JSON.stringify(afterChild.nodes.map((node) => node.id + '<' + node.parent)))

const moved = await routes.setParent(treeCwd, 'tree', { node: 'b', parent: 'r' })
check('a node can be moved under another', moved.parent === 'r', JSON.stringify(moved))
const lifted = await routes.setParent(treeCwd, 'tree', { node: 'b', parent: null })
check('and lifted back to the top level', lifted.parent === null && byId(await readTree(), 'b').parent === null,
  JSON.stringify(lifted))

check('a node cannot be its own parent', await routes.setParent(treeCwd, 'tree', { node: 'b', parent: 'b' })
  .then(() => false, (error) => /its own parent/.test(error.message)))
// The loop case is the one that matters: without it a tree becomes a cycle, and everything downstream — the
// outline walk, the edge routing — has to defend itself against a shape it was never written for.
//
// `b` is put back under `r` first, deliberately: at this point the previous assertion has left `b` at the top
// level, and moving `r` under a root is not a loop at all. A test that "passes" for that reason would be checking
// nothing.
await routes.setParent(treeCwd, 'tree', { node: 'b', parent: 'r' })
check('and moving a node under its own descendant is refused',
  await routes.setParent(treeCwd, 'tree', { node: 'r', parent: 'b' })
    .then(() => false, (error) => /loop/.test(error.message)))
check('a move to a node that is not there is refused',
  await routes.setParent(treeCwd, 'tree', { node: 'b', parent: 'ghost' })
    .then(() => false, (error) => /is not in this base/.test(error.message)))
check('and the tree is unchanged after every refusal',
  JSON.stringify((await readTree()).nodes.map((node) => node.id + '<' + node.parent))
    === JSON.stringify(['r<null', 'a<r', 'b<r', childMade.node + '<a']),
  JSON.stringify((await readTree()).nodes.map((node) => node.id + '<' + node.parent)))

const saved = await routes.setSelection(cwd, ['panel'])
check('selection is written and read back',
  JSON.stringify(saved.enabled) === '["panel"]'
  && (await state.readSelection(cwd)).has('panel')
  && !(await state.readSelection(cwd)).has('flow'))

check('layout rejects an unknown base', await routes.setLayout(cwd, 'ghost', { n1: { x: 1, y: 2 } })
  .then(() => false, () => true))
const layout = await routes.setLayout(cwd, 'panel', {
  [ROOT]: { x: 12.7, y: -3.2 },
  bad1: { x: Number.NaN, y: 5 },
  bad2: 'nonsense',
})
check('finite coordinates are rounded and kept',
  layout.positions[ROOT].x === 13 && layout.positions[ROOT].y === -3, JSON.stringify(layout.positions))
check('non-finite and malformed spots are dropped',
  !('bad1' in layout.positions) && !('bad2' in layout.positions), JSON.stringify(layout.positions))
check('layout is scoped per base', Object.keys(await state.readLayout(cwd)).length === 1)

// Clearing the marker is the "I have looked at this" action.
const changed = await routes.applyChanges(cwd, 'panel', {
  edits: [{ node: CHILD, title: '测试', body: '鐢ㄦ测试' }],
  links: [{ from: CHILD, to: ROOT, note: '浜烘墜杩炵殑' }],
})
check('the edit is applied', changed.edited.includes(CHILD))
const edited = (await loadBase(cwd, 'panel')).base.nodes.find((n) => n.id === CHILD)
check('the model marker was on it before the edit, and is gone after',
  edited.change === undefined, JSON.stringify(edited))
check('the new body is on disk', edited.body === '鐢ㄦ测试')
check('the link is added', changed.linksAdded.length === 1)

const again = await routes.applyChanges(cwd, 'panel', { links: [{ from: CHILD, to: ROOT }] })
check('re-applying the same link is idempotent, not an error',
  again.linksAdded.length === 0 && again.linksAlreadyPresent.length === 1, JSON.stringify(again))

check('a link to a missing node still fails loudly',
  await routes.applyChanges(cwd, 'panel', { links: [{ from: CHILD, to: 'nope' }] })
    .then(() => false, (error) => /not in this base/.test(error.message)))

const withLinks = (await loadBase(cwd, 'panel')).base.links
check('the base did not gain a duplicate link', withLinks.length === 1, JSON.stringify(withLinks))

// A model write must re-mark; only the user's edit clears.
const remarked = await loadBase(cwd, 'panel')
upsertNode(remarked.base, { node: CHILD, body: '妯″测试' })
check('a model write marks it modified again',
  remarked.base.nodes.find((n) => n.id === CHILD).change === 'modified')

// Undo has to be a real deletion now that drawing a link saves it immediately.
const undone = await routes.applyChanges(cwd, 'panel', { removeLinks: [{ from: CHILD, to: ROOT }] })
check('removing a link deletes it from the file',
  undone.linksRemoved.length === 1 && (await loadBase(cwd, 'panel')).base.links.length === 0,
  JSON.stringify((await loadBase(cwd, 'panel')).base.links))
const twice = await routes.applyChanges(cwd, 'panel', { removeLinks: [{ from: CHILD, to: ROOT }] })
check('undoing something already gone is not an error', twice.linksRemoved.length === 0)

// Accepting a change without editing it.
const beforeReview = await loadBase(cwd, 'panel')
upsertNode(beforeReview.base, { node: ROOT, body: '妯″瀷鍐欑殑' })
await saveBase(beforeReview.path, beforeReview.base)
check('the model re-marked the root node',
  (await loadBase(cwd, 'panel')).base.nodes.find((n) => n.id === ROOT).change === 'modified')
const accepted = await routes.applyChanges(cwd, 'panel', { review: [ROOT] })
const reviewed = (await loadBase(cwd, 'panel')).base.nodes.find((n) => n.id === ROOT)
check('review clears the marker without touching the text',
  accepted.reviewed.includes(ROOT) && reviewed.change === undefined && reviewed.body === '妯″瀷鍐欑殑',
  JSON.stringify(reviewed))
check('reviewing an already-clean node is harmless',
  (await routes.applyChanges(cwd, 'panel', { review: [ROOT] })).reviewed.includes(ROOT))

// --- removing a whole base ----------------------------------------------------
console.log('\nremove a base')
const { removeBase, listBases: listNow } = await import('./lib/store.js')
const toolsModule = await import('./lib/tools.js')
const removeBaseTool = toolsModule.TOOLS.find((tool) => tool.name === 'knowledge_remove_base')
const fakeExec = { agent: { session: { header: { cwd } } } }

await routes.setSelection(cwd, ['panel', 'flow'])
check('two bases are enabled before the removal', (await state.readSelection(cwd)).size === 2)
check('the base is listed before the removal',
  (await listNow(cwd)).some((base) => base.id === 'flow'))

const parked = await removeBase(cwd, 'flow')
check('it is no longer listed', !(await listNow(cwd)).some((base) => base.id === 'flow'))
check('but the file still exists where it was parked',
  parked.includes('.removed') && (await readFile(parked, 'utf8')).includes('发布流程'),
  parked)
check('the other bases are untouched', (await listNow(cwd)).some((base) => base.id === 'panel'))
check('removing a base twice fails clearly',
  await removeBase(cwd, 'flow').then(() => false, (error) => /no knowledge base/.test(error.message)))

// The tool also drops it from the enabled set, so the selection cannot name a base that is gone.
const toolResult = await removeBaseTool.execute({ base: 'panel' }, fakeExec)
check('the tool removes the base', !(await listNow(cwd)).some((base) => base.id === 'panel'))
check('the tool reports where the file went', toolResult.includes('.removed'), toolResult)
check('and takes it out of the enabled set',
  !(await state.readSelection(cwd)).has('panel'),
  JSON.stringify([...(await state.readSelection(cwd))]))

// --- renaming, and removing from the panel -----------------------------------
console.log('\nrename and panel-remove')
await saveBase(pathFor(cwd, 'renameme'), newBase('renameme', '旧名字', '测试', ''))
const renamed = await routes.renameBaseFromPanel(cwd, 'renameme', '  新名字  ')
check('the new name is trimmed and stored', renamed.name === '新名字')
check('it survives a reload', (await loadBase(cwd, 'renameme')).base.name === '新名字')
check('the id, and so the file name, did not change',
  (await listNow(cwd)).some((base) => base.id === 'renameme'))
check('an empty name is refused',
  await routes.renameBaseFromPanel(cwd, 'renameme', '   ')
    .then(() => false, (error) => /name cannot be empty/.test(error.message)))

await routes.setSelection(cwd, ['renameme'])
const gone = await routes.removeBaseFromPanel(cwd, 'renameme')
check('the panel removal parks the file', gone.parked.includes('.removed'), gone.parked)
check('and drops it from the enabled set', gone.droppedFromSelection === true)
check('so it is gone from the listing and the selection',
  !(await listNow(cwd)).some((base) => base.id === 'renameme')
  && !(await state.readSelection(cwd)).has('renameme'))

// --- ordering ----------------------------------------------------------------
console.log('\nordering')
for (const id of ['zed', 'alpha', 'mid']) {
  await saveBase(pathFor(cwd, id), newBase(id, id, 'root'))
}
await state.writeOrder(cwd, ['zed', 'alpha', 'mid'])
check('the order round-trips', (await state.readOrder(cwd)).join(',') === 'zed,alpha,mid',
  JSON.stringify(await state.readOrder(cwd)))
const mines = (list) => list.map((base) => base.id).filter((id) => ['zed', 'alpha', 'mid'].includes(id))
check('and the listing follows it',
  mines(await state.basesInOrder(cwd)).join(',') === 'zed,alpha,mid',
  mines(await state.basesInOrder(cwd)).join(','))
await saveBase(pathFor(cwd, 'later'), newBase('later', '测试', 'root'))
const withLater = (await state.basesInOrder(cwd)).map((base) => base.id)
check('a base that was never placed comes after the placed ones',
  withLater.indexOf('later') > withLater.indexOf('mid'),
  withLater.join(','))
check('an unknown id is not in the order', !(await state.readOrder(cwd)).includes('nope'))

// The interaction that would silently eat the arrangement.
await state.writeSelection(cwd, ['zed', 'mid'])
check('switching bases keeps the order',
  (await state.readOrder(cwd)).join(',') === 'zed,alpha,mid',
  JSON.stringify(await state.readOrder(cwd)))
await state.writeOrder(cwd, ['mid', 'zed', 'alpha'])
check('reordering keeps the switches',
  [...(await state.readSelection(cwd))].sort().join(',') === 'mid,zed',
  JSON.stringify([...(await state.readSelection(cwd))]))

// The route validates rather than rejecting the whole drag: a base can vanish mid-drag.
const dropped = await routes.setOrder(cwd, ['mid', 'ghost', '../../etc', 'mid', 'zed', 'alpha'])
check('the route drops unknown and malformed ids instead of failing',
  dropped.order.join(',') === 'mid,zed,alpha', JSON.stringify(dropped.order))
check('a non-array order is refused',
  await routes.setOrder(cwd, 'nope').then(() => false, (error) => /must be an array/.test(error.message)))

// No cleanup: the workspace is a throwaway directory and the harness removes it a few lines
// down. Deleting the bases here only risked a locked temp file on Windows.

// --- node colours ------------------------------------------------------------
console.log('\nnode colours')
const paintBase = newBase('paint', '涓婅壊', '测试', '')
await saveBase(pathFor(cwd, 'paint'), paintBase)
// The root id is generated, so read it rather than assuming: naming it in the test made the test
// wrong rather than the code.
// Read the id back from disk: the in-memory object and the saved file disagreed, and the test was
// the thing that was wrong.
const rootId = (await loadBase(cwd, 'paint')).base.nodes[0].id
await state.writeColors(cwd, 'paint', { [rootId]: '#c0392b', second: '#2e9e5b' })
check('colours round-trip',
  JSON.stringify((await state.readColors(cwd)).paint) === JSON.stringify({ [rootId]: '#c0392b', second: '#2e9e5b' }),
  JSON.stringify(await state.readColors(cwd)))
await state.writeColors(cwd, 'paint', { [rootId]: 'red; background: url(x)', second: '#2E9E5B' })
check('only a plain hex survives, and it is normalised',
  JSON.stringify((await state.readColors(cwd)).paint) === '{"second":"#2e9e5b"}',
  JSON.stringify((await state.readColors(cwd)).paint))
await state.writeLayout(cwd, 'paint', { [rootId]: { x: 5, y: 6 } })
check('moving a box keeps the colours',
  (await state.readColors(cwd)).paint.second === '#2e9e5b')
await state.writeColors(cwd, 'paint', { second: '#2f6fd0' })
check('recolouring keeps the positions',
  (await state.readLayout(cwd)).paint[rootId].x === 5)
const painted = await routes.setColor(cwd, 'paint', rootId, '#7d5bbe')
check('the route colours a node', painted.colors[rootId] === '#7d5bbe')
check('and clears it with null',
  Object.keys((await routes.setColor(cwd, 'paint', rootId, null)).colors).includes(rootId) === false)
check('an unknown node is refused',
  await routes.setColor(cwd, 'paint', 'ghost', '#000000')
    .then(() => false, (error) => /no node/.test(error.message)))

// --- reviewing in bulk --------------------------------------------------------
console.log('\nbulk review')
// The panel accepts a whole base at once, which means one request carries many ids. The host
// already took an array; this is the first caller to use it that way.
await saveBase(pathFor(cwd, 'bulk'), newBase('bulk', '鎵归噺', '测试', ''))
const opened = await loadBase(cwd, 'bulk')
upsertNode(opened.base, { title: '涓€', body: 'a' })
upsertNode(opened.base, { title: '测试', body: 'b' })
await saveBase(opened.path, opened.base)
const marked = (await loadBase(cwd, 'bulk')).base
const ids = marked.nodes.filter((node) => node.change).map((node) => node.id)
check('a model write marks its node', ids.length >= 2, 'marked: ' + ids.join(','))
const bulk = await routes.applyChanges(cwd, 'bulk', { review: ids })
check('one request reviews them all', bulk.reviewed.length === ids.length,
  JSON.stringify(bulk.reviewed.map((node) => node.id)))
const after = (await loadBase(cwd, 'bulk')).base
check('and every mark is gone', after.nodes.every((node) => !node.change),
  JSON.stringify(after.nodes.map((node) => node.change)))

// --- layout shapes -------------------------------------------------------------
console.log('\nlayout shapes')
await saveBase(pathFor(cwd, 'shaped'), newBase('shaped', '排版', '测试', ''))
// The old key still reads. `modes` in layout.json is what a test session mistook for the injection switch;
// renaming it is only safe if the workspaces that already have it keep their arrangement.
await state.writeLayout(cwd, 'legacy', {})
await state.writeShape(cwd, 'legacy', 'staircase')
const legacyFile = JSON.parse(await readFile(join(cwd, '.dsh-knowledge', 'layout.json'), 'utf8'))
check('the new key is what gets written', legacyFile.shapes && legacyFile.shapes.legacy === 'staircase')
check('and the old key is gone after a write', legacyFile.modes === undefined)
const handcrafted = JSON.parse(JSON.stringify(legacyFile))
handcrafted.modes = { old: 'radial' }
delete handcrafted.shapes
await writeFile(join(cwd, '.dsh-knowledge', 'layout.json'), JSON.stringify(handcrafted), 'utf8')
check('a file that still says modes is still read', (await state.readShapes(cwd)).old === 'radial')

// And reading it is what cleans the file. Asserted against the file itself, not against a returned value:
// the complaint was about what is on disk, and only the file answers that.
const migrated = JSON.parse(await readFile(join(cwd, '.dsh-knowledge', 'layout.json'), 'utf8'))
check('reading migrates the old key away', migrated.modes === undefined, JSON.stringify(migrated))
check('and leaves the arrangement under the new one', migrated.shapes && migrated.shapes.old === 'radial', JSON.stringify(migrated.shapes))

// A second read must not write again, and must still return the same thing.
const twiceRead = await state.readShapes(cwd)
check('a second read is stable', twiceRead.old === 'radial')
check('nothing stored by default', (await state.readShapes(cwd)).shaped === undefined)
await state.writeShape(cwd, 'shaped', 'staircase')
check('a shape round-trips', (await state.readShapes(cwd)).shaped === 'staircase')
check('an unknown shape is refused',
  await state.writeShape(cwd, 'shaped', 'spiral')
    .then(() => false, (error) => /unknown layout shape/.test(error.message)))
// Three fields share one file, so every writer has to carry the other two.
await state.writeLayout(cwd, 'shaped', { n1: { x: 4, y: 5 } })
check('moving a box keeps the shape', (await state.readShapes(cwd)).shaped === 'staircase')
await state.writeColors(cwd, 'shaped', { n1: '#2e9e5b' })
check('colouring a node keeps the shape', (await state.readShapes(cwd)).shaped === 'staircase')
await state.writeShape(cwd, 'shaped', 'compact')
check('changing the mode keeps the positions', (await state.readLayout(cwd)).shaped.n1.x === 4)
check('and keeps the colours', (await state.readColors(cwd)).shaped.n1 === '#2e9e5b')
const routed = await routes.setShape(cwd, 'shaped', 'radial')
check('the route sets a shape', routed.shapes.shaped === 'radial')
check('and refuses an unknown base',
  await routes.setShape(cwd, 'nope', 'radial')
    .then(() => false, (error) => /no knowledge base/.test(error.message)))

// --- removing a node from the panel -------------------------------------------
console.log('\nremoving a node from the panel')
await saveBase(pathFor(cwd, 'trim'), newBase('trim', '测试', '测试', ''))
const trimOpened = await loadBase(cwd, 'trim')
const trimRoot = trimOpened.base.nodes[0].id
// The store returns wrappers, not the things themselves: upsertNode gives { node, created } and
// loadBase gives { path, base }. Assuming otherwise is a mistake I made twice in one session.
const child = upsertNode(trimOpened.base, { title: '瀛╁瓙', body: '测试', parent: trimRoot }).node
const spare = upsertNode(trimOpened.base, { title: '鍙︿测试', body: '鏃犲叧', parent: trimRoot }).node
addLink(trimOpened.base, { from: child.id, to: spare.id, note: '测试' })
await saveBase(trimOpened.path, trimOpened.base)

const trimmed = await routes.removeNodeFromPanel(cwd, 'trim', child.id)
check('the route reports the node it removed', trimmed.node === child.id)
const afterTrim = (await loadBase(cwd, 'trim')).base
// Named apart from the earlier `gone` in this file: a duplicate const is a syntax error, and the
// whole suite refuses to load rather than reporting one failure.
const softDeleted = afterTrim.nodes.find((node) => node.id === child.id)
check('the node is still in the file', Boolean(softDeleted))
check('but marked removed', softDeleted && softDeleted.change === 'removed')
check('nothing is left pointing at it',
  afterTrim.links.every((link) => link.from !== child.id && link.to !== child.id),
  JSON.stringify(afterTrim.links))
check('a node already removed is refused',
  await routes.removeNodeFromPanel(cwd, 'trim', child.id)
    .then(() => false, (error) => /already marked removed/.test(error.message)))
check('an unknown node is refused',
  await routes.removeNodeFromPanel(cwd, 'trim', 'ghost')
    .then(() => false, (error) => /is not in this base/.test(error.message)))

// --- creating a node from the panel -------------------------------------------
console.log('\ncreating a node from the panel')
await saveBase(pathFor(cwd, 'fresh'), newBase('fresh', '鏂板缓', '测试', ''))
const freshRoot = (await loadBase(cwd, 'fresh')).base.nodes[0].id

const made = await routes.createNodeFromPanel(cwd, 'fresh', { title: '测试', body: '姝ｆ枃' })
check('the route returns the new id', typeof made.node === 'string' && made.node.length > 0, made.node)
const freshBase = (await loadBase(cwd, 'fresh')).base
const freshNode = freshBase.nodes.find((node) => node.id === made.node)
check('the node is in the file', Boolean(freshNode))
check('it carries the text', freshNode && freshNode.title === '测试' && freshNode.body === '姝ｆ枃')
check('it is marked as an addition, like a model write', freshNode && freshNode.change === 'added')
check('it is a root by default', freshNode && freshNode.parent === null, String(freshNode && freshNode.parent))

const nested = await routes.createNodeFromPanel(cwd, 'fresh', { title: '鎸傚湪涓嬮潰', parent: freshRoot })
const nestedNode = (await loadBase(cwd, 'fresh')).base.nodes.find((node) => node.id === nested.node)
check('a parent puts it under that node', nestedNode && nestedNode.parent === freshRoot)

check('a missing title is refused',
  await routes.createNodeFromPanel(cwd, 'fresh', { body: '娌℃测试' })
    .then(() => false, (error) => /title/.test(error.message)))
check('an unknown parent is refused',
  await routes.createNodeFromPanel(cwd, 'fresh', { title: 'x', parent: 'ghost' })
    .then(() => false, (error) => /parent/.test(error.message)))
check('an unknown base is refused',
  await routes.createNodeFromPanel(cwd, 'nope', { title: 'x' })
    .then(() => false, (error) => /no knowledge base/.test(error.message)))

// --- purging a node -----------------------------------------------------------
console.log('\npurging a node')
await saveBase(pathFor(cwd, 'purge'), newBase('purge', '褰诲簳鍒犻櫎', '测试', ''))
const purgeOpened = await loadBase(cwd, 'purge')
const purgeRoot = purgeOpened.base.nodes[0].id
const keeper = upsertNode(purgeOpened.base, { title: '淇濈暀', body: '瑕佺暀涓嬬殑', parent: purgeRoot }).node
const doomed = upsertNode(purgeOpened.base, { title: '瑕佸幓鎺夌殑', body: '测试', parent: purgeRoot }).node
await saveBase(purgeOpened.path, purgeOpened.base)

check('a live node cannot be purged',
  await routes.purgeNodeFromPanel(cwd, 'purge', keeper.id)
    .then(() => false, (error) => /not removed yet/.test(error.message)))
await routes.removeNodeFromPanel(cwd, 'purge', doomed.id)
const purged = await routes.purgeNodeFromPanel(cwd, 'purge', doomed.id)
check('the route reports the node it purged', purged.node === doomed.id)
const afterPurge = (await loadBase(cwd, 'purge')).base
check('it is gone from the file', !afterPurge.nodes.some((node) => node.id === doomed.id))
check('the others are untouched', afterPurge.nodes.some((node) => node.id === keeper.id))
check('an unknown node is refused',
  await routes.purgeNodeFromPanel(cwd, 'purge', 'ghost')
    .then(() => false, (error) => /is not in this base/.test(error.message)))

// --- node widths ---------------------------------------------------------------
console.log('\nnode widths')
await saveBase(pathFor(cwd, 'wide'), newBase('wide', '瀹藉害', '测试', ''))
const wideOpened = await loadBase(cwd, 'wide')
const wideChild = upsertNode(wideOpened.base, { title: '瀛╁瓙', body: 'x', parent: wideOpened.base.nodes[0].id }).node
await saveBase(wideOpened.path, wideOpened.base)

check('nothing stored by default', (await state.readWidths(cwd)).wide === undefined)
await state.writeBaseWidth(cwd, 'wide', 260)
check('a base width round-trips', (await state.readWidths(cwd)).wide === 260)
await state.writeNodeWidth(cwd, 'wide', wideChild.id, 320)
check('a node width round-trips', (await state.readSizes(cwd)).wide[wideChild.id].w === 320)
check('the node width wins over the base width',
  state.widthOf(await state.readWidths(cwd), await state.readSizes(cwd), 'wide', wideChild.id) === 320)
check('a node without its own width falls back to the base',
  state.widthOf(await state.readWidths(cwd), await state.readSizes(cwd), 'wide', 'someone-else') === 260)
check('and a base without one falls back to the default',
  state.widthOf({}, {}, 'quiet', 'n1') === 176)

// Five fields share one file now, so every writer has to carry the other four.
await state.writeLayout(cwd, 'wide', { n1: { x: 1, y: 2 } })
check('moving a box keeps the widths', (await state.readWidths(cwd)).wide === 260)
await state.writeColors(cwd, 'wide', { n1: '#2e9e5b' })
check('colouring keeps the widths', (await state.readWidths(cwd)).wide === 260)
await state.writeShape(cwd, 'wide', 'compact')
check('the mode keeps the widths', (await state.readSizes(cwd)).wide[wideChild.id].w === 320)
check('and the positions survive all of it', (await state.readLayout(cwd)).wide.n1.x === 1)

check('a silly width is refused',
  await state.writeBaseWidth(cwd, 'wide', 4)
    .then(() => false, (error) => /width/.test(error.message)))
check('so is a silly node width',
  await state.writeNodeWidth(cwd, 'wide', wideChild.id, 99999)
    .then(() => false, (error) => /width/.test(error.message)))

// --- the width route -----------------------------------------------------------
console.log('\nthe width route')
const routedWidth = await routes.setWidth(cwd, 'wide', { width: 300 })
check('a base width goes through the route', routedWidth.widths.wide === 300)
const routedNode = await routes.setWidth(cwd, 'wide', { node: wideChild.id, width: 240 })
check('a node width goes through the route', routedNode.sizes.wide[wideChild.id].w === 240)
check('the base width survives the node write', routedWidth.widths.wide === 300)
check('an unknown base is refused',
  await routes.setWidth(cwd, 'nope', { width: 300 })
    .then(() => false, (error) => /no knowledge base/.test(error.message)))
check('a width out of range is refused',
  await routes.setWidth(cwd, 'wide', { width: 5 })
    .then(() => false, (error) => /between/.test(error.message)))

// --- node heights --------------------------------------------------------------
console.log('\nnode heights')
check('a bare number still means width',
  state.sizeOfNode({}, { wide: { n1: 300 } }, 'wide', 'n1').w === 300)
check('and it has no height of its own',
  state.sizeOfNode({}, { wide: { n1: 300 } }, 'wide', 'n1').h === undefined)
await state.writeNodeBox(cwd, 'wide', 'n1', { w: 260, h: 420 })
const boxed = state.sizeOfNode({}, await state.readSizes(cwd), 'wide', 'n1')
check('a box round-trips both numbers', boxed.w === 260 && boxed.h === 420)
check('the base width still applies to nodes without one',
  state.sizeOfNode(await state.readWidths(cwd), await state.readSizes(cwd), 'wide', 'other').w === 300)
check('height falls back to nothing, not to a guess',
  state.sizeOfNode({}, {}, 'quiet', 'n1').h === undefined)
check('a silly height is refused',
  await state.writeNodeBox(cwd, 'wide', 'n1', { h: 4 })
    .then(() => false, (error) => /height/.test(error.message)))
check('a half-written box keeps its width',
  await state.writeNodeBox(cwd, 'wide', 'n1', { w: 240 })
    .then((sizes) => sizes.wide.n1.w === 240 && sizes.wide.n1.h === 420, () => false))

// --- the outline carries a gist -------------------------------------------------
console.log('\nthe outline carries a gist')
const outlineBase = {
  id: 'demo',
  name: '演示',
  nodes: [
    { id: 'n1', parent: null, title: '根节点', body: '这是根节点的一句话说明，后面还有别的。' },
    { id: 'n2', parent: 'n1', title: '子节点' },
  ],
  links: [],
}
const outlineText = renderOutline([outlineBase], null)
check('the gist appears next to the title',
  outlineText.includes('这是根节点的一句话说明，后面还有别的。'), outlineText.split('\n').slice(2).join(' | '))
check('the title still appears', outlineText.includes('- n1  根节点'))
check('a node with no body still lists', outlineText.includes('- n2  子节点'))
check('and gets no dangling dash', !outlineText.includes('测试 测试'))
check('a long body is cut at a sentence',
  gistOf('第一句话讲清楚这件事。' + '后面还有很多补充说明。'.repeat(40)) === '第一句话讲清楚这件事。')
check('an unpunctuated body is cut at the limit', gistOf('x'.repeat(200)).endsWith('…'))
check('the gist prefers the trigger over the claim',
  gistOf('这是开头的一句话。\n\n什么时候该想起它：在动手之前，问一句还有谁在用它。')
    === '在动手之前，问一句还有谁在用它。',
  JSON.stringify(gistOf('这是开头的一句话。\n\n什么时候该想起它：在动手之前，问一句还有谁在用它。')))
check('a body without a trigger still uses its first sentence',
  gistOf('这是没有触发词的第一句。' + '后面是别的句子。'.repeat(40)) === '这是没有触发词的第一句。')
check('a bold trigger leaves no asterisks',
  gistOf('开头。\n\n**什么时候该想起它：**加粗的触发词，别慌着改。')
    === '加粗的触发词，别慌着改。',
  JSON.stringify(gistOf('开头。\n\n**什么时候该想起它：**加粗的触发词，别慌着改。')))
check('a trailing dash is dropped too',
  gistOf('开头。\n\n什么时候该想起它：说明 -') === '说明',
  JSON.stringify(gistOf('开头。\n\n什么时候该想起它：说明 -')))
// A node with a body but no trigger used to look exactly like one with a trigger: the gist falls back to the
// first sentence. The trigger is what makes a node retrievable in index mode, so an unmarked gap is a base
// that looks healthy and is not. A test session asked for this lint.
const untriggered = renderOutline([{ id: 'b', name: 'lint 探针', nodes: [
  { id: 'n1', parent: null, title: '只有正文', body: '这里没有触发行，所以索引模式下只剩标题能匹配。' },
], links: [] }], null)
check('a body without a trigger is marked', /无触发器/.test(untriggered), untriggered)
check('and a body with one is not', !/无触发器/.test(
  renderOutline([{ id: 'b', name: 'lint 探针', nodes: [
    { id: 'n1', parent: null, title: '有触发行', body: '正文。\n\n什么时候该想起它：需要它的时候。' },
  ], links: [] }], null)))
check('and a node with no body at all is not marked either', !/无触发器/.test(
  renderOutline([{ id: 'b', name: 'lint 探针', nodes: [{ id: 'n1', parent: null, title: '只有标题' }], links: [] }], null)))

// Freshness: the base heading carries its size and newest stamp, so a node written just now can be compared
// against the outline instead of being guessed at — guessing wrong means writing it twice.
const stamped = renderOutline([{ id: 'b', name: '新鲜度', nodes: [
  { id: 'n1', parent: null, title: '一条', body: '正文。', at: '2026-01-02 03:04' },
  { id: 'n2', parent: 'n1', title: '两条', body: '正文。', at: '2026-05-06 07:08' },
], links: [] }], null)
check('the base heading says how many nodes', /2 节点/.test(stamped), stamped.split('\n')[2])
check('and the newest stamp', /最新 2026-05-06 07:08/.test(stamped), stamped.split('\n')[2])

check('an english trigger works too',
  gistOf('Claim first.\n\nWhen to recall: before saying it works.') === 'before saying it works.')
// A body may quote the phrase earlier than its own trigger — o24 did, while describing a verification — and
// a first-match regex then handed that quote back as the node's summary. The protocol puts the trigger last,
// so the last occurrence wins. A wrong summary is worse than none: it still looks like one.
const quoted = '这一段引用了「什么时候该想起它：」这个短语。\n\n正文在这里。\n\n什么时候该想起它：真正的触发器。'
check('a quoted trigger earlier in the body does not become the summary',
  gistOf(quoted) === '真正的触发器。', JSON.stringify(gistOf(quoted)))

// --- timestamps -----------------------------------------------------------------
console.log('\ntimestamps')
// Local, because the store stamps local time. Using toISOString here made these assertions depend on the
// hour they ran at.
const localToday = () => {
  const now = new Date()
  const two = (value) => String(value).padStart(2, '0')
  return now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate())
}
const today = localToday()
await saveBase(pathFor(cwd, 'timed'), newBase('timed', '时间', '测试', ''))
const timedOpened = await loadBase(cwd, 'timed')
const timedRoot = timedOpened.base.nodes[0]
check('a new node carries a timestamp', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(timedRoot.at || ''), String(timedRoot.at))
check('and it is today', String(timedRoot.at).slice(0, 10) === today, String(timedRoot.at))

const timedChild = upsertNode(timedOpened.base, { title: '孩子', body: 'x', parent: timedRoot.id }).node
check('a created node carries one too', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(timedChild.at || ''), String(timedChild.at))

// Written yesterday, then rewritten: the date has to move.
const yesterday = '2000-01-01'
timedChild.at = yesterday
upsertNode(timedOpened.base, { node: timedChild.id, body: '测试' })
check('rewriting a node moves its date forward', timedChild.at !== yesterday, String(timedChild.at))
await saveBase(timedOpened.path, timedOpened.base)
check('the date survives a reload',
  (await loadBase(cwd, 'timed')).base.nodes.find((node) => node.id === timedChild.id).at === timedChild.at)

// A file written before this existed has no dates, and inventing one would be worse than not knowing.
await saveBase(pathFor(cwd, 'legacy'), {
  version: 1, id: 'legacy', name: '旧库',
  nodes: [{ id: 'n1', parent: null, title: '旧的', body: '' }], links: [],
})
check('a node without a date stays without one',
  (await loadBase(cwd, 'legacy')).base.nodes[0].at === undefined)

// The outline: one today line, and dates only where they are recent enough to matter.
const old = '2000-01-01'
const timedOutline = renderOutline([{ id: 'b', name: '测试', nodes: [
  { id: 'n1', parent: null, title: '今天的节点', body: '', at: today + ' 09:30' },
  { id: 'n2', parent: null, title: '很久以前的', body: '', at: old },
  { id: 'n3', parent: null, title: '没有日期的', body: '' },
], links: [] }], null)
// The instruction lives in its own early section so it is read where attention is strongest. It is a
// constant injected verbatim, so asserting on its text is asserting on what the model receives.
const protocolSource = await readFile('D:/DeepSeekHarness/dsh-knowledge-tree/index.js', 'utf8')
check('the protocol names the read tool', /knowledge_read/.test(protocolSource))
check('and the write tool', /knowledge_write_node/.test(protocolSource))
check('and the trigger convention', /什么时候该想起它/.test(protocolSource))
check('and it asks for a look before acting', /先看/.test(protocolSource))
// And the outline states the other half: when not to read. An index that is always pulled is noise.
// The words moved when full injection arrived; the point did not.
check('the outline says when not to read', /比不读更糟/.test(timedOutline))

// --- full injection ------------------------------------------------------------------
// A base the user marked for full injection carries its bodies, so the model does not have to decide to
// fetch them. That is the whole point: the failure this plugin keeps hitting is "never looked", and a body
// already in the prompt cannot be left unlooked-at.
console.log('\nfull injection')
const wholeBase = newBase('whole', '整库注入', '整库注入', '根节点的正文')
upsertNode(wholeBase, { title: '一个子节点', body: '正文写着：什么时候该想起它：整库注入时。', parent: 'n1' })
const asIndex = renderOutline([wholeBase], null, {})
const asFull = renderOutline([wholeBase], null, { whole: 'full' })
// The index carries the trigger line's content — '整库注入时' — not the marker that introduces it, and
// not the body's first line.
check('an index base shows its gists', /整库注入时/.test(asIndex) && !/正文写着/.test(asIndex))
check('a full base carries the bodies', asFull.includes('整库注入时'))
check('and the root body too', asFull.includes('根节点的正文'))
check('and says which kind it is', /全文/.test(asFull))
check('and it is longer than the index', asFull.length > asIndex.length)
check('and an empty mode map behaves as before', asIndex === renderOutline([wholeBase], null))
// Full injection carries the bodies, so the one thing the reader still cannot see is which of them the user
// has not reviewed. Leaving the marker out made the richer mode answer a strictly smaller set of questions
// than the index does — found by a test session, not by any of these assertions.
const markedFull = renderOutline([Object.assign(newBase('marked', '标记', '标记', '正文'), {
  nodes: [{ id: 'n1', parent: null, title: '改过的', body: '正文', change: 'modified' }],
})], null, { marked: 'full' })
check('a full injection still shows the review marker', /\[修改\]/.test(markedFull), markedFull)
check('and the index shows it too', /\[修改\]/.test(renderOutline([Object.assign(newBase('marked', '标记', '标记', '正文'), {
  nodes: [{ id: 'n1', parent: null, title: '改过的', body: '正文', change: 'modified' }],
})], null)))

// Removed nodes stay out of a full injection for the same reason they stay out of the index.
const removedBase = newBase('gone', '测试', '测试', '')
upsertNode(removedBase, { title: '要走', body: '会被删掉的正文', parent: 'n1' })
const goneNode = removedBase.nodes.find((node) => node.title === '要走')
goneNode.change = 'removed'
check('a removed node is not injected in full',
  !renderOutline([removedBase], null, { gone: 'full' }).includes('会被删掉的正文'))

// And the guard: a base past the limit falls back rather than crowding everything else out.
const hugeBase = newBase('huge', '测试', '测试', 'x'.repeat(30000))
const huge = renderOutline([hugeBase], null, { huge: 'full' })
check('an oversized full base falls back to the index', /超过/.test(huge), huge.slice(0, 120))
check('and it does not carry the whole body', huge.length < 30000)
check('the outline says what today is', timedOutline.includes('今天：' + today),
  timedOutline.split('\n').find((line) => line.includes('今天')) || '(no today line)')
// `describeBase` is what the model reads when it asks for bodies, so a stamp there is printed in full —
// it is the place where "when was this written" decides whether the note is still true.
check('a recent node shows when it was written', describeBase({ id: 'b', name: '测试', nodes: [
  { id: 'n1', parent: null, title: '今天的节点', body: '', at: today + ' 09:30' },
], links: [] }).includes(today + ' 09:30'), 'describeBase carries the full stamp')
check('and an old one carries its date too', describeBase({ id: 'b', name: '测试', nodes: [
  { id: 'n1', parent: null, title: '很久以前的', body: '', at: old },
], links: [] }).includes(old), 'an old stamp is still printed here')
// The index is the other way round: it is a map, so only the header carries today's date and the node lines
// stay clean.
check('and the index node lines carry no dates', !/^ {2,}- n\d.*\d{4}-\d{2}-\d{2}/m.test(timedOutline),
  timedOutline)

// The model-facing read is where a date matters most: it is where the bodies are read.
const timedDescribed = describeBase({ id: 'b', name: '测试', nodes: [
  { id: 'n1', parent: null, title: '测试', body: 'x', at: '2026-01-02', change: 'added' },
], links: [] })
check('the read tells the model when it was written', timedDescribed.includes('2026-01-02'), timedDescribed)

// The read tool's whole job is to hand over the bodies, and it used to share a line with the title, which
// forced the body to be flattened and cut at 120 characters. A model read `o4` as far as "所以必须重" and
// then went around the tool to open the JSON — so these two assertions are what was missing.
const longBody = '这一段很长，'.repeat(60)
const longRead = describeBase({ id: 'b', name: '测试', nodes: [
  { id: 'n1', parent: null, title: '测试', body: longBody },
], links: [] })
check('the read hands over the whole body, not a prefix', longRead.includes(longBody),
  'read back ' + longRead.length + ' chars for a ' + longBody.length + '-char body')
const splitRead = describeBase({ id: 'b', name: '测试', nodes: [
  { id: 'n1', parent: null, title: '测试', body: '第一行\n第二行' },
], links: [] })
check('and it keeps the line breaks instead of flattening them', splitRead.includes('第一行\n'),
  JSON.stringify(splitRead))

// --- the activity log -----------------------------------------------------------
console.log('\nthe activity log')
// Nine now: the eight that read and write, plus the one that hands pictures over as images.
check('the wrapper keeps every tool', TOOLS.length === 9, String(TOOLS.length))
  check('and the link can be removed, not only drawn', TOOLS.some((tool) => tool.name === 'knowledge_unlink'))
check('and their names', TOOLS.map((tool) => tool.name).includes('knowledge_read'))
check('and their descriptions',
  typeof TOOLS[0].description === 'string' && TOOLS[0].description.length > 20)
check('and their parameters', Boolean(TOOLS[0].parameters))
check('and they are still callable', typeof TOOLS[0].execute === 'function')

// A read in a workspace with no such base must fail the way the tool always failed, not in a new way:
// the wrapper has to let the tool's own error through untouched.
const logCwd = await mkdtemp(join(tmpdir(), 'kblog-'))
const logExec = { agent: { session: { header: { cwd: logCwd } } } }
const readTool = TOOLS.find((tool) => tool.name === 'knowledge_read')
check('a read of a missing base fails with the tool own message',
  await readTool.execute({ base: 'nope' }, logExec)
    .then(() => 'did not fail', (error) => /no knowledge base/.test(error.message) ? 'ok' : 'other: ' + error.message))
const logBody = await readFile(join(logCwd, '.dsh-knowledge', 'activity.log'), 'utf8')
  .then((body) => body, (error) => '')
check('a log line was written for it',
  logBody.includes('knowledge_read') && logBody.includes('FAILED'),
  logBody ? logBody.trim().slice(0, 90) : 'no log file at all')

// --- reading one node, and the note on a link ----------------------------------------
// Both exist for the same reason: the outline tells a reader that things are connected, and the note plus the
// single-node read are what let it act on that. A link without a note is visible and unusable, and reading a
// node's neighbour used to cost the whole base.
console.log('\nreading one node, and link notes')
const linkCwd = await mkdtemp(join(tmpdir(), 'kblink-'))
await saveBase(pathFor(linkCwd, 'linked'), {
  version: 1, id: 'linked', name: '关联', nodes: [
    { id: 'n1', parent: null, title: '安装流程', body: '正文一。\n\n什么时候该想起它：装插件时。' },
    { id: 'n2', parent: 'n1', title: '故障排查', body: '正文二。\n\n什么时候该想起它：装不上时。' },
    { id: 'n3', parent: null, title: '环境', body: '正文三。' },
  ],
  links: [{ from: 'n1', to: 'n3', note: '换环境就是换解释器' }],
})
const linkExec = { agent: { session: { header: { cwd: linkCwd } } } }
const linkTool = TOOLS.find((tool) => tool.name === 'knowledge_link')
const writeTool = TOOLS.find((tool) => tool.name === 'knowledge_write_node')

const one = await readTool.execute({ base: 'linked', node: 'n1' }, linkExec)
check('reading one node gives its body', one.includes('正文一。'), one.slice(0, 120))
check('and does not include the whole base', !one.includes('正文二。') || one.includes('故障排查'))
check('and names its children as neighbours', /child\s+n2\s+故障排查/.test(one), one)
check('and names its links, with the note',
  /link\s+n3\s+环境[^\n]*—\s*换环境就是换解释器/.test(one), one)
check('and a node that is not there fails loudly',
  await readTool.execute({ base: 'linked', node: 'nope' }, linkExec)
    .then(() => 'did not fail', (error) => /no node "nope"/.test(error.message) ? 'ok' : 'other: ' + error.message))

check('a link with no note is refused',
  await linkTool.execute({ base: 'linked', from: 'n2', to: 'n3' }, linkExec)
    .then(() => 'did not fail', (error) => /needs a note/.test(error.message) ? 'ok' : 'other: ' + error.message))
check('and one that is only whitespace is refused too',
  await linkTool.execute({ base: 'linked', from: 'n2', to: 'n3', note: '   ' }, linkExec)
    .then(() => 'did not fail', (error) => /needs a note/.test(error.message) ? 'ok' : 'other: ' + error.message))

// Every link the model makes goes through that tool; the panel's own drag is a different path, and the user is
// not asked to write a note for a line they drew. So this has to be a rule of the tool, not of the store.
const linkedBase = (await loadBase(linkCwd, 'linked')).base
const linkedOutline = renderOutline([linkedBase], null)
check('the outline carries the note', linkedOutline.includes('换环境就是换解释器'), linkedOutline.slice(-160))
check('and marks a link that has none',
  renderOutline([{ id: 'x', name: 'x', nodes: [
    { id: 'n1', parent: null, title: 'a', body: '正文。' },
    { id: 'n2', parent: null, title: 'b', body: '正文。' },
  ], links: [{ from: 'n1', to: 'n2' }] }], null).includes('无注释'))
check('the write tool still works without one, for the panel side', typeof writeTool.execute === 'function')

// Rewriting a note. A note is a sentence about *when* to follow the link, and those get rewritten as
// understanding improves. It used to be write-once: a second call on the same pair threw `already linked`, and
// since the tool has no unlink, a wrong note could not be corrected at all — the only route left was editing the
// JSON by hand. Two sessions hit that before it was fixed.
//
// Placed after the assertions above on purpose: those read the note written by the fixture, and this rewrites
// it, so running this first would have made them fail for a reason that has nothing to do with what they check.
console.log('\nrewriting a link note')
// Anything that throws is turned into the assertion's own message. A positive case that rejects would otherwise
// take down the whole run — the regression would show up as a stack trace with no FAIL line, which is worse than
// useless when the point of the assertion is to name what broke.
const noteAttempt = (args) => linkTool.execute(args, linkExec)
  .then((text) => text, (error) => 'THREW: ' + ((error && error.message) || error))

const noteUpdated = await noteAttempt({ base: 'linked', from: 'n1', to: 'n3', note: '改过的措辞' })
check('a second call on the same pair updates the note instead of refusing',
  /Updated the note/.test(noteUpdated), noteUpdated)
const rewritten = (await loadBase(linkCwd, 'linked')).base.links.find((entry) => entry.from === 'n1')
check('and the file carries the new wording', rewritten.note === '改过的措辞', JSON.stringify(rewritten))
check('and the pair was not duplicated', (await loadBase(linkCwd, 'linked')).base.links.length === 1)
const noteReversed = await noteAttempt({ base: 'linked', from: 'n3', to: 'n1', note: '第三次' })
check('the reverse direction is the same pair', /Updated the note/.test(noteReversed), noteReversed)
check('the outline shows the rewording, not the old sentence',
  renderOutline([(await loadBase(linkCwd, 'linked')).base], null).includes('第三次'))
const noteAgain = await noteAttempt({ base: 'linked', from: 'n1', to: 'n3', note: '第三次' })
check('saying the same thing again says so instead of writing',
  /already carries exactly that note/.test(noteAgain), noteAgain)
check('and an update still refuses an empty note',
  await linkTool.execute({ base: 'linked', from: 'n1', to: 'n3', note: ' ' }, linkExec)
    .then(() => 'did not fail', (error) => /needs a note/.test(error.message) ? 'ok' : 'other: ' + error.message))

// --- per-session selection -------------------------------------------------------
console.log('\nper-session selection')
const selCwd = await mkdtemp(join(tmpdir(), 'kbsel-'))
for (const id of ['one', 'two']) await saveBase(pathFor(selCwd, id), newBase(id, id, '测试', ''))

// No workspace file and no session file: everything, which is what it has always meant.
check('no file anywhere means every base',
  (await state.readSelection(selCwd)) === null)
check('and a session with no file inherits that', (await state.readSessionSelection(selCwd, 's1')) === null)

await state.writeSelection(selCwd, new Set(['one']))
check('the workspace default is stored', [...(await state.readSelection(selCwd))].join() === 'one')
check('a session still inherits it', [...(await state.readSelection(selCwd, 's1'))].join() === 'one')

await state.writeSelection(selCwd, new Set(['two']), 's1')
check('a session can differ', [...(await state.readSelection(selCwd, 's1'))].join() === 'two')
check('another session still sees the default', [...(await state.readSelection(selCwd, 's2'))].join() === 'one')
check('and the workspace default is untouched', [...(await state.readSelection(selCwd))].join() === 'one')

// An empty list is a decision, not the absence of one: "this session reads nothing".
await state.writeSelection(selCwd, new Set(), 's3')
check('an empty session list is honoured, not treated as missing',
  [...(await state.readSelection(selCwd, 's3'))].length === 0)

check('a session file is not a base',
  !(await listBases(selCwd)).some((base) => base.id === 's1' || base.id === '.sessions'))
// The rule changed from "refuse anything unusual" to "encode it", because refusing meant an IM session 测试// whose id is `im:qq_测试dm:测试 测试could not have its own selection at all. The property that mattered is
// unchanged: whatever the id, the file lands inside .sessions/.
// The property is that the id becomes one path segment, not that it looks innocent. `..` survives as two
// literal characters 测试'they are legal in a file name 测试'while the slash that would make it a traversal is
// encoded, so the result is a single file inside .sessions/.
const escapePath = state.sessionSelectionPath(selCwd, '../evil')
const escapeName = escapePath.split(/[\\/]/).pop()
check('an id that could escape becomes one file name, not a path',
  escapeName === '..%2Fevil.json' && escapePath.split(/[\\/]/).includes('.sessions'),
  escapePath)
const colonPath = state.sessionSelectionPath(selCwd, 'im:qq_a:dm:1:ABC')
check('and an IM id now has a file of its own',
  colonPath.endsWith('.json') && !colonPath.includes('im:qq'), colonPath)
check('and it round-trips',
  await state.writeSelection(selCwd, new Set(['two']), 'im:qq_a:dm:1:ABC').then(() => true, () => false)
  && [...(await state.readSessionSelection(selCwd, 'im:qq_a:dm:1:ABC'))].join() === 'two')

// The outline is built per session, so the cache key has to include it.
await state.writeSelection(selCwd, new Set(['two']), 'keep')
const basesRaw = await listBases(selCwd)
const viaDefault = renderOutline(basesRaw, await state.readSelection(selCwd))
const viaSession = renderOutline(basesRaw, await state.readSelection(selCwd, 'keep'))
check('two sessions can build different outlines', viaDefault !== viaSession, viaDefault + ' vs ' + viaSession)

// The warmer and the provider must agree on the key, or the first assembly of a session is empty. This is
// the contract between them, written down where a change to one side will break it loudly.
const cacheCwd = await mkdtemp(join(tmpdir(), 'kbcache-'))
await saveBase(pathFor(cacheCwd, 'one'), newBase('one', '涓€', '测试', '姝ｆ枃'))
await refresh(cacheCwd, 'sess-a')
check('a build for a session is visible to that session',
  outlineFor(cacheCwd, 'sess-a').length > 0, String(outlineFor(cacheCwd, 'sess-a').length))
check('and not to another session', outlineFor(cacheCwd, 'sess-b') === '',
  String(outlineFor(cacheCwd, 'sess-b').length))
check('nor to the workspace without one', outlineFor(cacheCwd) === '')

// --- where a selection is written -------------------------------------------------
console.log('\nwhere a selection is written')
const scopeCwd = await mkdtemp(join(tmpdir(), 'kbscope-'))
for (const id of ['one', 'two']) await saveBase(pathFor(scopeCwd, id), newBase(id, id, '测试', ''))
await state.writeSelection(scopeCwd, new Set(['one']))

const scopeRoutes = await import('./lib/routes.js')
check('a session id writes that session',
  [...(await scopeRoutes.setSelection(scopeCwd, ['two'], 's9')).enabled].join() === 'two'
  && [...(await state.readSelection(scopeCwd, 's9'))].join() === 'two',
  JSON.stringify([...await state.readSelection(scopeCwd, 's9')]))
check('and leaves the workspace default alone',
  [...(await state.readSelection(scopeCwd))].join() === 'one')
check('the workspace scope ignores the session id',
  [...(await scopeRoutes.setSelection(scopeCwd, ['one', 'two'], 's9', 'workspace')).enabled].join() === 'one,two'
  && [...(await state.readSelection(scopeCwd))].join() === 'one,two')
check('and does not disturb that session',
  [...(await state.readSelection(scopeCwd, 's9'))].join() === 'two')
check('an unknown base is still refused',
  await scopeRoutes.setSelection(scopeCwd, ['nope'], 's9').then(() => false, (error) => /no knowledge base/.test(error.message)))

// --- the workspace list -----------------------------------------------------------
console.log('\nthe workspace list')
const wsCwd = await mkdtemp(join(tmpdir(), 'kbws-'))
await saveBase(pathFor(wsCwd, 'one'), newBase('one', '涓€', '测试', ''))
await saveBase(pathFor(wsCwd, 'two'), newBase('two', '测试', '测试', ''))
await state.writeSelection(wsCwd, new Set(['one']))

const fakeCtx = (ids) => ({
  sessions: {
    get: (id) => (ids[id] ? { header: { id, cwd: ids[id] } } : undefined),
    list: () => Object.keys(ids),
  },
})
const routeModule = await import('./lib/routes.js')

check('every session is listed once per workspace',
  (await routeModule.listWorkspaces(fakeCtx({ a: wsCwd, b: wsCwd, c: 'D:/other' }), 'a', null)).length === 2)
const listed = await routeModule.listWorkspaces(fakeCtx({ a: wsCwd }), 'a', null)
const mine = listed.find((entry) => entry.cwd === wsCwd)
check('a workspace carries its bases', mine && mine.bases.length === 2, JSON.stringify(mine && mine.bases))
check('and which are on', mine && mine.enabled.join() === 'one', JSON.stringify(mine && mine.enabled))
check('a workspace is named, not pathed, for the browser',
  mine && typeof mine.sessionId === 'string' && mine.sessionId.length > 0)
check('the name is the last path segment', mine && mine.name === wsCwd.split(/[\\/]/).pop(), mine && mine.name)

// A service that cannot enumerate still answers with the session that asked.
const blind = { sessions: { get: (id) => (id === 'a' ? { header: { id: 'a', cwd: wsCwd } } : undefined) } }
check('without an enumerator, the asking session is still listed',
  (await routeModule.listWorkspaces(blind, 'a', null)).length === 1)

// A service whose list() throws must not take the route down.
const angry = {
  sessions: {
    get: (id) => (id === 'a' ? { header: { id: 'a', cwd: wsCwd } } : undefined),
    list: () => { throw new Error('nope') },
  },
}
check('a throwing enumerator falls back rather than failing',
  (await routeModule.listWorkspaces(angry, 'a', null)).length === 1)
// The settings page's list also comes from the session store on disk, because the sessions enumeration only answers for
// what the process is holding. Reconstructing a path from a store directory name is the fiddly half: both `\\` and a
// literal `-` become `-`, so the two readings are tried and the filesystem decides. Injected here, so the case is exact
// rather than borrowed from this machine's temp paths.
// Every intermediate directory has to be in the set: the resolver prunes a branch whose parent is missing.
const fakeDirs = new Set(['D:\\', 'D:\\work', 'D:\\anime-scene-builder', 'D:\\my-project', 'D:\\my-project\\deep-name'])
const fakeExists = (path) => fakeDirs.has(path)
check('a slug with no dashes in its names resolves',
  workspacesModule.resolveSlug('--D-work--', fakeExists) === 'D:\\work',
  workspacesModule.resolveSlug('--D-work--', fakeExists))
check('and one whose directory names contain dashes still resolves',
  workspacesModule.resolveSlug('--D-anime-scene-builder--', fakeExists) === 'D:\\anime-scene-builder',
  workspacesModule.resolveSlug('--D-anime-scene-builder--', fakeExists))
check('and a nested path with a dash in both parts resolves',
  workspacesModule.resolveSlug('--D-my-project-deep-name--', fakeExists) === 'D:\\my-project\\deep-name',
  workspacesModule.resolveSlug('--D-my-project-deep-name--', fakeExists))
check('a slug naming nothing real is refused',
  workspacesModule.resolveSlug('--Z-nope-nothing-here--', fakeExists) === null)

// A workspace with no selection file means every base, which is null rather than an empty list.
const bare = await mkdtemp(join(tmpdir(), 'kbws2-'))
await saveBase(pathFor(bare, 'solo'), newBase('solo', '测试', '测试', ''))
const bareListed = await routeModule.listWorkspaces(fakeCtx({ z: bare }), 'z', null)
check('no selection file means null, not empty', bareListed[0].enabled === null, JSON.stringify(bareListed[0].enabled))

// --- the sprite route -----------------------------------------------------------------
// Not clickable, so not verifiable by eye: a broken image and a missing route look identical in a screenshot. This
// drives the handler with a fake response and looks at the bytes.
let spriteStatus = 0
let spriteHeaders = {}
let spriteBytes = null
const fakeRes = {
  writeHead(code, headers) { spriteStatus = code; spriteHeaders = headers || {} },
  end(body) { spriteBytes = body },
  setHeader() {},
  write() {},
}
await routes.createHandler({ sessions: {} })(
  { method: 'GET', url: (routes.PREFIX || '/dsh-knowledge-tree') + '/whale.png' },
  fakeRes,
)
check('the sprite route answers 200 with image/png',
  spriteStatus === 200 && (spriteHeaders['content-type'] || '').startsWith('image/png'),
  spriteStatus + ' ' + JSON.stringify(spriteHeaders))
check('and the body really is a PNG',
  Boolean(spriteBytes) && spriteBytes.length > 1000
    && spriteBytes[0] === 0x89 && spriteBytes[1] === 0x50 && spriteBytes[2] === 0x4e && spriteBytes[3] === 0x47,
  spriteBytes ? spriteBytes.length + ' bytes' : 'no body')

// --- the route handler ------------------------------------------------------------
// The wiring, not the functions: a branch can be written correctly and placed where it never runs, which is
// exactly what happened to /workspaces and what direct tests of its function could not see.
console.log('\nthe route handler')
const handlerCwd = await mkdtemp(join(tmpdir(), 'kbhttp-'))
await saveBase(pathFor(handlerCwd, 'solo'), newBase('solo', '测试', '测试', ''))
const handlerCtx = {
  sessions: { get: (id) => (id === 'me' ? { header: { id: 'me', cwd: handlerCwd } } : undefined) },
}
const handle = routeModule.createHandler(handlerCtx)

/** A request stand-in: the handler only reads method, url, headers and the body stream. */
function fakeRequest(method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url: path,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    on(event, listener) {
      if (event === 'data') for (const chunk of chunks) listener(chunk)
      if (event === 'end') listener()
      if (event === 'error') return this
      return this
    },
  }
}

function fakeResponse() {
  const held = { status: 0, body: '' }
  return {
    held,
    writeHead(status) { held.status = status; return this },
    setHeader() { return this },
    end(chunk) { if (chunk) held.body += String(chunk); return this },
  }
}

async function call(method, path, body) {
  const res = fakeResponse()
  await handle(fakeRequest(method, path, body), res)
  let parsed = null
  try {
    parsed = JSON.parse(res.held.body)
  } catch {
    parsed = null
  }
  return { status: res.held.status, payload: parsed }
}

// A write may name its workspace, but only one this process knows. The refusal is asserted here; the acceptance is checked
// against the running app, because it needs a workspace that actually exists in DSH_HOME or in a resident session.
const strangeWorkspace = await call('PUT', '/dsh-knowledge-tree/selection', {
  session: 'no-such-session',
  workspace: 'C:/definitely/not/a/known/workspace',
  scope: 'workspace',
  enabled: ['solo'],
  live: true,
})
check('a write naming an unknown workspace is refused',
  strangeWorkspace.status !== 200 && /unknown workspace/.test(String(strangeWorkspace.payload && strangeWorkspace.payload.error)),
  JSON.stringify(strangeWorkspace).slice(0, 140))

// /asset serves a picture by workspace. An unknown workspace is refused. The path whitelist needs a known workspace to
// exercise, so it is checked against the running app rather than here.
const assetStrange = await call('GET', '/dsh-knowledge-tree/asset?workspace=C:/not/a/workspace&path=assets/0123456789abcdef.png')
check('the asset route refuses an unknown workspace', assetStrange.status !== 200, JSON.stringify(assetStrange).slice(0, 120))

// The Office reader returns nothing rather than throwing when the bytes are not a zip. Extraction itself was checked by hand
// against files written by python-docx and openpyxl, which this suite cannot build.
check('the office reader declines bytes that are not a zip',
  officeText('x.docx', Buffer.from('not a zip at all')) === null
  && officeText('x.txt', Buffer.from('plain')) === null,
  'officeText should return null for a non-zip and for a format it does not know')

const wsAnswer = await call('GET', '/dsh-knowledge-tree/workspaces?session=me')
check('GET /workspaces is routed', wsAnswer.status === 200, JSON.stringify(wsAnswer).slice(0, 120))
check('and answers with a list', Array.isArray(wsAnswer.payload && wsAnswer.payload.workspaces),
  JSON.stringify(wsAnswer.payload).slice(0, 120))
check('the state route still works',
  (await call('GET', '/dsh-knowledge-tree/state?session=me')).status === 200)
check('a GET to an unknown action is a method problem, not a missing route',
  (await call('GET', '/dsh-knowledge-tree/nope?session=me')).status === 405)
check('a path outside the prefix is the one that is not found',
  (await call('GET', '/elsewhere?session=me')).status === 404)
check('a GET to an action is still refused',
  (await call('GET', '/dsh-knowledge-tree/selection?session=me')).status === 405)
// The client must always name a session: without one the host cannot know which workspace is meant, and
// the refusal has to be an error rather than a guess.
check('a write with no session is refused',
  (await call('PUT', '/dsh-knowledge-tree/selection', { enabled: ['solo'] })).status >= 400)
check('a write naming a session is accepted',
  (await call('PUT', '/dsh-knowledge-tree/selection', { session: 'me', enabled: ['solo'] })).status === 200)
check('a PUT without a JSON content type is refused',
  (await call('PUT', '/dsh-knowledge-tree/selection')).status === 415)
const wrote = await call('PUT', '/dsh-knowledge-tree/selection',
  { session: 'me', scope: 'workspace', enabled: ['solo'] })
check('a workspace-scoped write is routed', wrote.status === 200 && wrote.payload.ok === true,
  JSON.stringify(wrote).slice(0, 120))
check('and it lands in the workspace default',
  [...(await state.readSelection(handlerCwd))].join() === 'solo')

// --- the first-time seed ----------------------------------------------------------
console.log('\nthe first-time seed')
const fresh = await mkdtemp(join(tmpdir(), 'kbseed-'))
const seeded = await seed.seedIfFirstTime(fresh)
check('a workspace never used gets a base', seeded === seed.SEED_BASE_ID, String(seeded))
const seededBases = await listBases(fresh)
check('and it is on disk', seededBases.length === 1 && seededBases[0].id === seed.SEED_BASE_ID,
  seededBases.map((base) => base.id).join())
check('every seed node is there',
  seededBases[0].nodes.length === seed.SEED_NODE_IDS.length, String(seededBases[0].nodes.length))
check('with a parent structure, not a flat list',
  seededBases[0].nodes.some((node) => node.parent !== null))
check('and at least one link', (seededBases[0].links || []).length > 0)
check('it is enabled, so the model reads it',
  [...(await state.readSelection(fresh))].join() === seed.SEED_BASE_ID,
  JSON.stringify([...(await state.readSelection(fresh))]))
check('every node carries a stamp',
  seededBases[0].nodes.every((node) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(node.at || '')))
check('a second call does nothing', (await seed.seedIfFirstTime(fresh)) === null)
check('and nothing is duplicated', (await listBases(fresh)).length === 1)

// The seed teaches by example — it is the one base whose whole purpose is to show how a node should be
// written. So the convention it teaches has to hold inside it, and nothing else was checking that: a seed
// whose nodes lost their trigger lines would be demonstrating the opposite of what the outline expects.
//
// Asserted through the outline renderer rather than by matching the text here, because the outline is what
// the model actually receives, and its `（无触发器）` mark is the thing a reader would see.
const seededOutline = renderOutline(seededBases, null)
check('no seed node is missing its trigger line',
  !seededOutline.includes('无触发器'),
  seededOutline.split('\n').filter((line) => line.includes('无触发器')).join(' | ') || 'none')
check('and every seed link carries a note',
  seededBases[0].links.every((link) => typeof link.note === 'string' && link.note.trim().length > 0),
  JSON.stringify(seededBases[0].links))

// The tutorial's text is replaced wholesale when the plugin updates, and nothing else in its outline heading
// moves: the node count stays, and the stamps are preserved on purpose so the user's colours and positions keep
// applying. So without a version in the heading, a session that read the tutorial earlier in the conversation
// has no way to learn that the text underneath it changed. That is not hypothetical — a session concluded
// "no change" from an identical heading, and only found out because the user said so.
check('the outline names the tutorial and its version',
  seededOutline.includes('内置教程 v' + seed.SEED_VERSION), seededOutline.slice(0, 220))
check('and tells the reader not to trust its memory of it', seededOutline.includes('别凭印象'))

// A trigger must fit on one line, because `triggerOf` reads to the end of the line and nothing further. A trigger
// wrapped onto a second line therefore reaches the outline as a sentence cut in half — "……是什么的 id；" with the
// rest gone — and the source looks perfectly fine while it happens. This is not hypothetical: the tutorial's own
// "找到某个节点" node did it, and it was found by reading the outline, not the file.
for (const node of seededBases[0].nodes) {
  const lines = String(node.body || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const last = lines[lines.length - 1] || ''
  const found = outline.triggerOf(node.body)
  check('node ' + node.id + ' has a trigger', found.found, JSON.stringify(found))
  check('and it is the last line, unwrapped',
    /^[*\s]*什么时候该想起它/.test(last), last.slice(0, 60))
  // What a wrapped trigger *looks* like after extraction: a sentence stopped at its first line, so it ends on a
  // joining mark rather than a full stop. This is the shape of the failure, checked at the layer the reader sees.
  // The check above catches wrapping by looking at the source; this one catches it — and any other way of losing
  // the tail — by looking at the extracted text.
  check('and the extracted trigger is a finished sentence',
    found.found && !/[；，、：,;:]$/.test(found.text), JSON.stringify(found.text))
}
check('a base that is not the tutorial carries no such line',
  !renderOutline([{ id: 'mine', name: '我的库', nodes: [{ id: 'n1', title: 'a', body: '正文。' }], links: [] }],
    null).includes('内置教程'))
check('and the version is a fact in the file, not a rendering detail',
  seededBases[0].seed && Number.isInteger(seededBases[0].seed.version)
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(seededBases[0].seed.at || ''),
  JSON.stringify(seededBases[0].seed))

// --- upgrading an existing tutorial ---------------------------------------------------
// The seed creates once, but a tutorial that never changes is worse than none: ship a feature and every
// workspace that already ran the plugin keeps a description of what it did not have — and the outline is what
// the model reads, so the model keeps believing it. The upgrade is the other half.
//
// Five branches, and four of them do nothing, which is the hard part to test: doing nothing is what a broken
// upgrade looks like too.
console.log('\nupgrading an existing tutorial')
check('a fresh seed records its version and each body digest',
  seededBases[0].seed && seededBases[0].seed.version === seed.SEED_VERSION
    && seededBases[0].nodes.every((node) => typeof node.seedSum === 'string' && node.seedSum.length === 12),
  JSON.stringify(seededBases[0].seed))

check('a current base is left alone', (await seed.upgradeTutorial(fresh)) === null)

const upCwd = await mkdtemp(join(tmpdir(), 'kbup-'))
const upDir = join(upCwd, '.dsh-knowledge')
await mkdir(upDir, { recursive: true })
// A base from before digests existed: no `seed`, no `seedSum`. n1 looks untouched (seeding writes no history
// entry, and an edit does), n3 carries two entries — someone has been here.
const oldNodes = [
  { id: 'n1', parent: null, title: '这个知识库是什么', body: '旧正文一', at: '2020-01-01 00:00' },
  {
    id: 'n3', parent: 'n1', title: '怎么改它', body: '我改过的正文', at: '2020-01-02 00:00',
    history: [{ at: '2020-01-02 00:00' }, { at: '2020-01-03 00:00' }],
  },
]
await writeFile(join(upDir, 'welcome.json'), JSON.stringify({
  version: 1, id: 'welcome', name: '怎么用这个知识库', nodes: oldNodes, links: [],
}, null, 2))

const upResult = await seed.upgradeTutorial(upCwd)
check('an old base is upgraded', upResult !== null && upResult.to === seed.SEED_VERSION, JSON.stringify(upResult))
const upgraded = JSON.parse(await readFile(join(upDir, 'welcome.json'), 'utf8'))
const upById = new Map(upgraded.nodes.map((node) => [node.id, node]))
check('an untouched node gets the current text',
  upById.get('n1').body !== '旧正文一' && upById.get('n1').body.length > 20,
  upById.get('n1').body.slice(0, 40))
check('an edited node is left exactly as it was',
  upById.get('n3').body === '我改过的正文', upById.get('n3').body)
check('and its own history is untouched', upById.get('n3').history.length === 2)
check('timestamps are preserved, not rewritten',
  upById.get('n1').at === '2020-01-01 00:00' && upById.get('n3').at === '2020-01-02 00:00')
check('node ids are preserved, so layout.json still lines up',
  [...upById.keys()].sort().join() === 'n1,n3', [...upById.keys()].join())
check('and the base records the new version', upgraded.seed.version === seed.SEED_VERSION)
check('running it again does nothing', (await seed.upgradeTutorial(upCwd)) === null)

// The rule that must survive the upgrade: a deleted base stays deleted.
const goneCwd = await mkdtemp(join(tmpdir(), 'kbgone-'))
await mkdir(join(goneCwd, '.dsh-knowledge'), { recursive: true })
check('a workspace with no tutorial gets none back', (await seed.upgradeTutorial(goneCwd)) === null)
check('and nothing was created', (await listBases(goneCwd)).length === 0)
check('a workspace with no directory at all is creation\u2019s job, not the upgrade\u2019s',
  (await seed.upgradeTutorial(await mkdtemp(join(tmpdir(), 'kbnone-')))) === null)

// A version that adds a chapter has to reach existing workspaces, or "the tutorial updates with the plugin" is
// only true for its wording. Structure is added only when nothing in the tutorial has been edited — putting our
// chapters next to somebody's edits and calling it a tutorial would be wrong, and a node whose parent they
// deleted would arrive orphaned.
console.log('\nadding chapters to an existing tutorial')
const growCwd = await mkdtemp(join(tmpdir(), 'kbgrow-'))
await seed.seedIfFirstTime(growCwd)
const growPath = join(growCwd, '.dsh-knowledge', 'welcome.json')
const grown = JSON.parse(await readFile(growPath, 'utf8'))
// Pretend this base predates the newest nodes. Named explicitly rather than sliced: array order is display
// order in the outline (n7/n8/n9 sit between n3 and n4 there), so a slice would keep the wrong six.
const OLD_IDS = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']
const NEW_IDS = seed.SEED_NODE_IDS.filter((id) => !OLD_IDS.includes(id))
const keepIds = new Set(OLD_IDS)
grown.nodes = grown.nodes.filter((node) => keepIds.has(node.id))
grown.links = []
grown.seed = { version: 0 }
await writeFile(growPath, JSON.stringify(grown, null, 2))

const grew = await seed.upgradeTutorial(growCwd)
check('an untouched tutorial gains the chapters it is missing',
  grew !== null && grew.added.length === NEW_IDS.length, JSON.stringify(grew))
const grewBase = JSON.parse(await readFile(growPath, 'utf8'))
check('and every seed id is present afterwards',
  seed.SEED_NODE_IDS.every((id) => grewBase.nodes.some((node) => node.id === id)),
  grewBase.nodes.map((node) => node.id).join())
check('and each added node knows its parent',
  grewBase.nodes.every((node) => node.parent === null || grewBase.nodes.some((other) => other.id === node.parent)),
  grewBase.nodes.map((node) => node.id + '←' + node.parent).join(' '))
check('and the pair that comes with them is linked',
  grewBase.links.some((link) => link.from === 'n4' && link.to === 'n5'), JSON.stringify(grewBase.links))
check('and the added ones carry a digest, so a later run knows they are ours',
  grewBase.nodes.every((node) => typeof node.seedSum === 'string'))

const shrinkCwd = await mkdtemp(join(tmpdir(), 'kbshrink-'))
await seed.seedIfFirstTime(shrinkCwd)
const shrinkPath = join(shrinkCwd, '.dsh-knowledge', 'welcome.json')
const shrunk = JSON.parse(await readFile(shrinkPath, 'utf8'))
shrunk.nodes = shrunk.nodes.filter((node) => node.id === 'n1' || node.id === 'n6')
// Somebody has edited n6: its digest no longer matches, so the base is not wholly ours.
shrunk.nodes.find((node) => node.id === 'n6').body += '\n\n我自己加的一段。'
shrunk.seed = { version: 0 }
await writeFile(shrinkPath, JSON.stringify(shrunk, null, 2))
const shrank = await seed.upgradeTutorial(shrinkCwd)
const shrankBase = JSON.parse(await readFile(shrinkPath, 'utf8'))
check('a tutorial somebody edited gains no chapters',
  shrank !== null && shrank.added.length === 0, JSON.stringify(shrank))
check('and the edited node keeps what was added to it',
  shrankBase.nodes.find((node) => node.id === 'n6').body.includes('我自己加的一段。'),
  shrankBase.nodes.find((node) => node.id === 'n6').body.slice(-40))

// The rule that matters: a workspace where the user deleted the bases must not get them back.
await rm(join(fresh, '.dsh-knowledge'), { recursive: true, force: true })
await mkdir(join(fresh, '.dsh-knowledge'), { recursive: true })
check('an empty directory is not a first time', (await seed.seedIfFirstTime(fresh)) === null)
check('and nothing reappears', (await listBases(fresh)).length === 0)

// --- who wrote a node --------------------------------------------------------------
console.log('\nwho wrote a node')
await saveBase(pathFor(cwd, 'byline'), newBase('byline', '缃插悕', '测试', ''))
const attributionBase = (await loadBase(cwd, 'byline')).base
const bylineNode = upsertNode(attributionBase, { title: '妯″瀷鍐欑殑', by: 'session-one' }).node
check('a write can name its session', bylineNode.by === 'session-one', String(bylineNode.by))
check('and it survives another session reading the file',
  (await (async () => { await saveBase(pathFor(cwd, 'byline'), attributionBase); return loadBase(cwd, 'byline') })())
    .base.nodes.find((node) => node.id === bylineNode.id).by === 'session-one')

// The three states.
upsertNode(attributionBase, { node: bylineNode.id, body: '鏀逛簡', by: 'session-two' })
check('another session takes over the byline', bylineNode.by === 'session-two', String(bylineNode.by))
upsertNode(attributionBase, { node: bylineNode.id, body: '测试' })
check('a write that says nothing about authorship leaves it alone', bylineNode.by === 'session-two', String(bylineNode.by))
upsertNode(attributionBase, { node: bylineNode.id, body: '鐢ㄦ埛鏀圭殑', by: null })
check('and null means the user, which clears it', bylineNode.by === undefined, String(bylineNode.by))

// A node written before this existed has no byline, and inventing one is the same mistake as inventing a
// date.
check('an old node stays without one',
  (await loadBase(cwd, 'timed')).base.nodes[0].by === undefined)

// --- the session lookup -------------------------------------------------------------
console.log('\nthe session lookup')
const sessionShape = { header: { id: 'session-abc-123', cwd: 'D:/x' } }
check('an agent is read directly',
  sessionIdOf({ session: sessionShape }) === 'session-abc-123')
check('and an exec is unwrapped',
  sessionIdOf({ agent: { session: sessionShape } }) === 'session-abc-123',
  sessionIdOf({ agent: { session: sessionShape } }))
check('a shape with no id answers empty, not a guess',
  sessionIdOf({ session: { header: { cwd: 'D:/x' } } }) === '')
check('and nonsense answers empty too', sessionIdOf(null) === '' && sessionIdOf('nope') === '')

// --- a switched-off base -----------------------------------------------------------
// The switch used to mean "keep it out of the prompt" and nothing else, so a model could write into a base
// it could not see: blind writing, with no idea what was already there or what shape its notes take.
console.log('\na switched-off base')
const gateCwd = await mkdtemp(join(tmpdir(), 'kbgate-'))
await saveBase(pathFor(gateCwd, 'open'), newBase('open', '寮€', '测试', ''))
await saveBase(pathFor(gateCwd, 'shut'), newBase('shut', '测试', '测试', ''))
await state.writeSelection(gateCwd, new Set(['open']))

const gateExec = { agent: { session: { header: { cwd: gateCwd } } } }
const tool = (name) => TOOLS.find((entry) => entry.name === name)
const attempt = (name, args) => tool(name).execute(args, gateExec).then(() => null, (error) => error.message)

check('an enabled base can be read',
  (await attempt('knowledge_read', { base: 'open' })) === null)
const refusedRead = await attempt('knowledge_read', { base: 'shut' })
check('a switched-off base cannot be read', typeof refusedRead === 'string', String(refusedRead))
check('and the refusal says it is switched off',
  /switched off/.test(refusedRead || ''), String(refusedRead))
check('and the refusal says how to fix it',
  /switch it on/.test(refusedRead || ''), String(refusedRead))

check('an enabled base can be written to',
  (await attempt('knowledge_write_node', { base: 'open', title: '测试', body: 'x' })) === null)
const refusedWrite = await attempt('knowledge_write_node', { base: 'shut', title: '测试', body: 'x' })
check('a switched-off base cannot be written to', typeof refusedWrite === 'string', String(refusedWrite))
check('and nothing was written to it',
  (await loadBase(gateCwd, 'shut')).base.nodes.length === 1,
  String((await loadBase(gateCwd, 'shut')).base.nodes.length))

check('linking into a switched-off base is refused',
  typeof (await attempt('knowledge_link', { base: 'shut', from: 'n1', to: 'n1' })) === 'string')
check('removing a node in a switched-off base is refused',
  typeof (await attempt('knowledge_remove_node', { base: 'shut', node: 'n1' })) === 'string')

// The switch itself must never be gated, or a base could never be turned back on.
check('the switch still works on a switched-off base',
  (await attempt('knowledge_select', { base: 'shut', enabled: true })) === null)
check('and it is on now',
  [...(await state.readSelection(gateCwd))].includes('shut'))
check('so it can be read',
  (await attempt('knowledge_read', { base: 'shut' })) === null)

// A new base is not in any list yet, so creating one is never gated.
check('creating a base is not gated',
  (await attempt('knowledge_create_base', { id: 'fresh', name: '测试', title: '测试' })) === null)

// --- the edit history ---------------------------------------------------------------
// The node keeps only the latest author and time; the history answers "who changed this, when, **and what it
// said before**". Held in the node so it lands in the same write, and capped so a base does not become a log.
//
// Each entry describes the version it replaced — its content, its author and its own timestamp — so the node
// plus its history is the whole timeline. Entries used to carry only `{ at, by }`, which made "what did it say
// before" unanswerable rather than merely unshown: the previous body was never written anywhere.
console.log('\nthe edit history')
await saveBase(pathFor(cwd, 'hist'), newBase('hist', '测试', '测试', ''))
const histBase = (await loadBase(cwd, 'hist')).base
const histNode = upsertNode(histBase, { title: '第一版标题', body: '第一版正文', by: 'session-one' }).node
check('a created node starts its history', histNode.history.length === 1, JSON.stringify(histNode.history))
check('and the first entry carries the session', histNode.history[0].by === 'session-one')

upsertNode(histBase, { node: histNode.id, body: '第二版正文', by: 'session-two' })
check('every write appends', histNode.history.length === 2, String(histNode.history.length))
// The entry added by that write describes the version it replaced: what it said, and who wrote it.
check('an entry carries the body it replaced',
  histNode.history[1].body === '第一版正文', JSON.stringify(histNode.history[1].body))
check('and the title it replaced',
  histNode.history[1].title === '第一版标题', JSON.stringify(histNode.history[1].title))
check('and the author of that version, not of this write',
  histNode.history[1].by === 'session-one', JSON.stringify(histNode.history[1].by))
// The node itself is the current version.
check('and the node holds the new one', histNode.body === '第二版正文')

// A write with no session. It does **not** clear the author — that is deliberate, and the reason is in the
// store: `undefined` means "this write is not about authorship", which is what a review passes, and a review
// must not erase the name of whoever wrote the text being reviewed. So the version a session-less write
// produces inherits the previous author, and this asserts that rather than hoping otherwise.
upsertNode(histBase, { node: histNode.id, body: '第三版正文' })
upsertNode(histBase, { node: histNode.id, body: '第四版正文' })
check('a fourth write appends', histNode.history.length === 4, String(histNode.history.length))
check('a session-less version inherits the previous author',
  histNode.history[3].by === 'session-two', JSON.stringify(histNode.history[3].by))
check('and its content is still kept, which is the new part',
  histNode.history[3].body === '第三版正文', JSON.stringify(histNode.history[3].body))
check('and the version before it kept its own author',
  histNode.history[2].by === 'session-two', JSON.stringify(histNode.history[2].by))
check('each entry has a time', histNode.history.every((entry) => typeof entry.at === 'string'))
// The timestamp belongs to the version, not to the write that replaced it — otherwise every entry would carry
// the date of the change after it, and the list would read as a list of edits rather than of versions.
check('and the time describes that version',
  histNode.history[0].at <= histNode.history[1].at, JSON.stringify([histNode.history[0].at, histNode.history[1].at]))

for (let at = 0; at < 20; at += 1) upsertNode(histBase, { node: histNode.id, body: '测试' + at + '测试' })
check('the cap holds', histNode.history.length === 10, String(histNode.history.length))
check('and the newest is kept, not the oldest',
  histNode.history[9].at >= histNode.history[0].at)

// A base written before entries carried content must not break anything: the panel has to read those as "no
// version recorded" rather than as an empty one.
const legacyEntry = { at: '2026-01-01 00:00', by: 'session-old' }
check('an entry with no content is still an entry',
  typeof legacyEntry.at === 'string' && legacyEntry.body === undefined)

// The two things that must never see it.
const histDescribed = describeBase(histBase)
check('the model-facing read carries no history', !histDescribed.includes('history'), histDescribed.slice(0, 80))
const histOutline = renderOutline([histBase], null)
check('and neither does the outline', !histOutline.includes('history'))

// --- a Session whose id is not readable yet ------------------------------------------
// The first turn arrives before the header carries an id, so the provider sees an empty one. Caching under
// that key permanently would freeze the workspace's answer as this Session's, and deleting it would blank
// the outline for a turn 测试'the failure the stale path exists to prevent. It is stored marked instead.
console.log('\nno session id yet')
const lateCwd = await mkdtemp(join(tmpdir(), 'kblate-'))
await saveBase(pathFor(lateCwd, 'a'), newBase('a', '测试', '测试', ''))
await state.writeSelection(lateCwd, new Set(['a']))
await outline.refresh(lateCwd)
const lateText = outline.outlineFor(lateCwd, '')
check('an id-less assembly still answers', lateText.length > 0, String(lateText.length))
check('and it carries the base', lateText.includes('测试'))
check('and the same text is served again, not blanked', outline.outlineFor(lateCwd, '') === lateText)
check('but it is flagged for rebuilding', outline.needsRefresh(lateCwd, '') === true)
// Once an id exists, the real answer is built under it and is not provisional.
await outline.refresh(lateCwd, 'session-real')
check('a real id builds its own entry', outline.outlineFor(lateCwd, 'session-real').includes('测试'))
check('and that one is not provisional', outline.needsRefresh(lateCwd, 'session-real') === false)

// --- naming a session whose id has a colon -------------------------------------------
// writeName stores a key in layout.json and guarded it with the file-name whitelist, so every IM session 测试// id `im:qq_测试dm:测试 测试could not be named at all. The name is not a path; nothing needed checking there.
console.log('\nan IM session can be named')
const nameCwd = await mkdtemp(join(tmpdir(), 'kbname-'))
const imId = 'im:qq_ad251634eac6:dm:1791127482728:7F3A5AC3FC6347F8D91D4B81FFC505C7'
check('an IM id can be named',
  await state.writeName(nameCwd, imId, '鲸鱼娘').then(() => true, (error) => error.message) === true)
check('and the name comes back', (await state.readNames(nameCwd))[imId] === '鲸鱼娘')
check('and an empty name clears it',
  await state.writeName(nameCwd, imId, '').then(async () => Object.keys(await state.readNames(nameCwd)).length === 0))
check('an empty id is still refused',
  await state.writeName(nameCwd, '', 'x').then(() => false, (error) => /needs a session/.test(error.message)))
// The one place a character really is illegal is the path, and there it is encoded rather than refused.
check('the path builder encodes the same id', !state.sessionSelectionPath(nameCwd, imId).includes('im:qq'))
check('and the panel agrees with the host',
  state.sessionSelectionPath(nameCwd, imId).split(/[\\/]/).pop() === sessionFileStem(imId) + '.json')

// --- two layout patches at once must both survive -------------------------------------
// `patchLayout` reads the file, merges one key and writes the whole document back, and `writeJson` used a
// fixed `<path>.tmp`. A mode change posts `mode` and `layout` together, so two of these overlap by design:
// the second read saw the state from before the first wrote, the first key was dropped, and sharing one
// temporary name let the two writes land in the same file. The result was a `layout.json` with a stray
// `"names": {}` and a second closing brace after the real end, which made the whole panel unreadable.
console.log('\nconcurrent layout patches')
const raceCwd = await mkdtemp(join(tmpdir(), 'kb-race-'))
await Promise.all([
  state.writeShape(raceCwd, 'ops', 'radial'),
  state.writeLayout(raceCwd, 'ops', { o1: { x: 11, y: 22 } }),
  state.writeBaseWidth(raceCwd, 'ops', 240),
])
const raced = JSON.parse(await readFile(join(raceCwd, '.dsh-knowledge', 'layout.json'), 'utf8'))
check('the file still parses', raced && raced.version === 1)
check('the shape survived', raced.shapes && raced.shapes.ops === 'radial', JSON.stringify(raced.modes))
check('and so did the positions', raced.positions && raced.positions.ops
  && raced.positions.ops.o1 && raced.positions.ops.o1.x === 11, JSON.stringify(raced.positions))
check('and the width', raced.widths && raced.widths.ops === 240, JSON.stringify(raced.widths))
const leftovers = await readdir(join(raceCwd, '.dsh-knowledge'))
check('and no temporary file was left behind',
  leftovers.every((name) => !name.endsWith('.tmp')), JSON.stringify(leftovers))
await rm(raceCwd, { recursive: true, force: true })

await rm(cwd, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
