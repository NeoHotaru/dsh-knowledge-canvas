import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newBase, pathFor, saveBase, upsertNode } from './lib/store.js'
import { readInject, writeInject, readNodeInject, writeNodeInject, pruneNodeInject, writeSelection, writeOrder, writeLive,
  writeSessionSelection, writeDiary, diaryBaseFor } from './lib/state.js'
import { renderOutline, refresh, outlineFor } from './lib/outline.js'
import { createNodeFromPanel, purgeNodeFromPanel, removeNodeFromPanel, removeBaseFromPanel, createHandler } from './lib/routes.js'
import { apply } from './index.js'
import { TOOLS } from './lib/tools.js'

const cwd = await mkdtemp(join(tmpdir(), 'kb-mixed-'))
const n = (id, parent = null, change) => ({ id, parent, title: '标题' + id,
  body: `正文首句。\nPRIVATE_BODY_${id}\n什么时候该想起它：查阅${id}`, ...(change ? { change } : {}) })
const base = { id: 'mixed', name: '分层测试库', nodes: [n('a'),n('b','a'),n('c','b'),n('d'),
  n('retired',null,'removed'),n('retired-child','retired'),n('orphan','missing')], links: [{from:'a',to:'b',note:'测试关联'}] }
const ctx = { sessions: { get: (id) => id === 's' || id === 'other' ? { header: { id, cwd } } : undefined },
  get: (key) => key === 'sessionPersistence' ? { open: async (id) => ({ header: { id, cwd }, close: async () => {} }) } : undefined }
