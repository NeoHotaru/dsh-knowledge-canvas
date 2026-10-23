import assert from 'node:assert/strict'
let spec
globalThis.window = { __ModuleLoader__: { load: (s) => { spec = s } } }
await import('./client.js')
const { __geometry: g } = spec.factory(() => ({ createElement: () => ({}), Component: class {} }))
const { __logic: logic } = spec.factory(() => ({ createElement: () => ({}), Component: class {} }))
const longNote = logic.estimateBox({title:'长正文',body:'内容'.repeat(5000)})
const longerNote = logic.estimateBox({title:'长正文',body:'内容'.repeat(50000)})
assert.ok(longNote.h <= 400, 'a long automatic card fits within a sidebar view instead of stretching a whole layer')
assert.equal(longerNote.h,longNote.h,'more body text scrolls instead of increasing the automatic row height')
function original(a, control, b, box) {
  let previous = a
  for (let step = 1; step <= 12; step++) {
    const t = step / 12, u = 1 - t
    const point = { x: u*u*a.x + 2*u*t*control.x + t*t*b.x, y: u*u*a.y + 2*u*t*control.y + t*t*b.y }
    if (g.segmentHitsBox(previous, point, box)) return true
    previous = point
  }
  return false
}
let seed = 140273
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
const point = () => ({ x: rnd()*2000-1000, y: rnd()*2000-1000 })
for (let i = 0; i < 6000; i++) {
  const a = point(), control = point(), b = point(), box = { ...point(), w: rnd()*400, h: rnd()*400 }
  assert.equal(g.curveHitsBox(a, control, b, box), original(a, control, b, box), 'broad phase preserves collision: '+i)
}
assert.equal(g.curveHitsBox({x:0,y:0},{x:5,y:0},{x:10,y:0},{x:10,y:0,w:0,h:0}), true, 'touching a box still counts')
assert.equal(g.curveHitsBox({x:0,y:0},{x:50,y:100},{x:100,y:0},{x:45,y:45,w:10,h:10}), true, 'a bow crossing outside the chord is retained')
console.log('canvas collision broad phase: 6000 seeded comparisons, boundary contact and bowed crossing passed')

// Overview geometry must keep the configured width instead of the default estimate.
const overviewNote = { title: '需要完整展示而不能覆盖隔壁节点的很长标题'.repeat(3), body: '正文'.repeat(300) };
assert.equal(g.oneLineBox(overviewNote, 300).w, 300, 'base width survives title-only rendering');
assert.equal(g.oneLineBox(overviewNote, 480).w, 480, 'per-node width survives title-only rendering');
assert.ok(g.oneLineBox(overviewNote, 480).h < g.oneLineBox(overviewNote, 120).h, 'title wraps according to its effective width');
console.log('overview configured widths and title wrapping passed');
