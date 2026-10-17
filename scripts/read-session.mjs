// A session transcript is zstd frames appended over time, and the decoders only hand back the first one.
// Each frame begins with the same four magic bytes, so split on those and decompress frame by frame.
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function readTranscript(path) {
  const raw = readFileSync(path)
  const starts = []
  let at = raw.indexOf(MAGIC)
  while (at !== -1) {
    starts.push(at)
    at = raw.indexOf(MAGIC, at + 4)
  }
  let text = ''
  let frames = 0
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : raw.length
    try {
      text += zstdDecompressSync(raw.subarray(from, to)).toString('utf8')
      frames += 1
    } catch {
      // A frame still being written, or a false magic inside compressed data: skip it.
    }
  }
  return { text, frames, magic: starts.length }
}

const path = process.argv[2]
const { text, frames, magic } = readTranscript(path)
const lines = text.split('\n').filter(Boolean)
console.log('  frames: %d of %d magic hits; lines: %d', frames, magic, lines.length)

const rows = []
for (const line of lines) {
  try { rows.push(JSON.parse(line)) } catch { /* truncated tail */ }
}
const kinds = new Map()
for (const row of rows) kinds.set(row.type, (kinds.get(row.type) || 0) + 1)
console.log('  types: %s', [...kinds].map(([k, n]) => k + '=' + n).join(' '))

// The assistant's own words: whatever field carries them, print the tail of the last few.
for (const row of rows.slice(-6)) {
  console.log('  --- %s: %s', row.type, JSON.stringify(row).slice(0, 700))
}
