import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { officeText } from './office.js'

/** Only references actually owned by this node can be read through the tool. */
export function attachmentPaths(node) {
  return [...new Set(String(node.body || '').match(/assets\/[a-f0-9]{16}\.[a-z0-9]{1,12}\b/g) || [])]
}

export function attachmentPage(cwd, node, path, offset = 0, limit = 8000) {
  if (!attachmentPaths(node).includes(path)) throw new Error('attachment must be an asset path referenced by this node')
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer')
  if (!Number.isInteger(limit) || limit < 1 || limit > 8000) throw new Error('limit must be an integer between 1 and 8000')
  const absolute = join(cwd, '.dsh-knowledge', path)
  const bytes = readFileSync(absolute)
  const text = /\.(md|txt|log|csv|json|yaml|yml|toml|ini|conf|lock|diff|patch|sql|html|css|xml|js|mjs|ts|py|go|rs|java|sh)$/i.test(path)
    ? bytes.toString('utf8') : officeText(path, bytes)
  if (text === null) return absolute + '\nText extraction is unavailable for this format; use a suitable file reader.'
  if (offset > text.length) throw new Error('offset exceeds attachment text length: ' + text.length)
  const end = Math.min(offset + limit, text.length)
  return path + ' — characters ' + offset + '..' + end + ' of ' + text.length + '\n'
    + text.slice(offset, end) + (end < text.length ? '\nContinue with knowledge_read attachment=' + path + ' offset=' + end : '\n(end of attachment)')
}
