// Diary files are stored as ciphertext.
//
// The goal is narrow and worth stating plainly: a model that happens to look in `.dsh-knowledge/` must not be able to read
// somebody else's diary by opening the file. It is not a defence against an attacker who decides to run this code — the key
// is derived from the base id, which is on the file name, so anyone who reads the source can decrypt. That is the price of
// having no password and no unlock step, and it is the price the user asked for.
//
// One function pair, used by saveBase and loadBase: those are the only two places a base is written or read.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/** A diary base, by name: `diary-<hash>` (and the old single `diary`). */
export function isDiary(id) {
  return typeof id === 'string' && /^diary(-[a-z0-9]+)?$/.test(id)
}

function keyFor(id) {
  // Not secret material in any strong sense — it separates "read the file" from "read the diary". Named for what it is.
  return createHash('sha256').update('dsh-diary:' + id).digest()
}

/** Wrap a base as the text that goes on disk. */
export function seal(id, base) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(id), iv)
  const body = Buffer.concat([cipher.update(JSON.stringify(base), 'utf8'), cipher.final()])
  return JSON.stringify({
    sealed: 'aes-256-gcm',
    // The base id in the clear: the file name already says it, and the panel needs it to know which row this is.
    // What is hidden is the content, not the name.
    baseId: id,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64'),
  }, null, 2) + '\n'
}

/** True when this text is a sealed base rather than a plain one. */
export function isSealed(text) {
  try {
    const parsed = JSON.parse(text)
    return Boolean(parsed && parsed.sealed === 'aes-256-gcm' && typeof parsed.data === 'string')
  } catch {
    return false
  }
}

/** Read a sealed base back. The id is needed because the key is derived from it. */
export function open(id, text) {
  const parsed = JSON.parse(text)
  const decipher = createDecipheriv('aes-256-gcm', keyFor(id), Buffer.from(parsed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'))
  const plain = Buffer.concat([decipher.update(Buffer.from(parsed.data, 'base64')), decipher.final()])
  return JSON.parse(plain.toString('utf8'))
}
