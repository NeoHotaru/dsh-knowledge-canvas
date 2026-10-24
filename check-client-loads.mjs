// Load the client half exactly the way the app does, and fail on anything it throws.
//
// This exists because the worst failure this file has produced was invisible to every other
// check. A module-scope `const` read before its declaration is a temporal-dead-zone error, and
// it throws while the module is being evaluated: the whole bundle fails, no tab registers, and
// the pane silently falls back to its start page. `node --check` sees perfectly valid syntax,
// and the scope check sees no name from the wrong component. Both were green while the feature
// was gone from the UI.
//
// Run: node check-client-loads.mjs

import { readFileSync } from 'node:fs'

let spec
globalThis.window = {
  __ModuleLoader__: {
    load(candidate) {
      spec = candidate
    },
  },
}

// React is only used for createElement and for extending Component at this stage — components
// are defined, not called — so a minimal stand-in is enough. The real one is used when it is
// reachable. `Component` has to exist as a constructor: an error boundary is declared with
// `class X extends React.Component`, and a stub without it makes the factory throw for a reason
// that has nothing to do with the code under test.
let React
try {
  React = (await import('react')).default
} catch {
  React = {
    createElement: () => ({}),
    Fragment: 'Fragment',
    Component: class Component {
      constructor(props) {
        this.props = props
      }
    },
  }
}

await import(new URL('./client.js', import.meta.url))

const problems = []
if (!spec) problems.push('the module never called window.__ModuleLoader__.load')
const packageName = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).name
if (spec && spec.id !== packageName) {
  problems.push(`unexpected loader id: ${spec && spec.id}`)
}

