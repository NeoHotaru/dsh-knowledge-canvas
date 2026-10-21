import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { diaryBaseFor, readDiary } from './state.js'
import { assertId, loadBase } from './store.js'
import { open, seal } from './seal.js'

const queues = new Map()
const MAX_REPLY = 4000
function serialized(key, job) {
  const previous = queues.get(key) || Promise.resolve()
  const result = previous.then(job, job)
  const tail = result.then(() => undefined, () => undefined)
  queues.set(key, tail)
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return result
}

async function owner(cwd, session, baseId, nodeId) {
  const own = diaryBaseFor(session)
  if (!own || own !== baseId || !(await readDiary(cwd, session))) throw new Error('只能回复当前会话已开启的日记')
  const { base } = await loadBase(cwd, own)
  const node = base.nodes.find((entry) => entry.id === assertId(nodeId, 'node id') && entry.change !== 'removed')
  if (!node) throw new Error('这一篇日记已经找不到了')
  return { own, node, path: join(cwd, '.dsh-knowledge', '.diary-replies', own + '.json') }
}

async function readJournal(path, baseId, session) {
  let text
  try { text = await readFile(path, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, base: baseId, session, entries: [] }
    throw error
  }
  const journal = open(baseId, text)
  if (journal.version !== 1 || journal.base !== baseId || journal.session !== session || !Array.isArray(journal.entries)) {
    throw new Error('日记回复记录无法读取，已保留原文件')
  }
  return journal
}

async function saveJournal(path, baseId, journal) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, seal(baseId, journal), 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function visible(entry) {
  // The saved diary excerpt is only for retrying the same accepted message, never a second copy in the UI.
  const { prompt, ...reply } = entry
  return reply
}

export async function readDiaryReplies(cwd, session, baseId, nodeId) {
  const { path, own } = await owner(cwd, session, baseId, nodeId)
  const journal = await readJournal(path, own, session)
  return journal.entries.filter((entry) => entry.node === nodeId).map(visible)
}

export function replyPrompt(node, text) {
  const body = String(node.body || '')
  const excerpt = body.slice(0, 8000)
  return '我在你的日记《' + node.title + '》下回复（节点 ' + node.id + '）：\n\n'
    + text + '\n\n【对应的日记正文，供你理解这条回复】\n' + excerpt
    + (body.length > excerpt.length ? '\n（正文较长，此处只附前 8000 字符；需要时请读取对应日记节点。）' : '')
}

/** Durable reply first, then the public Session prompt admission. A retry reuses the exact request id and content. */
export async function submitDiaryReply(ctx, cwd, session, payload) {
  const { own, node, path } = await owner(cwd, session, payload.base, payload.node)
  const id = payload.id
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('回复缺少有效编号，请刷新后重试')
  const text = typeof payload.text === 'string' ? payload.text.trim() : ''
  if (!text || text.length > MAX_REPLY) throw new Error('回复请输入 1～4000 字符')
  return serialized(path, async () => {
    // Recheck ownership after any queued operation, including a concurrent switch-off or removal.
    await owner(cwd, session, payload.base, payload.node)
    const journal = await readJournal(path, own, session)
    let entry = journal.entries.find((reply) => reply.id === id)
    if (entry && (entry.node !== payload.node || entry.text !== text)) throw new Error('这条回复编号已被使用，请保留原回复后重试')
    if (entry?.status === 'sent') return { reply: visible(entry), accepted: true }
    if (!entry) {
      entry = { id, node: node.id, title: node.title, text, at: new Date().toISOString(), status: 'pending', prompt: replyPrompt(node, text) }
      journal.entries.push(entry)
      await saveJournal(path, own, journal)
    }
    let controller
    try { controller = ctx.get?.('sessionController') } catch { /* report below */ }
    try {
      if (typeof controller?.prompt !== 'function') throw new Error('当前宿主没有消息发送接口，请升级 DSH')
      const answer = await controller.prompt({ requestId: 'diary-reply-' + id, sessionId: session, mode: 'queue',
        content: [{ type: 'text', text: entry.prompt }] }, new AbortController().signal)
      if (answer?.accepted !== true) throw new Error('宿主尚未确认接收这条回复')
      entry.status = 'sent'
      delete entry.error
    } catch (error) {
      entry.status = 'failed'
      entry.error = String(error?.message || error).slice(0, 500)
    }
    // If this save fails after admission, the pending entry stays on disk; retrying its request id is safe.
    await saveJournal(path, own, journal)
    return { reply: visible(entry), accepted: entry.status === 'sent' }
  })
}
