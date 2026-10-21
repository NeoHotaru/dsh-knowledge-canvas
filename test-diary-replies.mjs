import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { newBase, pathFor, saveBase, loadBase } from './lib/store.js'
import { diaryBaseFor, writeDiary } from './lib/state.js'
import { readDiaryReplies, submitDiaryReply, replyPrompt } from './lib/diary-replies.js'
import { createHandler } from './lib/routes.js'

const cwd = await mkdtemp(join(tmpdir(), 'diary-replies-'))
try {
  const session = 'reply-owner'
  const baseId = diaryBaseFor(session)
  const base = newBase(baseId, '日记', '留一盏', '那盏灯还亮着。')
  await saveBase(pathFor(cwd, baseId), base)
  await writeDiary(cwd, true, session)
  const original = await readFile(pathFor(cwd, baseId), 'utf8')
  const received = new Map()
  let attempts = 0
  const ctx = { get: () => ({ prompt: async (request, signal) => {
    attempts += 1
    signal.throwIfAborted()
    assert.equal(request.sessionId, session)
    assert.equal(request.mode, 'queue')
    assert.equal(request.content[0].type, 'text')
    received.set(request.requestId, request)
    return { accepted: true }
  } }) }
  const payload = { base: baseId, node: 'n1', id: randomUUID(), text: '这一页，我很喜欢。' }
  assert.deepEqual(await readDiaryReplies(cwd, session, baseId, 'n1'), [])
  const sent = await submitDiaryReply(ctx, cwd, session, payload)
  assert.equal(sent.accepted, true)
  assert.equal(sent.reply.status, 'sent')
  assert.ok(!('prompt' in sent.reply))
  assert.ok(received.get('diary-reply-' + payload.id).content[0].text.includes('那盏灯还亮着。'))
  assert.ok(received.get('diary-reply-' + payload.id).content[0].text.includes(payload.text))
  await submitDiaryReply(ctx, cwd, session, payload)
  assert.equal(attempts, 1, 'confirmed reply is not submitted twice')
  assert.equal((await readDiaryReplies(cwd, session, baseId, 'n1')).length, 1)
  assert.equal(await readFile(pathFor(cwd, baseId), 'utf8'), original, 'reply never rewrites the diary')
  const journalPath = join(cwd, '.dsh-knowledge', '.diary-replies', baseId + '.json')
  assert.ok(!(await readFile(journalPath, 'utf8')).includes(payload.text), 'replies are sealed on disk')
  await assert.rejects(submitDiaryReply(ctx, cwd, session, { ...payload, text: 'same id, other text' }), /编号/)
  await assert.rejects(readDiaryReplies(cwd, 'other-session', baseId, 'n1'), /当前会话/)
  await assert.rejects(submitDiaryReply(ctx, cwd, session, { ...payload, id: randomUUID(), text: '   ' }), /1～4000/)
  await assert.rejects(submitDiaryReply(ctx, cwd, session, { ...payload, id: randomUUID(), text: '字'.repeat(4001) }), /1～4000/)
  await assert.rejects(submitDiaryReply(ctx, cwd, session, { ...payload, node: '../escape' }), /node id must match/)
  await assert.rejects(submitDiaryReply(ctx, cwd, session, { ...payload, id: '../../x' }), /编号/)
  const failedPayload = { ...payload, id: randomUUID(), text: '失败后保留的回复' }
  const failure = await submitDiaryReply({ get: () => null }, cwd, session, failedPayload)
  assert.equal(failure.accepted, false)
  assert.equal(failure.reply.status, 'failed')
  const retried = await submitDiaryReply(ctx, cwd, session, failedPayload)
  assert.equal(retried.accepted, true)
  // Admission may succeed even if transport loses the response. The retry must carry exactly the same id and snapshot.
  const ambiguous = { ...payload, id: randomUUID(), text: '确认丢失后重试' }
  let firstRequest
  await submitDiaryReply({ get: () => ({ prompt: async (request) => { firstRequest = request; throw new Error('response lost') } }) }, cwd, session, ambiguous)
  await submitDiaryReply({ get: () => ({ prompt: async (request) => { assert.deepEqual(request, firstRequest); return { accepted: true } } }) }, cwd, session, ambiguous)
  await Promise.all(Array.from({ length: 7 }, (_, n) => submitDiaryReply(ctx, cwd, session, { ...payload, id: randomUUID(), text: '并发回复 ' + n })))
  assert.equal((await readDiaryReplies(cwd, session, baseId, 'n1')).length, 10, 'concurrent replies are not lost')
  assert.ok(replyPrompt({ id: 'n1', title: '长日记', body: '字'.repeat(9000) }, '回复').includes('只附前 8000'))
  await writeDiary(cwd, false, session)
  await assert.rejects(readDiaryReplies(cwd, session, baseId, 'n1'), /当前会话/)
  await writeDiary(cwd, true, session)
  const { base: removed } = await loadBase(cwd, baseId)
  removed.nodes[0].change = 'removed'
  await saveBase(pathFor(cwd, baseId), removed)
  await assert.rejects(submitDiaryReply(ctx, cwd, session, { ...payload, id: randomUUID() }), /找不到/)
  removed.nodes[0].change = undefined
  await saveBase(pathFor(cwd, baseId), removed)
  const host = { ...ctx, sessions: { get: (id) => id === session ? { header: { id, cwd } } : undefined } }
  const handler = createHandler(host)
  async function route(action, body) {
    let status, result
    const req = { url: '/dsh-knowledge-tree/' + action, method: 'PUT', headers: { 'content-type': 'application/json' }, on(event, fn) { if (event === 'data') fn(Buffer.from(JSON.stringify(body))); if (event === 'end') fn(); return this } }
    await handler(req, { writeHead(value) { status = value }, end(text) { result = JSON.parse(String(text)) } })
    return { status, result }
  }
  assert.equal((await route('diaryreplies', { session, base: baseId, node: 'n1' })).result.replies.length, 10)
  assert.equal((await route('diaryreply', { session, ...payload, workspace: cwd })).result.ok, false)
  const routed = await route('diaryreply', { session, ...payload, id: randomUUID(), text: '通过真实路由分派' })
  assert.equal(routed.status, 200)
  assert.equal(routed.result.accepted, true)
  await writeFile(journalPath, 'broken journal', 'utf8')
  await assert.rejects(submitDiaryReply(ctx, cwd, session, { ...payload, id: randomUUID() }))
  assert.equal(await readFile(journalPath, 'utf8'), 'broken journal', 'corruption is never overwritten')
  console.log('diary replies: durable encrypted storage, non-mutation, ownership, concurrent writes, retry identity, limits, corrupt files and route dispatch passed')
} finally { await rm(cwd, { recursive: true, force: true }) }
