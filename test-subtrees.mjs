import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { newBase, pathFor, saveBase } from './lib/store.js'
import { readCollapsed, readLayout, writeLayout, writeColors, writeShape, writeCollapsed } from './lib/state.js'
import { createHandler, setCollapsed, purgeNodeFromPanel } from './lib/routes.js'
import { refresh, outlineFor } from './lib/outline.js'

let spec
globalThis.window = { __ModuleLoader__: { load: (value) => { spec = value } } }
await import('./client.js')
const { subtreeIndex, foldedNodes, applyCollapse } = spec.factory(() => ({ createElement: () => ({}), Component: class {} })).__logic
const nodes = [
  { id: 'n0', parent: null }, { id: 'n1', parent: 'n0' }, { id: 'n2', parent: 'n1' },
  { id: 'n3', parent: 'n2' }, { id: 'n4', parent: 'n0' }, { id: 'n5', parent: 'n4' },
].map((n) => ({ ...n, title: n.id, body: '正文\n什么时候该想起它：测试折叠与读取隔离。' }))
const index = subtreeIndex(nodes)
assert.equal(index.descendants.get('n0'), 5)
assert.equal(index.descendants.get('n1'), 2)
assert.deepEqual([...foldedNodes(index, ['n1'])], ['n2', 'n3'])
assert.deepEqual(applyCollapse(index, ['n0', 'n1', 'n2', 'n4'], { reveal: 'n2' }), ['n2', 'n4'], 'reveal expands ancestors, not target or unrelated branch')
assert.deepEqual([...foldedNodes(index, applyCollapse(index, ['n1', 'n2'], { node: 'n1', collapsed: false }))], ['n3'])
assert.deepEqual(applyCollapse(index, ['n1'], { expandAll: true }), [])
assert.deepEqual(applyCollapse(index, [], { node: 'n3', collapsed: true }), [], 'leaves do not fold')
const malformed = subtreeIndex([{ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }, { id: 'c', parent: 'missing' }, { id: 'd', parent: 'd' }])
assert.equal(malformed.order.length, 4)
assert.ok(foldedNodes(malformed, ['a']).size < 4, 'cycles cannot hide every node or loop forever')
const deep = subtreeIndex(Array.from({ length: 12000 }, (_, i) => ({ id: 'd' + i, parent: i ? 'd' + (i - 1) : null })))
assert.equal(deep.descendants.get('d0'), 11999)
assert.equal(foldedNodes(deep, ['d0']).size, 11999, 'deep folds are iterative')

