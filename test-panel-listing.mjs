import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listBases, newBase, pathFor, saveBase } from './lib/store.js'
import { writeAttachmentMode } from './lib/state.js'

// Exercise the panel's real asynchronous loading effect, not a rewritten copy of its filter.
const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
const listingAt = source.indexOf('const listing = unwrap(await REMOTE.workspaceFiles.list(')
assert.ok(listingAt > 0)
const start = source.lastIndexOf('React.useEffect(', listingAt) + 'React.useEffect('.length
const end = source.indexOf(', [sessionId, tick, scope]);', listingAt)
assert.ok(end > start)
const effectSource = source.slice(start, end)
const cwd = await mkdtemp(join(tmpdir(), 'canvas-panel-listing-'))
const dir = join(cwd, '.dsh-knowledge')
try {
  await mkdir(dir, { recursive: true })
  await saveBase(pathFor(cwd, 'eng-workflow'), newBase('eng-workflow', '工程流程', '入口', '保留节点正文'))
  await saveBase(pathFor(cwd, 'reference'), newBase('reference', '参考', '参考', '参考正文'))
  await writeFile(join(dir, 'selection.json'), JSON.stringify({ enabled: ['eng-workflow'], order: ['reference', 'eng-workflow'] }))
  const positions = { 'eng-workflow': { n1: { x: 123, y: 456 } } }
  await writeFile(join(dir, 'layout.json'), JSON.stringify({ positions, collapsed: { 'eng-workflow': ['n1'] } }))
  await writeFile(join(dir, 'diary-other.json'), JSON.stringify({ id: 'diary-other', nodes: [], links: [] }))
  const originalBase = await readFile(pathFor(cwd, 'eng-workflow'), 'utf8')

  async function load() {
    const values = {}, reads = []
    let resolveState
    const completed = new Promise(resolve => { resolveState = resolve })
    const workspaceFiles = {
      async list() { return { entries: (await readdir(dir)).map(name => ({ type: 'file', name })) } },
      async read(_session, path) { reads.push(path); return { text: await readFile(join(cwd, path), 'utf8') } },
    }
    const save = key => value => { values[key] = value }
    const env = {
      REMOTE: { workspaceFiles }, sessionId: 'regression', unwrap: value => value, DIR: '.dsh-knowledge',
      activityRef: { current: null }, post: async () => null, PREFIX: '/dsh-knowledge-tree',
      fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }), scope: 'default',
      sessionFileName: () => 'regression', collapseWrites: { current: { pending: {}, values: {}, confirmed: {} } },
      setState(value) { values.state = value; resolveState() },
    }
    for (const key of ['NodeInjection', 'InjectionDefaults', 'Enabled', 'HasOwnSelection', 'Positions', 'Collapsed', 'Colors', 'Shapes', 'Widths', 'NodeWidths', 'Names']) env['set' + key] = save(key)
    const effect = new Function(...Object.keys(env), 'return (' + effectSource + ')')(...Object.values(env))
    const dispose = effect()
    await Promise.race([completed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('panel load timed out')), 5000); timer.unref() })])
    // The setters following setState run in the same continuation.
    assert.equal(values.state.status, 'live', values.state.message)
    assert.deepEqual(values.state.bases.map(base => base.id), ['reference', 'eng-workflow'])
    assert.deepEqual(values.Enabled, { reference: false, 'eng-workflow': true })
    assert.deepEqual(values.Positions, positions)
    assert.deepEqual(values.Collapsed, { 'eng-workflow': ['n1'] })
    assert.ok(!reads.includes('.dsh-knowledge/.attachment-settings.json'), 'panel never reads attachment preferences as a base')
    dispose()
  }

  await load()
  for (const mode of ['on-demand', 'required']) {
    await writeAttachmentMode(cwd, mode)
    await load()
    assert.ok((await listBases(cwd)).some(base => base.id === 'eng-workflow'))
  }
  // Known non-base data is skipped by name even if unreadable or shaped like a base.
  await writeFile(join(dir, '.attachment-settings.json'), '{broken-json')
  await load()
  await writeFile(join(dir, '.attachment-settings.json'), JSON.stringify({ id: 'fake-preferences', nodes: [] }))
  await load()
  for (const value of [null, {}, [], 7, 'text', { id: null }, { id: 12 }, { version: 1, mode: 'future' }]) {
    await writeFile(join(dir, 'future-preferences.json'), JSON.stringify(value))
    await load()
  }
  assert.equal(await readFile(pathFor(cwd, 'eng-workflow'), 'utf8'), originalBase, 'loading never rewrites knowledge data')
  console.log('panel listing: both attachment policies, invalid/foreign JSON values, selection, layout, diary filtering and non-mutation passed')
} finally {
  await rm(cwd, { recursive: true, force: true })
}
