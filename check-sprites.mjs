// Every sprite has to match the shape the panel assumes, or it renders squashed.
//
// This is the check that was missing when three strips came out as 3x2 grids while the client drew one row of six: the
// numbers in the client were right, the files were wrong, and nothing compared the two. Width/height equals the frame
// count for a single-row strip, and 5/3 for the grid sheet.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/DeepSeekHarness/dsh-knowledge-tree'
const ASSETS = join(ROOT, 'assets')

/** Read width and height from the PNG header: 8-byte signature, then IHDR. */
function sizeOf(path) {
  const buffer = readFileSync(path)
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG: ' + path)
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

// name, frames, rows — the last is 3 only for the 3x5 grid sheet.
const EXPECTED = [
  ['whale.png', 5, 3],
  ['whale-wave.png', 6, 1],
  ['whale-doze.png', 6, 1],
  ['whale-work.png', 6, 1],
  ['whale-eat.png', 6, 1],
]

const problems = []
for (const [name, frames, rows] of EXPECTED) {
  let size
  try {
    size = sizeOf(join(ASSETS, name))
  } catch (error) {
    problems.push(name + ': ' + error.message)
    continue
  }
  if (size.width % frames !== 0) {
    problems.push(name + ': width ' + size.width + ' is not ' + frames + ' frame(s) wide')
    continue
  }
  const frame = size.width / frames
  if (size.height !== frame * rows) {
    problems.push(name + ': ' + size.width + 'x' + size.height + ' should be ' + frames + 'x' + rows
      + ' frames of ' + frame + 'px, i.e. height ' + frame * rows)
  }
}

if (problems.length === 0) {
  console.log('  ok   every sprite is the shape the panel draws it as')
  process.exit(0)
}
console.log('  FAIL these sprites do not match the panel\'s assumptions:')
for (const problem of problems) console.log('    ' + problem)
process.exit(1)