const handle = createHandler(ctx)
async function call(action, payload) {
  const req = { method: 'PUT', url: '/dsh-knowledge-tree/' + action, headers: {'content-type':'application/json'},
    on(type, callback) { if(type==='data') callback(Buffer.from(JSON.stringify(payload))); if(type==='end') callback(); return this } }
  let status, result
  await handle(req, {writeHead(code) {status=code}, end(text) {result=JSON.parse(String(text))}, setHeader() {}})
  return {status,...result}
}
try {
  let text = renderOutline([base], null, {}, {mixed:{a:'full'}})
  assert.ok(text.includes('PRIVATE_BODY_a'))
  for (const id of ['b','c','d','retired','retired-child','orphan']) assert.ok(!text.includes('PRIVATE_BODY_'+id))
  assert.equal(text.split('PRIVATE_BODY_a').length, 2, 'full body appears once')
  assert.ok(text.includes('查阅b'), 'on-demand trigger remains searchable')
  assert.ok(!text.includes('retired-child'), 'removed subtrees stay hidden')
  text = renderOutline([base], null, {mixed:'full'}, {mixed:{b:'index'}})
  assert.ok(!text.includes('PRIVATE_BODY_b'))
  assert.ok(text.includes('PRIVATE_BODY_a') && text.includes('PRIVATE_BODY_c'), 'override does not spread to parent or child')
  assert.ok(text.includes('PRIVATE_BODY_orphan'), 'orphan follows its own policy')
  assert.equal(renderOutline([base], new Set(), {mixed:'full'}, {mixed:{a:'full'}}), '')
  assert.equal(renderOutline([base], null, {mixed:'full'}, {}), renderOutline([base], null, {mixed:'full'}), 'legacy branch unchanged')
  const big = {...base, nodes:[{...n('huge'),body:'x'.repeat(25000)+'\n什么时候该想起它：巨大正文'}, n('small')]}
  text = renderOutline([big], null, {}, {mixed:{huge:'full',small:'full'}})
  assert.ok(text.includes('额度不足') && !text.includes('x'.repeat(500)))
  assert.ok(text.includes('PRIVATE_BODY_small'), 'one huge node does not consume every smaller node budget')
  const cycle = {...base, nodes:[n('x','y'),n('y','x')]}
  text = renderOutline([cycle], null, {}, {mixed:{x:'full'}})
  assert.equal(text.split('PRIVATE_BODY_x').length, 2)
  assert.equal(renderOutline([cycle], null, {}, {mixed:{x:'full'}}), text, 'unchanged prompt remains byte-stable')

  await saveBase(pathFor(cwd,base.id),base)
  const original = await readFile(pathFor(cwd,base.id),'utf8')
  await writeNodeInject(cwd,base.id,'a','full')
  await Promise.all([writeNodeInject(cwd,base.id,'b','index'),writeNodeInject(cwd,base.id,'c','full')])
  assert.deepEqual((await readNodeInject(cwd)).mixed, {a:'full',b:'index',c:'full'}, 'parallel choices persist')
  await writeInject(cwd,base.id,'full')
  await writeSelection(cwd,[base.id])
  await writeOrder(cwd,[base.id])
  await writeLive(cwd,true)
  assert.deepEqual((await readNodeInject(cwd)).mixed, {a:'full',b:'index',c:'full'}, 'other settings preserve policies')
  await writeSessionSelection(cwd,'other',[])
  await refresh(cwd,'s'); await refresh(cwd,'other')
  assert.ok(outlineFor(cwd,'s').includes('PRIVATE_BODY_a'))
  assert.equal(outlineFor(cwd,'other'),'')
  const saved = await call('nodeInject',{session:'s',base:base.id,node:'a',mode:'index'})
  assert.equal(saved.ok,true)
  assert.ok(!outlineFor(cwd,'s').includes('PRIVATE_BODY_a'), 'saved policy reaches next synchronous provider')
  assert.ok(outlineFor(cwd,'s').includes('PRIVATE_BODY_c'))
  assert.equal(outlineFor(cwd,'other'),'','disabled session remains isolated after rebuild')
  await call('nodeInject',{session:'s',base:base.id,node:'a',mode:'inherit'})
  assert.equal((await readNodeInject(cwd)).mixed.a,undefined)
  assert.ok(outlineFor(cwd,'s').includes('PRIVATE_BODY_a'),'inherit restores full default')
  const before = JSON.stringify(await readNodeInject(cwd))
  for (const payload of [
    {base:base.id,node:'no-node',mode:'full'}, {base:'no-base',node:'a',mode:'full'},
    {base:base.id,node:'a',mode:'wrong'}, {base:'../bad',node:'a',mode:'full'},
  ]) assert.equal((await call('nodeInject',{session:'s',...payload})).ok,false)
  assert.equal(JSON.stringify(await readNodeInject(cwd)),before,'refused requests do not alter settings')
  assert.equal((await call('nodeInject',{session:'cold',base:base.id,node:'d',mode:'index'})).ok,true,'cold session can save')
  assert.equal(await readFile(pathFor(cwd,base.id),'utf8'),original,'policies never rewrite knowledge')
  const reopened = await import('./lib/state.js?reopen='+Date.now())
  assert.equal((await reopened.readNodeInject(cwd)).mixed.d,'index','fresh module reads persisted settings')

  const ownDiary = diaryBaseFor('s')
  const foreignDiary = diaryBaseFor('other')
  await writeDiary(cwd,true,'s'); await writeDiary(cwd,true,'other')
  for (const id of [ownDiary,foreignDiary]) {
    const diary = newBase(id,'日记','今日','PRIVATE_DIARY_'+id)
    await saveBase(pathFor(cwd,id),diary)
    await writeNodeInject(cwd,id,diary.nodes[0].id,'full')
  }
  await writeSelection(cwd,[base.id,ownDiary,foreignDiary])
  await refresh(cwd,'s')
  text = outlineFor(cwd,'s')
  assert.ok(text.includes('PRIVATE_DIARY_'+ownDiary))
  assert.ok(!text.includes('PRIVATE_DIARY_'+foreignDiary))
  assert.equal((await call('nodeInject',{session:'s',base:foreignDiary,node:'n1',mode:'index'})).ok,false,'foreign diary cannot be configured')

  // Exercise the actual registered runtime providers that the host assembles, with no paid model call.
  const providers=[]
  apply({ ...ctx, tools:{register(){}}, systemPrompt:{section(){},context(spec){providers.push(spec)}},
    on(){return ()=>{}},effect(run){return run()} })
  const agent = { session:{ header:{id:'s',cwd} } }
  const runtime = providers.find((entry)=>entry.name==='knowledge-tree')
  const protocol = providers.find((entry)=>entry.name==='knowledge-tree.protocol')
  assert.ok(runtime && protocol)
  assert.equal(runtime.text({agent}),text)
  assert.ok(protocol.text({agent}).includes('未全文注入'))
  // Removed identities must never transfer policy to a newly allocated node.
  const clean = newBase('cleanup','Cleanup','root','body')
  await saveBase(pathFor(cwd,clean.id),clean)
  const made = await createNodeFromPanel(cwd,clean.id,{title:'old',body:'old'})
  await writeNodeInject(cwd,clean.id,made.node,'full')
  await removeNodeFromPanel(cwd,clean.id,made.node)
  assert.equal((await readNodeInject(cwd)).cleanup[made.node],'full','soft delete keeps reversible policy')
  await purgeNodeFromPanel(cwd,clean.id,made.node)
  assert.equal((await readNodeInject(cwd)).cleanup,undefined,'purge clears orphaned policy')
  const reused = await createNodeFromPanel(cwd,clean.id,{title:'new',body:'new'})
  assert.equal(reused.node,made.node,'fixture actually reuses ID')
  assert.equal((await readNodeInject(cwd)).cleanup,undefined,'new identity inherits base default')
  await writeNodeInject(cwd,clean.id,'n99','full')
  await Promise.all([pruneNodeInject(cwd,clean.id,['n1',reused.node]),writeNodeInject(cwd,clean.id,'n1','index')])
  assert.deepEqual((await readNodeInject(cwd)).cleanup,{n1:'index'},'pruning serializes with unrelated saves')
  await writeNodeInject(cwd,clean.id,'n3','full')
  const next = await createNodeFromPanel(cwd,clean.id,{title:'third',body:'third'})
  assert.equal(next.node,'n3')
  assert.equal((await readNodeInject(cwd)).cleanup.n3,undefined,'allocation removes pre-existing orphan')
  await writeNodeInject(cwd,clean.id,next.node,'full')
  const undoResult = await call('revert',{session:'s',base:clean.id,node:next.node})
  assert.equal(undoResult.ok,true,JSON.stringify(undoResult))
  assert.equal((await readNodeInject(cwd)).cleanup.n3,undefined,'single undo drops policy of removed addition')
  const bulk = await createNodeFromPanel(cwd,clean.id,{title:'bulk',body:'body'})
  await writeNodeInject(cwd,clean.id,bulk.node,'full')
  assert.equal((await call('revert',{session:'s',base:clean.id})).ok,true)
  assert.equal((await readNodeInject(cwd)).cleanup,undefined,'bulk undo clears removed additions')
  await removeBaseFromPanel(cwd,clean.id)
  assert.equal((await readNodeInject(cwd)).cleanup,undefined,'base removal clears every policy')
  const exec = {agent:{session:{header:{cwd,id:'s'}}}}
  const tool = (name,args) => TOOLS.find(t=>t.name===name).execute(args,exec)
  await writeNodeInject(cwd,'fresh','n1','full')
  await tool('knowledge_create_base',{id:'fresh',name:'Fresh',first_title:'root',first_body:'body'})
  assert.equal((await readNodeInject(cwd)).fresh,undefined,'tool creation clears old base identity')
  await writeNodeInject(cwd,'fresh','n2','full')
  await tool('knowledge_write_node',{base:'fresh',title:'new',body:'new',session_name:'Regression'})
  assert.equal((await readNodeInject(cwd)).fresh,undefined,'tool allocation removes stale IDs')
  await writeNodeInject(cwd,'fresh','n1','index')
  await tool('knowledge_remove_base',{base:'fresh'})
  assert.equal((await readNodeInject(cwd)).fresh,undefined,'model base removal clears policies')
  console.log('mixed injection: rendering, budgets, hierarchy, stable prompts, persistence, concurrent saves, HTTP validation, cold sessions, cache delivery, diary isolation and registered runtime contexts passed')
} finally {
  await rm(cwd,{recursive:true,force:true})
}