let client
if (spec && typeof spec.factory === 'function') {
  try {
    client = spec.factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require("${name}")`)
    })
  } catch (error) {
    problems.push(`the factory threw while evaluating module scope: ${error && error.message}`)
  }
} else if (spec) {
  problems.push('the loader spec has no factory')
}

// apply() is where the tab type and its two slots get registered. Running it with a fake
// context is the closest thing to opening the panel without a browser.
const registered = []
if (client && typeof client.apply === 'function') {
  const ctx = {
    remote: {},
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    sidebarRightTabs: {
      register(definition) {
        registered.push(['tab', definition && definition.id])
        return () => {}
      },
    },
    slots: {
      inject(name, fn) {
        return fn()
      },
      register(options, component) {
        registered.push([options && options.name, options && options.key, typeof component])
        return () => {}
      },
    },
  }
  try {
    client.apply(ctx)
  } catch (error) {
    problems.push(`apply() threw: ${error && error.message}`)
  }
} else if (client) {
  problems.push('the client half exports no apply()')
}

if (client && Array.isArray(client.inject)) {
  for (const key of ['slots', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles']) {
    if (!client.inject.includes(key)) problems.push(`inject is missing "${key}"`)
  }
} else if (client) {
  problems.push('the client half declares no inject list')
}

const kinds = registered.map((entry) => entry[0])
for (const expected of ['tab', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
  if (!kinds.includes(expected)) problems.push(`apply() never registered "${expected}"`)
}

// --- link geometry ------------------------------------------------------------
// "Does this line run through a box, and if so how far must it bow to miss it" cannot be judged
// from a screenshot: a wrong answer looks like a line that is slightly off, not like a failure.
if (client && client.__geometry) {
  const {
    segmentHitsBox, curveHitsBox, linkControlPoint, routeLink, anchorsOf, bestLink, edgeFades,
    edgeStroke, centreOf, edgePoint, routeKeyOf, BOX_W, BOX_H,
  } = client.__geometry

  // Hover spotlight: with nothing under the pointer nothing fades, and the hovered node's own
  // edges must never fade — that failure looks like "the highlight does nothing".
  if (edgeFades(null, 'a', 'b')) {
    problems.push('spotlight: edges fade with nothing under the pointer')
  }
  if (!edgeFades('a', 'b', 'c')) {
    problems.push('spotlight: an unrelated edge stays lit')
  }

  // Zoomed out, the edges are the structure, and a constant translucent grey turned them into a smudge: at 31%
  // they were a third of a pixel wide at 42% opacity, which reads as cards scattered on a background rather
  // than as a graph. So the weight is fixed in screen pixels (`vector-effect`) and the contrast rises as the
  // canvas shrinks. What must hold is the shape of that curve — a step or an inversion would look like a bug
  // on screen, and neither is visible in a screenshot.
  if (typeof edgeStroke === 'function') {
    const alpha = (k) => Number(/rgba\(128,128,128,([\d.]+)\)/.exec(edgeStroke(k))?.[1])
    const far = alpha(0.12)
    const near = alpha(1)
    const middle = alpha(0.34)
    if (!(near > 0 && near < 1)) problems.push('edgeStroke: near zoom is not a usable alpha: ' + edgeStroke(1))
    if (!(far > 0 && far < 1)) problems.push('edgeStroke: far zoom is not a usable alpha: ' + edgeStroke(0.12))
    if (!(far > near)) problems.push('edgeStroke: zooming out does not increase contrast')
    if (!(middle > near && middle < far)) problems.push('edgeStroke: the midpoint is not between the ends')
    // Monotone across the whole range: the colour must never get lighter as the canvas gets smaller.
    let previous = alpha(3)
    for (let k = 2.9; k >= 0.05; k -= 0.05) {
      const current = alpha(k)
      if (current < previous - 1e-9) {
        problems.push('edgeStroke: contrast drops while zooming out, at k=' + k.toFixed(2))
        break
      }
      previous = current
    }
    // And it stays put past the ends of the range rather than drifting.
    if (alpha(0.01) !== far) problems.push('edgeStroke: below the zoom floor drifts past the far end')
    if (alpha(9) !== near) problems.push('edgeStroke: above the detail threshold drifts past the near end')
  } else {
    problems.push('edgeStroke: missing from __geometry, so the edge contrast curve cannot be checked')
  }

  // The edge routing is memoised on a string, because it is quadratic in the node count and must not run on
  // a pan frame — and a memo keyed on the objects would never hit, since `ordered` and `placed` are rebuilt
  // every render. The entire safety of that memo is this function: **if it omits an input, the edges are
  // drawn where things used to be, and nothing reports it.**
  //
  // So the property to assert is not "the key is stable" but "every input moves it". Change one thing at a
  // time; each must produce a different string.
  if (typeof routeKeyOf === 'function') {
    const two = [
      { id: 'a', parent: '', x: 0, y: 0, w: 100, h: 40 },
      { id: 'b', parent: 'a', x: 0, y: 60, w: 100, h: 40 },
    ]
    const oneLink = [{ from: 'a', to: 'b' }]
    const reference = routeKeyOf(two, null, oneLink, [])
    const changes = [
      ['a node moves', routeKeyOf([{ ...two[0], x: 1 }, two[1]], null, oneLink, [])],
      ['a node resizes', routeKeyOf([{ ...two[0], w: 101 }, two[1]], null, oneLink, [])],
      ['a node is reparented', routeKeyOf([two[0], { ...two[1], parent: '' }], null, oneLink, [])],
      ['a node is added', routeKeyOf(two.concat([{ id: 'c', parent: '', x: 0, y: 0, w: 9, h: 9 }]), null, oneLink, [])],
      ['a node loses its position', routeKeyOf([{ ...two[0], x: null }, two[1]], null, oneLink, [])],
      ['a link is drawn', routeKeyOf(two, null, oneLink.concat([{ from: 'b', to: 'a' }]), [])],
      ['a link is dropped', routeKeyOf(two, null, [], [])],
      // The note does not move the curve, but the click target carries it into the editor — so a key that
      // ignored it would hand the editor a stale note. This is the assertion that caught exactly that.
      ['a note is written', routeKeyOf(two, null, [{ from: 'a', to: 'b', note: 'why' }], [])],
      ['a note is changed', routeKeyOf(two, null, [{ from: 'a', to: 'b', note: 'other' }], [])],
      ['a drag starts', routeKeyOf(two, { from: 'a', x: 5, y: 5 }, oneLink, [])],
      ['a drag moves', routeKeyOf(two, { from: 'a', x: 6, y: 5 }, oneLink, [])],
      ['a second drag starts', routeKeyOf(two, { from: 'b', x: 5, y: 5 }, oneLink, [])],
      ['a link becomes unsaved', routeKeyOf(two, null, oneLink, ['a>b'])],
    ]
    for (const [what, value] of changes) {
      if (value === reference) problems.push('routeKey: ' + what + ' leaves the key unchanged')
    }
    // And the other direction: the same inputs must give the same key, or the memo never hits.
    if (routeKeyOf(two, null, oneLink, []) !== reference) {
      problems.push('routeKey: the same inputs give a different key')
    }
  } else {
    problems.push('routeKey: __geometry.routeKeyOf is missing, so the routing memo cannot be checked')
  }
  if (edgeFades('a', 'a', 'c') || edgeFades('a', 'c', 'a')) {
    problems.push('spotlight: an edge attached to the hovered node fades')
  }

  // The history card's diff. Without it the card prints two full bodies and leaves the reader to compare —
  // and the asymmetry is the problem: an addition is visible because the text got longer, while a deletion
  // means noticing an absence inside a wall of text. So the assertions that matter are not "does it colour the
  // right line" but the two invariants that make a diff trustworthy at all: it must not lose a line, and it
  // must not invent one.
  if (client.__logic && typeof client.__logic.diffLines === 'function') {
    const diffLines = client.__logic.diffLines
    const kinds = (rows) => rows.map((row) => row.kind).join()
    const texts = (rows) => rows.map((row) => row.text).join('|')

    const addOne = diffLines('a\nb', 'a\nb\nc')
    if (texts(addOne.next) !== 'a|b|c') problems.push('diff: an addition lost or reordered a line')
    if (kinds(addOne.next) !== 'same,same,added') problems.push('diff: an addition is marked wrong: ' + kinds(addOne.next))
    if (kinds(addOne.old) !== 'same,same') problems.push('diff: an addition changed the old side: ' + kinds(addOne.old))

    const dropOne = diffLines('a\nb\nc', 'a\nc')
    if (kinds(dropOne.old) !== 'same,removed,same') problems.push('diff: a deletion is marked wrong: ' + kinds(dropOne.old))
    if (kinds(dropOne.next) !== 'same,same') problems.push('diff: a deletion changed the new side: ' + kinds(dropOne.next))

    const reword = diffLines('a\nold\nc', 'a\nnew\nc')
    if (kinds(reword.old) !== 'same,removed,same') problems.push('diff: a rewrite lost the old line')
    if (kinds(reword.next) !== 'same,added,same') problems.push('diff: a rewrite lost the new line')

    const none = diffLines('a\nb', 'a\nb')
    if (/added|removed/.test(kinds(none.old) + kinds(none.next))) {
      problems.push('diff: identical text reports a change')
    }

    // Which version each kept version is compared against. This is the rule that was wrong, and wrong in the
    // one place that matters: every entry was compared against the entry *below* it, but the newest entry is
    // replaced by the node itself — and the entry below it is often one written before the store kept contents,
    // with no body at all. So the comparison silently produced nothing, and the reader who asked to see a
    // deletion saw no red at all. Nothing reported it, because nothing could reach inside the `.map`.
    const historyMarks = client.__logic.historyMarks
    if (typeof historyMarks === 'function') {
      // The newest kept version must be compared against the node, so its deletions are found.
      const newest = historyMarks([{ at: '2', body: 'a\nb\nc' }], 'a\nc')
      if (!newest[0].lines) {
        problems.push('marks: the newest kept version is not compared against the node itself')
      } else if (!newest[0].lines.some((row) => row.kind === 'removed' && row.text === 'b')) {
        problems.push('marks: the newest version loses no line when one was deleted')
      }
      // An older entry is compared against the entry above it, which is the version that replaced it.
      const second = historyMarks([{ at: '2', body: 'a\nb\nc' }, { at: '1', body: 'a\nb\nc\nd' }], 'a\nc')
      if (!second[1].lines || !second[1].lines.some((row) => row.kind === 'removed' && row.text === 'd')) {
        problems.push('marks: an older version is not compared against the one that replaced it')
      }
      // An entry with no content, or nothing to compare against, gives null — never an empty array pretending a
      // comparison happened, because the card renders those two the same and they are not the same.
      const noContent = historyMarks([{ at: '2' }, { at: '1', body: 'a' }], 'a')
      if (noContent[0].lines !== null) problems.push('marks: a version with no content claims a comparison')
      if (noContent[1].lines !== null) problems.push('marks: a version with nothing after it claims a comparison')
      if (historyMarks([], 'a').length !== 0) problems.push('marks: no history gives rows')
    } else {
      problems.push('historyMarks: missing from __logic, so the version pairing cannot be checked')
    }

    // card must not mark them. The first real use proved why: the only deletion between the two versions of
    // `o17` was a single empty line, so the card announced "红色是之后被删掉的" and pointed at a red line with
    // nothing on it. A mark that points at nothing spends the reader's attention and returns nothing.
    const worthMarking = client.__logic.worthMarking
    if (typeof worthMarking === 'function') {
      if (!worthMarking({ kind: 'added', text: 'real' })) problems.push('mark: a real added line is not marked')
      if (!worthMarking({ kind: 'removed', text: 'real' })) problems.push('mark: a real removed line is not marked')
      if (worthMarking({ kind: 'added', text: '   ' })) problems.push('mark: a blank line is marked as a change')
      if (worthMarking({ kind: 'removed', text: '' })) problems.push('mark: an empty line is marked as a change')
      if (worthMarking({ kind: 'same', text: 'real' })) problems.push('mark: an unchanged line is marked')
      // The shape that produced the complaint: a blank line added or dropped between two paragraphs. The diff
      // reports it, and nothing may be coloured for it.
      for (const [before, after] of [['a\n\nb', 'a\nb'], ['a\nb', 'a\n\n\nb'], ['a\n\n\n', 'a\n']]) {
        const result = diffLines(before, after)
        const markedCount = result.old.filter(worthMarking).length + result.next.filter(worthMarking).length
        if (markedCount !== 0) {
          problems.push('mark: a whitespace-only edit marks ' + markedCount + ' line(s) for ' + JSON.stringify([before, after]))
        }
      }
    } else {
      problems.push('worthMarking: missing from __logic, so the blank-line rule cannot be checked')
    }

    // Whitespace is all that folds — nothing folds, in fact. A line that differs by one visible character is
    // still a change, and this is the assertion that stops the rule above from becoming "ignore whitespace".
    const trailing = diffLines('a\nb', 'a\nb ')
    if (!/added/.test(kinds(trailing.next)) || !/removed/.test(kinds(trailing.old))) {
      problems.push('diff: a trailing space is treated as no change at all')
    }

    // The invariants, over the shapes a real body takes: a paragraph appended, one removed, edits at both ends
    // at once, and the empty cases.
    const cases = [
      ['a\nb\nc\nd\ne\nf', 'a\nb\nc\nd\ne\nf\ng'],
      ['a\nb\nc\nd\ne\nf', 'a\nc\nd\ne\nf'],
      ['a\nb\nc\nd\ne\nf', 'z\na\nb\nc\nd\ne\nf\ny'],
      ['', 'a\nb'],
      ['a\nb', ''],
      ['a\nb\nc', 'a\nx\nc'],
      ['same\nsame', 'same\nsame'],
    ]
    for (const [before, after] of cases) {
      const result = diffLines(before, after)
      // Every line of each side appears exactly once on that side, whatever its mark. Counting only the
      // unmarked ones was the first version of this assertion and it was simply wrong: an added line is part of
      // the new text, so excluding it undercounts by exactly the number of additions.
      if (result.old.length !== before.split('\n').length) {
        problems.push('diff: the old side lost or invented a line (' + before.split('\n').length + ' in, ' + result.old.length + ' out)')
      }
      if (result.next.length !== after.split('\n').length) {
        problems.push('diff: the new side lost or invented a line (' + after.split('\n').length + ' in, ' + result.next.length + ' out)')
      }
      // And the text on each side is that side's text, in order, verbatim.
      if (texts(result.old) !== before.split('\n').join('|')) problems.push('diff: the old side is not the old text')
      if (texts(result.next) !== after.split('\n').join('|')) problems.push('diff: the new side is not the new text')
      // Only `old` may carry `removed` and only `next` may carry `added`; a line cannot be both.
      if (result.old.some((row) => row.kind === 'added')) problems.push('diff: the old side claims an addition')
      if (result.next.some((row) => row.kind === 'removed')) problems.push('diff: the new side claims a deletion')
      // Whatever stayed must be the same text on both sides, or the two halves cannot be read as one change.
      // Compared after trimming, because blank lines fold together whatever their whitespace — the text can
      // differ by invisible characters and still be the same line.
      const stable = (rows) => rows.filter((row) => row.kind === 'same').map((row) => row.text.trim()).join('|')
      if (stable(result.old) !== stable(result.next)) {
        problems.push('diff: the two sides disagree about what stayed the same')
      }
    }
  } else {
    problems.push('diffLines: missing from __logic, so the history diff cannot be checked')
  }
  // Boxes carry their own size now. Passing bare corners here made every value NaN, the slab
  // comparisons all false, and the function happened to return "hit" — so these assertions
  // passed while testing nothing. A box without a size is not a box.
  const box = (x, y, w = BOX_W, h = BOX_H) => ({ x, y, w, h })

  const clear = [box(0, 0), box(0, 400)]
  if (segmentHitsBox(clear[0], clear[1], box(300, 150))) {
    problems.push('geometry: a line well clear of a box was reported as hitting it')
  }
  if (!segmentHitsBox(clear[0], clear[1], box(-BOX_W / 2, 150))) {
    problems.push('geometry: a line straight through a box was reported as missing it')
  }
  if (segmentHitsBox(box(0, 0), box(10, 0), box(0, 50))) {
    problems.push('geometry: a parallel line outside the slab was reported as hitting')
  }
  // The reported bug: the dashed line began under the text instead of at the border, because the
  // exit point was computed on an assumed height while the node had wrapped to two lines.
  const tall = box(0, 0, BOX_W, BOX_H + 20)
  const below = { x: tall.x + tall.w / 2, y: tall.y + 400 }
  const exit = edgePoint(tall, below)
  if (Math.abs(exit.y - (tall.y + tall.h)) > 1e-6) {
    problems.push(`geometry: the exit point toward a node below is at y=${exit.y}, expected the measured bottom edge ${tall.y + tall.h}`)
  }
  const shortBox = box(0, 0, BOX_W, BOX_H)
  if (Math.abs(edgePoint(shortBox, below).y - (shortBox.y + BOX_H)) > 1e-6) {
    problems.push('geometry: the exit point ignores the box it was given')
  }
  // Toward a neighbour to the right it must leave through the right edge, at the box's own middle.
  const beside = { x: tall.x + 400, y: tall.y + tall.h / 2 }
  const sideExit = edgePoint(tall, beside)
  if (Math.abs(sideExit.x - (tall.x + tall.w)) > 1e-6 || Math.abs(sideExit.y - (tall.y + tall.h / 2)) > 1e-6) {
    problems.push('geometry: the sideways exit point is not on the right edge at the box middle')
  }

  // The bug that shipped: the route was computed from the straight chord, so the bow swung the
  // line into the neighbour of the box it was avoiding. The curve has to be tested as a curve.
  // Vertical link down the left, a box on the chord, and a second box sitting to its left — right
  // where the bow would swing.
  const start = { x: 200, y: 0 }
  const end = { x: 200, y: 400 }
  const onChord = box(112, 150)
  const toTheLeft = box(-40, 150)
  const control = routeLink(start, end, [onChord, toTheLeft])
  if (curveHitsBox(start, control, end, onChord)) {
    problems.push('geometry: the routed curve still runs through the box on the chord')
  }
  if (curveHitsBox(start, control, end, toTheLeft)) {
    problems.push('geometry: the routed curve swings into the box beside the one it avoided')
  }
  // A box close to an endpoint cannot be cleared without an absurd bow — a quadratic keeps only
  // 2t(1-t) of its control offset out there. What the router must guarantee is therefore not
  // "clears everything" but "never worse than the single analytic offset it started from".
  const nearStart = box(112, 20)
  const nearStartRoute = routeLink(start, end, [nearStart])
  const single = linkControlPoint(start, end, [nearStart])
  const count = (control) => [nearStart].filter((box) => curveHitsBox(start, control, end, box)).length
  if (count(nearStartRoute) > count(single)) {
    problems.push('geometry: routing made an endpoint graze worse than the single-shot offset')
  }
  // A box in the middle, which is the case that actually shows up, must come out clear.
  const middle = box(112, 170)
  if (curveHitsBox(start, routeLink(start, end, [middle]), end, middle)) {
    problems.push('geometry: the curve runs through a box in the middle of the chord')
  }

  // The reported case, and the one the whole anchor search exists for: a source with a target
  // straight below it and two boxes stacked in between. Anchoring where the centre-to-centre line
  // crosses the border pins the arrival to the top edge, so the link has to come down through both
  // — which is what the user kept seeing. Choosing the attachment points makes it a straight line
  // down open canvas to the right of them.
  const srcAbove = box(224, 100)
  const tgtBelow = box(235, 450)
  const stack1 = box(224, 286)
  const stack2 = box(224, 378)
  const routed2 = bestLink(srcAbove, tgtBelow, [stack1, stack2])
  if (routed2.crossed !== 0) {
    problems.push(`geometry: a stacked pair between source and target was not avoided (${routed2.crossed} crossed)`)
  }
  if (routed2.bow > 0.5) {
    problems.push(`geometry: the clean way round a stacked pair needed a bow of ${routed2.bow.toFixed(1)}, expected a straight line`)
  }
  // It must arrive on one of the four edge midpoints, not somewhere invented.
  if (!anchorsOf(tgtBelow).some((point) => Math.abs(point.x - routed2.end.x) < 1e-6 && Math.abs(point.y - routed2.end.y) < 1e-6)) {
    problems.push('geometry: the arrival point is not one of the four edge midpoints')
  }
  if (curveHitsBox(routed2.start, routed2.control, routed2.end, stack1)
    || curveHitsBox(routed2.start, routed2.control, routed2.end, stack2)) {
    problems.push('geometry: the chosen attachment pair still runs through the stacked boxes')
  }

  // With nothing in the way it must stay a straight line.
  const nothing = routeLink(start, end, [])
  if (Math.hypot(nothing.x - 200, nothing.y - 200) > 1e-6) {
    problems.push('geometry: routing with a clear canvas produced a curve')
  }
  if (curveHitsBox(start, nothing, end, box(400, 150))) {
    problems.push('geometry: a straight route was reported as crossing a box well to the side')
  }

  // A taller box than the default must be hit by a line the default-height box would have missed.
  if (!segmentHitsBox(clear[0], clear[1], box(-BOX_W / 2, 390, BOX_W, 100))) {
    problems.push('geometry: a tall box straddling the end of the line was reported as missing')
  }

  const straight = linkControlPoint(clear[0], clear[1], [])
  const mid = { x: (clear[0].x + clear[1].x) / 2, y: (clear[0].y + clear[1].y) / 2 }
  if (Math.abs(straight.x - mid.x) > 1e-6 || Math.abs(straight.y - mid.y) > 1e-6) {
    problems.push('geometry: with nothing in the way the control point is not the midpoint, so the "line" would bow for no reason')
  }

  // A quadratic's midpoint, which is where it deviates furthest — so it is where clearance has
  // to hold. `box()` is a top-left corner, not a centre: getting that wrong in the first version
  // of this check made a correct bow look like it still crossed the box.
  const curveMid = (a, b, control) => ({
    x: (a.x + 2 * control.x + b.x) / 4,
    y: (a.y + 2 * control.y + b.y) / 4,
  })
  const clears = (a, b, control, obstacle) => {
    const m = curveMid(a, b, control)
    const inside = m.x > obstacle.x && m.x < obstacle.x + BOX_W
      && m.y > obstacle.y && m.y < obstacle.y + BOX_H
    return !inside
  }

  const leftBlock = box(-BOX_W / 2, 150)
  const blocked = linkControlPoint(clear[0], clear[1], [leftBlock])
  if (Math.hypot(blocked.x - mid.x, blocked.y - mid.y) < 1) {
    problems.push('geometry: a box on the line produced no bow')
  }
  if (!clears(clear[0], clear[1], blocked, leftBlock)) {
    problems.push('geometry: the bowed curve still passes through the box it bowed for')
  }

  // An obstacle on the other side must send the bow the other way: with only one side occupied
  // there is no cheaper option to take.
  const rightBlock = box(BOX_W / 2, 150)
  const otherSide = linkControlPoint(clear[0], clear[1], [rightBlock])
  if (Math.sign(otherSide.x - mid.x) === Math.sign(blocked.x - mid.x)) {
    problems.push('geometry: obstacles on opposite sides produced a bow in the same direction')
  }
  if (!clears(clear[0], clear[1], otherSide, rightBlock)) {
    problems.push('geometry: the bow did not clear the box on that side')
  }

  // Both sides blocked: it has to pick one, and the nearer one — a box 60 away on the left beats
  // one 176 away on the right.
  const bothSides = linkControlPoint(clear[0], clear[1], [box(-BOX_W / 2 - 60, 150), rightBlock])
  if (Math.hypot(bothSides.x - mid.x, bothSides.y - mid.y) < 1) {
    problems.push('geometry: obstacles on both sides produced no bow at all')
  }
  if (bothSides.x >= mid.x) {
    problems.push('geometry: with both sides blocked it did not take the nearer (left) side')
  }
}

// --- the unread walk ----------------------------------------------------------
// The decision, not the button. A user reported that pressing "next" twice quit the walk: the trail
// loses an entry every time a node is acknowledged, while an index into it kept growing, so the index
// reached the end early — and skipped the node after each one it reviewed. This walks a list the way
// the button does and asserts that every node is visited exactly once, in order.
if (client && client.__logic && typeof client.__logic.nextUnread === 'function') {
  const { nextUnread } = client.__logic
  const trail = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((node) => ({ base: 'x', node }))
  const visited = []
  let current = null
  let remaining = trail.slice()
  for (let press = 0; press < 20; press += 1) {
    const target = nextUnread(remaining, current)
    if (!target) break
    visited.push(target.node)
    // Landing on a node acknowledges it, which is why the trail shrinks under the walk.
    remaining = remaining.filter((item) => item.node !== target.node)
    current = target.node
  }
  if (visited.join('') !== 'abcdefg') {
    problems.push(`walk: visited ${visited.join('') || '(nothing)'} instead of abcdefg`)
  }
  if (remaining.length !== 0) {
    problems.push(`walk: stopped with ${remaining.length} node(s) left unvisited`)
  }
  if (nextUnread([{ base: 'x', node: 'only' }], 'only') !== null) {
    problems.push('walk: with only the current node left it should return null')
  }
  if (nextUnread(null, null) !== null) {
    problems.push('walk: a missing trail should return null, not throw')
  }
}

// --- the adaptive width ---------------------------------------------------------
// The default width used to be a fixed 176, so a body of a few hundred characters wrapped into a thin
// column. It follows the content now, within bounds, and the height has to be counted at that width.
if (!client || !client.__logic || typeof client.__logic.estimateBox !== 'function') {
  problems.push('width: estimateBox is not exposed, so none of its tests ran')
} else {
  const { estimateBox } = client.__logic
  const short = estimateBox({ title: '短', body: '' })
  const long = estimateBox({ title: '长', body: 'x'.repeat(400) })
  const huge = estimateBox({ title: '巨', body: 'x'.repeat(20000) })

  if (short.w !== 176) problems.push('width: a short node should keep the floor, got ' + short.w)
  if (long.w <= short.w) problems.push('width: a longer body should widen the box, got ' + long.w)
  if (huge.w > 420) problems.push('width: the ceiling should hold, got ' + huge.w)
  if (short.h < 60) problems.push('width: a box should have a usable height, got ' + short.h)
  const perChar = huge.h / 20000
  if (perChar > 3) problems.push('width: the height looks counted at the wrong width, ' + perChar.toFixed(2) + 'px per char')
  if (!Number.isFinite(short.w) || !Number.isFinite(short.h)) problems.push('width: the estimate returned a non-number')
}

// --- search ---------------------------------------------------------------------
// In memory, so no route and no index; the parts that can be wrong are the matching and the snippet.
if (!client || !client.__logic || typeof client.__logic.searchBases !== 'function') {
  problems.push('search: searchBases is not exposed, so none of its tests ran')
} else {
  const { searchBases } = client.__logic
  const bases = [{
    id: 'demo',
    name: '演示',
    nodes: [
      { id: 'n1', parent: null, title: '落点决定连线', body: '正文里没有那个词' },
      { id: 'n2', parent: 'n1', title: '别的', body: '这里提到落点一次，后面还有很多字'.repeat(3) },
      { id: 'n3', parent: null, title: '无关', body: '完全无关' },
      { id: 'n4', parent: null, title: '落点', body: '', change: 'removed' },
    ],
  }]

  if (searchBases(bases, '').length !== 0) problems.push('search: an empty query should find nothing')
  if (searchBases(bases, '   ').length !== 0) problems.push('search: a blank query should find nothing')

  const hits = searchBases(bases, '落点')
  if (hits.length !== 2) problems.push('search: expected two hits, got ' + hits.length)
  if (hits[0].nodeId !== 'n1' || !hits[0].inTitle) problems.push('search: the title match should come first')
  if (hits[1].nodeId !== 'n2') problems.push('search: the body match should follow, got ' + JSON.stringify(hits.map((h) => h.nodeId)))
  if (!hits[1].snippet.includes('落点')) problems.push('search: the snippet should contain the match, got ' + hits[1].snippet)
  if (hits.some((hit) => hit.nodeId === 'n4')) problems.push('search: a removed node must not be offered')
  if (searchBases(bases, '落点').length !== 2) problems.push('search: both hits should be returned together')

  // Case-insensitivity, and a body with nothing to show.
  const latin = [{ id: 'x', name: 'x', nodes: [{ id: 'n1', parent: null, title: 'NPM RUN', body: '' }] }]
  if (searchBases(latin, 'npm run').length !== 1) problems.push('search: latin matching should ignore case')
  if (searchBases(latin, 'npm run')[0].snippet !== '') problems.push('search: a title-only hit has no snippet')
}

// --- markdown ------------------------------------------------------------------
// Parsed into data, so it can be asserted on without a DOM. The bodies in the knowledge base are
// markdown, and rendering them as plain text left the asterisks on screen.
if (!client || !client.__logic || typeof client.__logic.parseMarkdown !== 'function') {
  problems.push('markdown: parseMarkdown is not exposed, so none of its tests ran')
} else {
  const { parseMarkdown, inlineSpans } = client.__logic

  const flat = (blocks) => JSON.stringify(blocks)

  const paragraphs = parseMarkdown('第一段\n\n第二段')
  if (paragraphs.length !== 2 || paragraphs[0].type !== 'p' || paragraphs[1].text !== '第二段') {
    problems.push('markdown: a blank line should split paragraphs, got ' + flat(paragraphs))
  }

  const bold = inlineSpans('前 **重点** 后')
  if (bold.length !== 3 || bold[1].bold !== true || bold[1].text !== '重点') {
    problems.push('markdown: bold should be its own span, got ' + flat(bold))
  }

  const code = inlineSpans('用 \`npm run check\` 验证')
  if (code.length !== 3 || code[1].code !== true || code[1].text !== 'npm run check') {
    problems.push('markdown: inline code should be its own span, got ' + flat(code))
  }

  const fenced = parseMarkdown('说明\n\n\`\`\`\nconst a = 1;\nconst b = 2;\n\`\`\`\n\n结尾')
  const codeBlock = fenced.find((block) => block.type === 'code')
  if (!codeBlock || codeBlock.text !== 'const a = 1;\nconst b = 2;') {
    problems.push('markdown: a fenced block should keep its lines, got ' + flat(fenced))
  }
  if (fenced[fenced.length - 1].text !== '结尾') {
    problems.push('markdown: text after a fence should still parse, got ' + flat(fenced))
  }

  const listed = parseMarkdown('- 一\n- 二\n- 三')
  if (listed.length !== 1 || listed[0].type !== 'ul' || listed[0].items.length !== 3) {
    problems.push('markdown: bullets should form one list, got ' + flat(listed))
  }

  const ordered = parseMarkdown('1. 一\n2. 二')
  if (ordered.length !== 1 || ordered[0].type !== 'ol' || ordered[0].items[1] !== '二') {
    problems.push('markdown: numbered lines should form an ordered list, got ' + flat(ordered))
  }

  const mixed = parseMarkdown('- 一\n\n一段话')
  if (mixed.length !== 2 || mixed[0].type !== 'ul' || mixed[1].type !== 'p') {
    problems.push('markdown: a blank line should end a list, got ' + flat(mixed))
  }

  const unclosed = parseMarkdown('\`\`\`\nconst a = 1;')
  if (unclosed.length !== 1 || unclosed[0].type !== 'code') {
    problems.push('markdown: an unclosed fence should still show as code, got ' + flat(unclosed))
  }

  const plain = parseMarkdown('就是一句话')
  if (plain.length !== 1 || plain[0].type !== 'p' || inlineSpans('就是一句话').length !== 1) {
    problems.push('markdown: text without markers should be one plain paragraph, got ' + flat(plain))
  }

  const table = parseMarkdown('| 渠道 | 落盘 |\n|---|---|\n| 微信 | 是 |\n| QQ | 否 |')
  const tableBlock = table.find((block) => block.type === 'table')
  if (!tableBlock || tableBlock.head.length !== 2 || tableBlock.rows.length !== 2) {
    problems.push('markdown: a table should parse into a head and rows, got ' + flat(table))
  } else if (tableBlock.head[0] !== '渠道' || tableBlock.rows[1][0] !== 'QQ') {
    problems.push('markdown: table cells should be trimmed and split, got ' + flat(tableBlock))
  }

  // One pipe line is prose, not a table: without the separator row there is nothing to say it is one.
  const notTable = parseMarkdown('| 一行竖线 |')
  if (notTable.some((block) => block.type === 'table')) {
    problems.push('markdown: a lone pipe line must not become a table, got ' + flat(notTable))
  }
  // And the paragraph after a table still parses.
  const afterTable = parseMarkdown('| a |\n|---|\n| 1 |\n\n结尾')
  if (!afterTable.some((block) => block.type === 'p' && block.text === '结尾')) {
    problems.push('markdown: text after a table should still parse, got ' + flat(afterTable))
  }

  const broken = parseMarkdown('- 一\n- 二 **没闭合\n\n\`\`\`\n代码\n\`\`\`\n\n- 三')
  if (broken[0].type !== 'ul' || broken[0].items.length !== 2) {
    problems.push('markdown: a broken marker must not damage the list, got ' + flat(broken))
  }
  if (!broken.some((block) => block.type === 'code' && block.text === '代码')) {
    problems.push('markdown: a broken marker must not damage a code block, got ' + flat(broken))
  }
  if (broken[broken.length - 1].type !== 'ul' || broken[broken.length - 1].items[0] !== '三') {
    problems.push('markdown: text after a broken marker must still parse, got ' + flat(broken))
  }
  // A stray marker shows as text rather than swallowing the line.
  const stray = inlineSpans('**没闭合 还是文字')
  if (stray.length !== 1 || stray[0].text !== '**没闭合 还是文字' || stray[0].bold) {
    problems.push('markdown: an unclosed marker should stay literal, got ' + flat(stray))
  }
  // A lone asterisk is ordinary text; only a pair means bold.
  const lone = inlineSpans('2 * 3 = 6')
  if (lone.length !== 1 || lone[0].text !== '2 * 3 = 6') {
    problems.push('markdown: a single asterisk is just a character, got ' + flat(lone))
  }

  const empty = parseMarkdown('')
  if (empty.length !== 0) problems.push('markdown: an empty body should parse to nothing, got ' + flat(empty))
}

// The client names a session's file itself, because it reads the file directly rather than asking the host.
// That copy has to agree with the host's encoder, and an id containing a colon — every IM session — is
// exactly where it stopped agreeing: written as `im%3Aqq_…json`, read as `im:qq_…json`, and the panel
// reported a missing file for a list that was there all along.
//
// The function is not importable (it lives inside the client bundle's factory), so it is read out of the
// source and evaluated. That is fragile in the way a duplicate always is — which is why the comparison
// exists rather than a comment asking people to keep them in step.
{
  const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  const found = source.match(/function sessionFileName\(sessionId\) \{[\s\S]*?\n    \}/)
  if (!found) {
    problems.push('session file: sessionFileName is not in client.js any more')
  } else {
    // eslint-disable-next-line no-new-func
    const sessionFileName = new Function('sessionId', 'return (' + found[0] + ')(sessionId)')
    const { sessionFileStem } = await import('./lib/session.js')
    const ids = ['plain', 'session-266c1f1f-f062-46e9-8b2d-4cd4202308c7',
      'im:qq_ad251634eac6:dm:1791127482728:7F3A', '../evil', 'a b', '中文']
    for (const id of ids) {
      const mine = sessionFileName(id)
      const theirs = sessionFileStem(id)
      if (mine !== theirs) {
        problems.push(`session file: the panel would look for "${mine}" but the host writes "${theirs}"`)
      }
      // The property that actually matters: one path segment, whatever the id.
      if (/[\\/]/.test(mine)) problems.push(`session file: "${mine}" is more than one path segment`)
    }
  }
}

// The encoder can be perfect and the call site still wrong. It was: the panel built
// `.sessions/<stem>` and read it, and reported "读不到知识库" for a file that existed as `<stem>.json`.
// The unit was right and the wiring was not — so this asserts on the wiring, by reading the call site.
{
  const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
  const call = source.match(/DIR \+ '\/\.sessions\/' \+ [^,]+/)
  if (!call) {
    problems.push('session file: the panel no longer builds a session file path')
  } else if (!/\+ '\.json'/.test(call[0])) {
    problems.push('session file: the panel builds a path with no .json — ' + call[0])
  }
}

if (problems.length === 0) {
  console.log(`  ok   loaded and applied cleanly; registered ${registered.length} thing(s)`)
  process.exit(0)
}
console.log('  FAIL the client half does not load:')
for (const problem of problems) console.log('    - ' + problem)
process.exit(1)
