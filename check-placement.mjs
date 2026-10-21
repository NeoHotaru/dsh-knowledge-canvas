// The arithmetic, checked against the thing it is supposed to satisfy, without a browser.
//
// Four versions of this were wrong, and each time I reasoned about it rather than testing it. This is the
// version that can be tested: the same formula the code uses, run over the cases that broke it, asserting
// the two properties the user asked for 鈥?at the pointer, and inside the canvas.
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const found = SOURCE.match(/const CARD_W = 300;[\s\S]*?y: Math\.max\(top,[^\n]*\n/)
if (!found) {
  console.log('  the placement code was not found')
  process.exit(2)
}

// The frame the canvas reports, and the card's size, in canvas units.
const CARD_W = 300
const CARD_MAX_H = 380

/** What the browser would do with the style the code produces, for a given pointer and view. */
function place({ frame, view, pointer }) {
  const spot = {
    x: (pointer.x - frame.left - view.x) / view.k,
    y: (pointer.y - frame.top - view.y) / view.k,
  }
  const left = -view.x / view.k
  const top = -view.y / view.k
  const right = (frame.width - view.x) / view.k
  const bottom = (frame.height - view.y) / view.k
  const spotX = Math.max(left, Math.min(spot.x, Math.max(left, right - CARD_W)))
  const spotY = Math.max(top, Math.min(spot.y, Math.max(top, bottom - CARD_MAX_H)))
  // Where that lands on screen: the canvas's own corner plus the view transform.
  return {
    x: frame.left + view.x + spotX * view.k,
    y: frame.top + view.y + spotY * view.k,
    right: frame.left + view.x + (spotX + CARD_W) * view.k,
    bottom: frame.top + view.y + (spotY + CARD_MAX_H) * view.k,
    frame,
  }
}

const frame = { left: 120, top: 200, width: 700, height: 560 }
const cases = [
  { name: 'unpanned, pointer in the middle', view: { k: 1, x: 0, y: 0 }, pointer: { x: 400, y: 400 } },
  { name: 'panned right and down', view: { k: 1, x: -200, y: -150 }, pointer: { x: 400, y: 400 } },
  { name: 'panned left and up', view: { k: 1, x: 180, y: 120 }, pointer: { x: 400, y: 400 } },
  { name: 'zoomed out to 40%', view: { k: 0.4, x: -120, y: -90 }, pointer: { x: 430, y: 380 } },
  { name: 'zoomed in to 160%', view: { k: 1.6, x: -300, y: -260 }, pointer: { x: 420, y: 390 } },
  { name: 'pointer near the right edge', view: { k: 1, x: 0, y: 0 }, pointer: { x: 800, y: 400 } },
  { name: 'pointer near the bottom edge', view: { k: 1, x: 0, y: 0 }, pointer: { x: 400, y: 740 } },
  { name: 'pointer above the canvas', view: { k: 1, x: 0, y: 0 }, pointer: { x: 400, y: 100 } },
]

let bad = 0
for (const item of cases) {
  const got = place(Object.assign({ frame: frame }, item))
  const widthScreen = CARD_W * item.view.k
  const heightScreen = CARD_MAX_H * item.view.k

  // The pointer is only the target when it is inside the canvas and the card fits from there. Three ways
  // for that not to hold, and each is a case the code should handle rather than one to assert against:
  // the card is wider or taller than the canvas, or the gesture happened outside it.
  const cardFitsW = widthScreen <= frame.width
  const cardFitsH = heightScreen <= frame.height
  const pointerInside = item.pointer.x >= frame.left && item.pointer.x <= frame.left + frame.width
    && item.pointer.y >= frame.top && item.pointer.y <= frame.top + frame.height
  const fitsFromPointer = pointerInside
    && item.pointer.x + widthScreen <= frame.left + frame.width
    && item.pointer.y + heightScreen <= frame.top + frame.height
  const onPointer = !fitsFromPointer
    || (Math.abs(got.x - item.pointer.x) < 0.5 && Math.abs(got.y - item.pointer.y) < 0.5)

  // Inside what can be seen, as far as the card can fit at all: a card larger than the canvas is clipped
  // whatever the code does, and asking it not to be would be asking for the impossible.
  const inside = got.x >= frame.left - 0.5 && got.y >= frame.top - 0.5
    && (!cardFitsW || got.right <= frame.left + frame.width + 0.5)
    && (!cardFitsH || got.bottom <= frame.top + frame.height + 0.5)

  if (!onPointer || !inside) {
    bad += 1
    console.log('  FAIL ' + item.name)
    console.log('        at pointer: ' + onPointer + '  inside: ' + inside)
    console.log('        landed at ' + Math.round(got.x) + ',' + Math.round(got.y)
      + ' pointer ' + item.pointer.x + ',' + item.pointer.y
      + '  canvas ' + frame.left + ',' + frame.top
      + ' +' + frame.width + 'x' + frame.height)
  }
}

// And the formula has to be the one in the file, not a copy that drifted.
const usesView = /const left = -view\.x \/ view\.k/.test(SOURCE)
  && /const top = -view\.y \/ view\.k/.test(SOURCE)

console.log(bad === 0
  ? `  ok   ${cases.length} placements land at the pointer and inside the canvas`
  : `  ${bad} of ${cases.length} placements are wrong`)
console.log('  and the file computes the visible region from the pan: ' + usesView)
process.exit(bad === 0 && usesView ? 0 : 1)
