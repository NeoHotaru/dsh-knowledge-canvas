// Exercise the store against a throwaway directory, so the logic is checked without a reload.
// Run: node test-store.mjs

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addLink, assertId, describeBase, listBases, loadBase, newBase, pathFor, removeNode, saveBase, upsertNode,
} from './lib/store.js'
import { TOOLS } from './lib/tools.js'
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
check('the wrapper keeps every tool', TOOLS.length === 7, String(TOOLS.length))
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
  (await routeModule.listWorkspaces(fakeCtx({ a: wsCwd, b: wsCwd, c: 'D:/other' }), 'a')).length === 2)
const listed = await routeModule.listWorkspaces(fakeCtx({ a: wsCwd }), 'a')
const mine = listed.find((entry) => entry.cwd === wsCwd)
check('a workspace carries its bases', mine && mine.bases.length === 2, JSON.stringify(mine && mine.bases))
check('and which are on', mine && mine.enabled.join() === 'one', JSON.stringify(mine && mine.enabled))
check('a workspace is named, not pathed, for the browser',
  mine && typeof mine.sessionId === 'string' && mine.sessionId.length > 0)
check('the name is the last path segment', mine && mine.name === wsCwd.split(/[\\/]/).pop(), mine && mine.name)

// A service that cannot enumerate still answers with the session that asked.
const blind = { sessions: { get: (id) => (id === 'a' ? { header: { id: 'a', cwd: wsCwd } } : undefined) } }
check('without an enumerator, the asking session is still listed',
  (await routeModule.listWorkspaces(blind, 'a')).length === 1)

// A service whose list() throws must not take the route down.
const angry = {
  sessions: {
    get: (id) => (id === 'a' ? { header: { id: 'a', cwd: wsCwd } } : undefined),
    list: () => { throw new Error('nope') },
  },
}
check('a throwing enumerator falls back rather than failing',
  (await routeModule.listWorkspaces(angry, 'a')).length === 1)

// A workspace with no selection file means every base, which is null rather than an empty list.
const bare = await mkdtemp(join(tmpdir(), 'kbws2-'))
await saveBase(pathFor(bare, 'solo'), newBase('solo', '测试', '测试', ''))
const bareListed = await routeModule.listWorkspaces(fakeCtx({ z: bare }), 'z')
check('no selection file means null, not empty', bareListed[0].enabled === null, JSON.stringify(bareListed[0].enabled))

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
// The node keeps only the latest author and time; the history is what answers "who changed this, and when".
// Held in the node so it lands in the same write, and capped so a base does not become a log.
console.log('\nthe edit history')
await saveBase(pathFor(cwd, 'hist'), newBase('hist', '测试', '测试', ''))
const histBase = (await loadBase(cwd, 'hist')).base
const histNode = upsertNode(histBase, { title: '涓€测试', by: 'session-one' }).node
check('a created node starts its history', histNode.history.length === 1, JSON.stringify(histNode.history))
check('and the first entry carries the session', histNode.history[0].by === 'session-one')

upsertNode(histBase, { node: histNode.id, body: '鏀逛竴', by: 'session-two' })
upsertNode(histBase, { node: histNode.id, body: '鏀逛簩' })
check('every write appends', histNode.history.length === 3, String(histNode.history.length))
check('a write with no session is recorded without one',
  histNode.history[2].by === undefined, JSON.stringify(histNode.history[2]))
check('each entry has a time', histNode.history.every((entry) => typeof entry.at === 'string'))

for (let at = 0; at < 20; at += 1) upsertNode(histBase, { node: histNode.id, body: '测试' + at + '测试' })
check('the cap holds', histNode.history.length === 10, String(histNode.history.length))
check('and the newest is kept, not the oldest',
  histNode.history[9].at >= histNode.history[0].at)

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
