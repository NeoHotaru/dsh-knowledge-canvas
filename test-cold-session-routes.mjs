import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHandler } from './lib/routes.js'
import { newBase, pathFor, saveBase } from './lib/store.js'
import { readLayout } from './lib/state.js'

const cwd = await mkdtemp(join(tmpdir(), 'kb-cold-routes-'))
const events = []
let mode = 'valid'
const ctx = {
  sessions: { get: (id) => id === 'live' ? { header: { id, cwd } } : id === 'no-cwd' ? { header: { id } } : undefined },
  get: (service) => service === 'sessionPersistence' ? {
    open: async (id, access) => {
      events.push(['open', id, access])
      if (id === 'missing') throw new Error('session not found')
      assert.equal(access, 'read')
      return {
        header: { id: mode === 'wrong-id' ? 'other-session' : id, cwd: mode === 'no-cwd' ? undefined : cwd },
        read: () => { throw new Error('must not replay a conversation to resolve its workspace') },
        close: async () => { events.push(['close']); if (mode === 'close-error') throw new Error('header close failed') },
      }
    },
  } : undefined,
}
const handle = createHandler(ctx)
async function call(method, action, payload) {
  const req = { method, url: '/dsh-knowledge-tree/' + action, headers: payload === undefined ? {} : { 'content-type': 'application/json' },
    on(type, listener) { if(type === 'data' && payload !== undefined) listener(Buffer.from(JSON.stringify(payload))); if(type === 'end') listener(); return this } }
  let status, body
  await handle(req, { writeHead(code) { status=code }, setHeader() {}, end(chunk) { body=JSON.parse(String(chunk)) } })
  return { status, ...body }
}
try {
  await saveBase(pathFor(cwd, 'base'), newBase('base', '测试', '根', '正文'))
  assert.equal((await call('GET', 'state?session=live')).ok, true)
  assert.equal(events.length, 0, 'resident sessions do not open persistence')
  const cold = await call('GET', 'state?session=cold')
  assert.equal(cold.ok, true); assert.equal(cold.bases.length, 1)
  assert.deepEqual(events, [['open', 'cold', 'read'], ['close']])
  const saved = await call('PUT', 'layout', { session:'cold', base:'base', positions:{ n1:{x:42,y:84} } })
  assert.equal(saved.ok, true)
  const layout = await readLayout(cwd)
  assert.equal(layout.base.n1.x, 42)
  assert.equal((await call('PUT', 'activity', { session:'cold', limit:1 })).ok, true)
  assert.equal((await call('GET', 'state?session=missing')).ok, false)
  const opened = events.length
  assert.equal((await call('GET', 'state?session=no-cwd')).ok, false)
  assert.equal(events.length, opened, 'a live header without cwd must not borrow another header')
  for (mode of ['wrong-id', 'no-cwd', 'close-error']) {
    const before = events.length
    assert.equal((await call('PUT', 'layout', {session:'cold',base:'base',positions:{n1:{x:999,y:999}}})).ok, false)
    assert.deepEqual(events.slice(before), [['open','cold','read'],['close']], 'read handle is always closed')
    assert.deepEqual(await readLayout(cwd), layout, 'failed resolution cannot write a layout')
  }
  const source = await readFile(new URL('./client.js', import.meta.url), 'utf8')
  const start = source.indexOf('const post = React.useCallback(') + 'const post = React.useCallback('.length
  const end = source.indexOf(', [sessionId]);', start)
  assert.ok(start > 0 && end > start)
  const states = []
  const fail = async () => ({ok:false,status:400,json:async()=>({ok:false,error:'cannot read workspace'})})
  const post = new Function('fetch','setSaving','sessionId','PREFIX','return ('+source.slice(start,end)+')')(fail, value=>states.push(value), 'cold', '/dsh-knowledge-tree')
  await assert.rejects(post('activity', {}, true), /cannot read workspace/)
  assert.deepEqual(states, [], 'background read errors do not become save failures')
  await assert.rejects(post('layout', {}), /cannot read workspace/)
  assert.equal(states[0], 'saving'); assert.match(states[1].error, /cannot read workspace/)
  console.log('cold-session routes: header-only resolution, real writes, activity reads, identity/missing-cwd refusal, handle close, non-mutation and quiet-error status passed')
} finally { await rm(cwd, {recursive:true,force:true}) }