// Exercise the real optimistic write queue: a late response cannot undo a newer click,
// failure returns to the last confirmed state, and an old session cannot update the new panel.
const clientSource = (await readFile(new URL('./client.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
const start = clientSource.indexOf('const changeCollapsed = ') + 'const changeCollapsed = '.length
const end = clientSource.indexOf('\n\n      const renameSession', start)
assert.ok(start > 0 && end > start)
const held = { values: {}, confirmed: {}, versions: {}, pending: {}, queue: Promise.resolve() }
const writer = { current: held }, ui = [], requests = []
const post = (action, body) => new Promise((resolve, reject) => requests.push({ action, body, resolve, reject }))
const change = new Function('collapseWrites', 'setCollapsed', 'subtreeIndex', 'applyCollapse', 'post',
  'return (' + clientSource.slice(start, end).trim().replace(/;$/, '') + ')')(writer, (value) => ui.push(value), subtreeIndex, applyCollapse, post)
const flush = () => new Promise((resolve) => setImmediate(resolve))
change({ id: 'demo', nodes }, { node: 'n1', collapsed: true })
change({ id: 'demo', nodes }, { node: 'n4', collapsed: true })
assert.deepEqual(ui.at(-1).demo, ['n1', 'n4'])
await flush(); assert.equal(requests.length, 1)
requests[0].resolve({ collapsed: ['n1'] }); await flush()
assert.deepEqual(ui.at(-1).demo, ['n1', 'n4'])
assert.equal(requests.length, 2)
requests[1].reject(new Error('save failed')); await held.queue
assert.deepEqual(ui.at(-1).demo, ['n1'])
change({ id: 'demo', nodes }, { node: 'n4', collapsed: true }); await flush()
const shown = ui.length
writer.current = { values: {}, session: 'another-session' }
requests[2].resolve({ collapsed: ['n1', 'n4'] }); await held.queue
assert.equal(ui.length, shown, 'a previous session response cannot mutate the current panel')

const cwd = await mkdtemp(join(tmpdir(), 'kb-subtree-'))
const other = await mkdtemp(join(tmpdir(), 'kb-subtree-'))
try {
  const base = newBase('demo', '演示', '根', '正文'); base.nodes = nodes; base.links = [{ from: 'n3', to: 'n5', note: '跨分支' }]
  await saveBase(pathFor(cwd, 'demo'), base)
  const original = await readFile(pathFor(cwd, 'demo'), 'utf8')
  await refresh(cwd, 's'); const outline = outlineFor(cwd, 's')
  const positions = { n0: { x: 30, y: 40 }, n3: { x: 200, y: 500 } }
  await writeLayout(cwd, 'demo', positions)
  await Promise.all([
    setCollapsed(cwd, 'demo', { node: 'n1', collapsed: true }),
    setCollapsed(cwd, 'demo', { node: 'n4', collapsed: true }),
    writeColors(cwd, 'demo', { n0: '#AABBCC' }),
    writeShape(cwd, 'demo', 'layers'),
  ])
  assert.deepEqual(new Set((await readCollapsed(cwd)).demo), new Set(['n1', 'n4']), 'atomic deltas do not drop concurrent folds')
  assert.deepEqual(await readLayout(cwd), { demo: positions })
  assert.deepEqual(await readCollapsed(other), {}, 'workspaces isolated')
  await refresh(cwd, 's')
  assert.equal(outlineFor(cwd, 's'), outline, 'collapse cannot change injected outline')
  assert.equal(await readFile(pathFor(cwd, 'demo'), 'utf8'), original, 'knowledge nodes and links unchanged')
  await assert.rejects(setCollapsed(cwd, 'demo', { node: 'n5', collapsed: true }), /children/)
  await assert.rejects(setCollapsed(cwd, 'demo', { node: 'missing', collapsed: true }), /no node/)
  await assert.rejects(setCollapsed(cwd, 'demo', { node: '../bad', collapsed: true }))
  await assert.rejects(setCollapsed(cwd, 'demo', { node: 'n1', collapsed: 'true' }), /boolean/)
  await assert.rejects(setCollapsed(cwd, 'demo', { expandAll: true, reveal: 'n3' }), /one/)
  await setCollapsed(cwd, 'demo', { node: 'n0', collapsed: true })
  await setCollapsed(cwd, 'demo', { node: 'n2', collapsed: true })
  const revealed = await setCollapsed(cwd, 'demo', { reveal: 'n2' })
  assert.deepEqual(new Set(revealed.collapsed), new Set(['n2', 'n4']))
  const handler = createHandler({ sessions: { get: (id) => id === 's' ? { header: { id, cwd } } : undefined } })
  async function call(payload) {
    const req = { method: 'PUT', url: '/dsh-knowledge-tree/collapse', headers: { 'content-type': 'application/json' },
      on(event, fn) { if (event === 'data') fn(Buffer.from(JSON.stringify(payload))); if (event === 'end') fn(); return this } }
    let status, body
    await handler(req, { writeHead(code) { status = code }, end(chunk) { body = JSON.parse(String(chunk)) } })
    return { status, ...body }
  }
  assert.equal((await call({ session: 's', base: 'demo', expandAll: true })).ok, true)
  assert.deepEqual((await readCollapsed(cwd)).demo, [])
  assert.equal((await call({ session: 's', base: 'demo', node: 'n1', collapsed: true })).ok, true)
  assert.equal((await call({ session: 'unknown', base: 'demo', expandAll: true })).ok, false)
  await writeCollapsed(cwd, 'second', { add: ['root'] })
  assert.deepEqual((await readCollapsed(cwd)).demo, ['n1'], 'base isolation')
  base.nodes.find((n) => n.id === 'n1').change = 'removed'
  await saveBase(pathFor(cwd, 'demo'), base)
  await purgeNodeFromPanel(cwd, 'demo', 'n1')
  assert.deepEqual((await readCollapsed(cwd)).demo, [], 'purged ids cannot carry old collapse to a new node')
  console.log('subtrees: nesting/counts, ancestor reveal, cycles/orphans, 12000-node chain, queued optimistic saves/rollback/session isolation, atomic persistence, workspace/base isolation, HTTP validation, purge cleanup, position and prompt non-mutation passed')
} finally {
  for (const dir of [cwd, other]) {
    assert.equal(dirname(await realpath(dir)), await realpath(tmpdir()))
    assert.ok(basename(dir).startsWith('kb-subtree-'))
    await rm(dir, { recursive: true, force: true })
  }
}
