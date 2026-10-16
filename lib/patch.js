/**
 * Install, tag, and remove one wrapper on one method of a core service.
 *
 * Copied from `dsh-read-animation/lib/patch.js`, which is the working precedent for reaching into a DSH
 * service. It stays a copy rather than an import because that plugin is a sibling directory, not a
 * dependency — but the three defects its header documents were found the hard way, and re-deriving them here
 * would be a waste:
 *
 * **The install check never fires** if it compares `service.method === wrapper`: a cordis service is reached
 * through a proxy that re-wraps methods on every read, so that comparison is false even when the patch is
 * live. The tag is read *through* the wrapper instead — property access is forwarded to the underlying
 * function, so the tag is visible where identity is not.
 *
 * **Teardown is last-writer-wins** unless each level keeps its own identity: with two overlapping installs,
 * disposing the first removed the second's patch and left a dead closure on a live service. Here each level
 * delegates to whatever is directly below it *now*, and removing a level that is no longer on top does
 * nothing.
 *
 * **Wrapping a method that is not there creates it**, so the host acquires a function whose only behaviour is
 * to throw from deep inside an ordinary-looking call, and the plugin reports nothing at mount when it knew
 * the host lacked what it needed. `missingMethods` checks first.
 *
 * @module dsh-knowledge-tree/patch
 */

/** Identity of one installed level, readable through the service proxy. */
const LEVEL = Symbol.for('dsh-knowledge-tree.patch-level')

/** Installed levels per service and method, oldest first. */
const stacks = new WeakMap()

/** The level list for one service method, created on first use. */
function stackFor(service, name) {
  let byName = stacks.get(service)
  if (byName === undefined) {
    byName = new Map()
    stacks.set(service, byName)
  }
  let stack = byName.get(name)
  if (stack === undefined) {
    stack = []
    byName.set(name, stack)
  }
  return stack
}

/** Which of `names` the service does not implement. */
export function missingMethods(service, names) {
  if (service === undefined || service === null) return [...names]
  return names.filter((name) => {
    try {
      return typeof service[name] !== 'function'
    } catch {
      return true
    }
  })
}

/**
 * Wrap one method.
 *
 * @param service - the service object; the property is read and written through whatever proxy the caller
 *   reached it by, so the write reaches the same place the real callers read from.
 * @param name - the method name.
 * @param make - `(base) => wrapper`; `base` delegates to the method as it was before this level.
 * @returns `{ wrapper, installed, remove }`.
 */
export function wrapServiceMethod(service, name, make) {
  const stack = stackFor(service, name)
  const bottom = stack[0]
  const owned = bottom === undefined ? Object.prototype.hasOwnProperty.call(service, name) : bottom.owned
  const original = bottom === undefined ? service[name] : bottom.original

  const level = { wrapper: undefined, original, owned, live: true }

  /** Delegate to whatever is directly below this level now, resolved per call. */
  const base = (...args) => {
    const at = stack.indexOf(level)
    const below = at > 0 ? stack[at - 1] : undefined
    const target = below === undefined ? original : below.wrapper
    return target.apply(service, args)
  }

  const wrapper = make(base)
  level.wrapper = wrapper
  Object.defineProperty(wrapper, LEVEL, { value: level })
  stack.push(level)

  let wrote = false
  try {
    service[name] = wrapper
    wrote = true
  } catch {
    // A read-only property cannot be patched; the caller degrades to the original.
  }
  if (!wrote) {
    level.live = false
    stack.splice(stack.indexOf(level), 1)
  }

  return {
    wrapper,
    /** Whether this level is the one callers currently reach. */
    get installed() {
      try {
        return level.live && service[name]?.[LEVEL] === level
      } catch {
        return false
      }
    },
    /** Take this level off, revealing the next live one or the original method. */
    remove() {
      if (!level.live) return
      level.live = false
      const at = stack.indexOf(level)
      if (at >= 0) stack.splice(at, 1)
      let current
      try {
        current = service[name]
      } catch {
        return
      }
      if (current?.[LEVEL] !== level) return
      const below = stack[stack.length - 1]
      try {
        if (below !== undefined) service[name] = below.wrapper
        else if (owned) service[name] = original
        else delete service[name]
      } catch {
        /* the service is going away with us; nothing to restore */
      }
    },
  }
}
