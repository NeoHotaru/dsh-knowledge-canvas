import assert from 'node:assert/strict'

let spec
globalThis.window = { __ModuleLoader__: { load: (value) => { spec = value } } }
const React = { createElement: () => ({}), Component: class {} }
await import('./client.js')
const { diaryPages } = spec.factory(() => React).__logic
const base = { id: 'diary-demo', nodes: [
  { id: 'root', title: '按月分组', body: '目录说明' },
  { id: 'month', parent: 'root', title: '2026 年 9 月', body: '' },
  { id: 'old', parent: 'month', title: '旧的一篇', body: '正文\n\n什么时候该想起它：下次下雨时', at: '2026-10-01 10:00', history: [{ at: '2026-09-20 09:00' }] },
  { id: 'new', title: '新的一篇', body: '![照片](assets/1234567890abcdef.png)\n\n[笔记](assets/1234567890abcdef.md)', at: '2026-10-02 08:00' },
  { id: 'gone', title: '已移除', change: 'removed', body: '不应出现在阅读器' },
  { id: 'loose', title: '无日期的日记', body: '<script>文字仍是文字</script>' },
] }
const before = JSON.stringify(base)
const pages = diaryPages(base)
assert.deepEqual(pages.map((page) => page.node.id), ['new', 'old', 'loose'])
assert.equal(pages[1].month, '2026-09')
assert.equal(pages[1].writtenAt, '2026-09-20 09:00')
assert.equal(pages[1].body, '正文')
assert.equal(pages[1].hint, '下次下雨时')
assert.equal(pages[0].body, base.nodes[3].body)
assert.equal(pages[2].month, '未注明月份')
assert.equal(JSON.stringify(base), before, 'reading never mutates diary storage')
assert.deepEqual(diaryPages({ nodes: [] }), [])
const cyclic = diaryPages({ nodes: [{ id: 'a', parent: 'b', title: 'A', body: 'A' }, { id: 'b', parent: 'a', title: 'B', body: 'B' }] })
assert.equal(cyclic.length, 2, 'malformed parent cycles do not hang reading')
console.log('notebook: grouping, creation dates, removed nodes, attachments, hints, empty/cyclic data and non-mutation passed')
