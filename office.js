/**
 * Text out of an Office file, without adding a dependency.
 *
 * A .docx/.xlsx/.pptx is a zip of XML. Reading it means reading the zip's central directory and inflating the parts that hold
 * text — about sixty lines — which is cheaper than pulling in a package for the three formats that matter here.
 *
 * What comes out is rough on purpose: the point is that a note's attachment is readable in one read, not that the layout
 * survives. Tables become rows separated by " | ", paragraphs become lines.
 */
import { inflateRawSync } from 'node:zlib'

/** The entries of a zip, as { name → bytes }. Missing or malformed files come back empty rather than throwing. */
function unzip(buffer) {
  const entries = new Map()
  // End of central directory: signature 0x06054b50, somewhere in the last 64 KB (a comment may follow it).
  let eocd = -1
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 65558); at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      eocd = at
      break
    }
  }
  if (eocd < 0) return entries

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)

  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)

    if (localOffset + 30 <= buffer.length && buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localName = buffer.readUInt16LE(localOffset + 26)
      const localExtra = buffer.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localName + localExtra
      const raw = buffer.subarray(start, start + compressedSize)
      try {
        entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw))
      } catch {
        // A part this reader cannot inflate is simply absent; the rest of the document is still worth returning.
      }
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }

function plain(xml) {
  return String(xml)
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, (found) => entities[found] || found)
    // Chinese (and anything else outside ASCII) is written as numeric references: &#22995; or &#x59d3;.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** Word: one line per paragraph, cells of a row joined with " | ". */
function fromDocx(entries) {
  const xml = entries.get('word/document.xml')
  if (!xml) return ''
  const text = xml.toString('utf8')
  const lines = []
  for (const paragraph of text.split(/<w:p[ >]/)) {
    const cells = [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => plain(match[1]))
    const line = cells.filter((cell) => cell.length > 0).join(' | ')
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

/** PowerPoint: one block per slide, in slide order. */
function fromPptx(entries) {
  const slides = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))
  const out = []
  for (const name of slides) {
    const cells = [...entries.get(name).toString('utf8').matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) => plain(match[1]))
    const text = cells.filter((cell) => cell.length > 0).join(' ')
    if (text) out.push('[' + /(\d+)/.exec(name)[1] + '] ' + text)
  }
  return out.join('\n')
}

/** Excel: shared strings decoded once, then each sheet's rows joined with " | ". */
function fromXlsx(entries) {
  const shared = []
  const table = entries.get('xl/sharedStrings.xml')
  if (table) {
    for (const item of table.toString('utf8').split('<si>').slice(1)) {
      const cells = [...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => plain(match[1]))
      shared.push(cells.join(''))
    }
  }
  const sheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()
  const out = []
  for (const name of sheets) {
    out.push('# ' + name.replace('xl/worksheets/', '').replace('.xml', ''))
    for (const row of entries.get(name).toString('utf8').split('<row').slice(1)) {
      const cells = [...row.matchAll(/<c[^>]*?(?:\st="([^"]+)")?[^>]*>([\s\S]*?)<\/c>/g)].map((match) => {
        const kindMatch = /\st="([^"]+)"/.exec(match[0])
        const kind = kindMatch ? kindMatch[1] : ''
        // A string cell is written one of two ways: a reference into sharedStrings, or the text inline. Readers that only
        // handle the first lose every label in a sheet written by the second.
        if (kind === 'inlineStr') {
          const inner = [...match[2].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => plain(part[1]))
          return inner.join('')
        }
        const value = /<v>([\s\S]*?)<\/v>/.exec(match[2])
        if (!value) return ''
        return kind === 's' ? (shared[Number(value[1])] || '') : value[1]
      })
      const line = cells.filter((cell) => String(cell).length > 0).join(' | ')
      if (line) out.push(line)
    }
  }
  return out.join('\n')
}

/**
 * The text of an Office file, or null when this reader does not know the format.
 *
 * @param {string} name file name, used only for its extension
 * @param {Buffer} bytes the file
 * @returns {string|null}
 */
export function officeText(name, bytes) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name || ''))
  const ext = match ? match[1].toLowerCase() : ''
  if (!['docx', 'xlsx', 'pptx'].includes(ext)) return null
  const entries = unzip(bytes)
  if (entries.size === 0) return null
  if (ext === 'docx') return fromDocx(entries)
  if (ext === 'xlsx') return fromXlsx(entries)
  return fromPptx(entries)
}
