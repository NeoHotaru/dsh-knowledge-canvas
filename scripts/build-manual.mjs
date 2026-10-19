// 把教程渲染成一份纯手册。
//
// 教程装在知识库里，需要打开面板、点开节点才能读；有人只想"给我一份能从头读到尾的文档"。同一份内容，两种形态：
// 这里生成 MANUAL.md，而且 `check-manual.mjs` 会比对它和 lib/seed.js 是否一致 —— 手写两份必然漂，生成的那份不会。

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// One level up: this file lives in scripts/, the seed in lib/. The manual is written next to package.json.
const here = dirname(dirname(fileURLToPath(import.meta.url)))
const seedPath = join(here, 'lib', 'seed.js')
const manualPath = join(here, 'MANUAL.md')

// The seed is the source of truth; nothing here restates its content.
const { SEED_NODE_IDS } = await import(pathToFileURL(seedPath).href)

// Read the node list out of the module without exporting it: `NODES` is internal on purpose.
const source = (await readFile(seedPath, 'utf-8')).replace(/\r\n/g, '\n')
const start = source.indexOf('const NODES = [')
const end = source.indexOf('\n]\n', start)
const literal = source.slice(start + 'const NODES = '.length, end + 2)
const nodes = await import(
  'data:text/javascript;base64,' + Buffer.from('export default ' + literal, 'utf8').toString('base64')
).then((module) => module.default)

const title = nodes.find((node) => !node.parent) ?? nodes[0]
const byParent = new Map()
for (const node of nodes) {
  const parent = node.parent ?? null
  if (!byParent.has(parent)) byParent.set(parent, [])
  byParent.get(parent).push(node)
}
// Ordered by number, not by insertion: the prose refers to nodes by id ("见 n3"), so a reader who follows those
// references has to find them in that order.
for (const children of byParent.values()) {
  children.sort((a, b) => Number(a.id.replace(/[^0-9]/g, '')) - Number(b.id.replace(/[^0-9]/g, '')))
}

const ordered = []
const walk = (parent, depth) => {
  for (const node of byParent.get(parent) ?? []) {
    ordered.push({ node, depth })
    walk(node.id, depth + 1)
  }
}
walk(title.id, 1)

const slug = (node) => node.id.toLowerCase()

const lines = []
lines.push('# 使用手册')
lines.push('')
lines.push('> 这份文档由 `lib/seed.js` 生成，和装进知识库的教程是同一份内容。改动请改那份源，再运行 `node scripts/build-manual.mjs`。')
lines.push('')
lines.push('## 目录')
lines.push('')
for (const { node, depth } of ordered) {
  lines.push('  '.repeat(depth - 1) + '- [' + node.title + '](#' + slug(node) + ')')
}
lines.push('')
for (const { node, depth } of ordered) {
  lines.push('#'.repeat(Math.min(6, depth + 1)) + ' ' + node.title + ' <a id="' + slug(node) + '"></a>')
  lines.push('')
  lines.push(String(node.body ?? '').replace(/「什么时候该想起它:」/g, '**什么时候该想起它**:'))
  lines.push('')
}

await writeFile(manualPath, lines.join('\n'), 'utf-8')
console.log('  MANUAL.md: ' + ordered.length + ' 节, ' + Buffer.byteLength(lines.join('\n'), 'utf8') + ' 字节')
console.log('  节点 id: ' + SEED_NODE_IDS.length + ' 个')
