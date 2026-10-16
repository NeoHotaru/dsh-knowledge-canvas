/**
 * Host half of the knowledge-tree bundle: the tools the model uses to build and edit a
 * knowledge base, and the prompt section that puts the enabled bases in front of it.
 *
 * The bases are ordinary files under `<workspace>/.dsh-knowledge/`, which is what makes the
 * whole thing reviewable: the user can open them, diff them, version them with git, or fix
 * them by hand when the model gets something wrong. The Client half reads the same files
 * through the workspace-files remote, which is also read-only — so the only writer in the
 * system is this plugin's tools, and every write goes through `lib/store.js`, which is where
 * the review marker is set.
 *
 * Design notes worth keeping:
 * - A node is never really deleted. It is marked `removed` and drawn greyed out, because a
 *   vanished node leaves the user nothing to review.
 * - Every write stamps `change` on the node it touched. Without that the panel would show a
 *   clean tree while the model had quietly rewritten it.
 * - Node ids and base ids are validated against a strict pattern rather than escaped, because
 *   a base id becomes a file name.
 * - The prompt carries only the outline of the enabled bases. `dsh-system-prompt` states that
 *   prompt text is repeated per request and that any change can invalidate prefix reuse from
 *   the first changed token, so bodies are fetched with a tool instead of injected.
 * - Registration is logged to a file. A host-side failure is otherwise invisible from the Web
 *   UI: the tools simply do not appear, and nothing distinguishes "the host never loaded this
 *   half" from "registration was rejected". The log answers that in one restart.
 */

import { TOOLS } from './lib/tools.js'
import { needsRefresh, outlineFor, refresh } from './lib/outline.js'
import { sessionIdOf } from './lib/session.js'
import { seedIfFirstTime } from './lib/seed.js'
import { PREFIX, createHandler } from './lib/routes.js'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { LOG_PATH, describeError, log } from './lib/log.js'
import { describeArgs, noteFor, ruleFor, workspaceOf } from './lib/inject.js'

/** Cordis plugin name; matches the `id` of this bundle's `cordis.patch.yml` row. */
export const name = 'dsh-knowledge-tree'

/** Everything this plugin needs: the tool registry, the prompt, and the panel's write route. */
export const inject = ['tools', 'systemPrompt', 'webServer', 'sessions']

/**
 * Report the shape of the two services the settings page needs, once.
 *
 * Written because guessing service names has already cost this project twice: a wrong \`inject\` entry
 * stalls the plugin outright, and a method that does not exist throws only at the moment it is called,
 * which for a settings page is when a user opens it. One line at startup turns both into something read.
 */
function probeServices(ctx) {
  const describe = (label, value) => {
    if (!value || typeof value !== 'object') {
      return label + '=' + (value === undefined ? 'undefined' : typeof value)
    }
    const names = []
    for (const key in value) names.push(key)
    return label + '=[' + names.sort().join(',') + ']'
  }
  try {
    const slots = typeof ctx.get === 'function' ? ctx.get('slots') : undefined
    log('services: ' + describe('sessions', ctx.sessions) + '  ' + describe('slots', slots))
    // The first probe used for-in, which sees own enumerable properties only. `get` is on the prototype
    // and works, so anything that lists sessions is too.
    const chain = []
    for (let proto = Object.getPrototypeOf(ctx.sessions); proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)) {
      for (const name of Object.getOwnPropertyNames(proto)) chain.push(name)
    }
    log('sessions prototype: [' + [...new Set(chain)].sort().join(',') + ']')
  } catch (error) {
    log('FAIL probing services: ' + ((error && error.message) || error))
  }
}

/**
 * The instruction that makes the rest of this plugin worth having.
 *
 * Modelled on the one Anthropic's memory tool injects automatically, which is the closest published
 * equivalent of what this plugin does: an imperative, a numbered protocol, and the reason. The reason is
 * not decoration — instruction-following work shows a constraint stated with its purpose survives a long
 * prompt better than a bare command, and this prompt is long.
 *
 * Empty when there is no outline to act on: a protocol for reading a base that does not exist is noise.
 */
const PROTOCOL = [
  '关于这个工作区的知识库：',
  '',
  '**做任何事之前，先看下面的大纲里有没有讲过这件事。** 用户的偏好、这个项目的约定、',
  '踩过的坑，都可能在里面 —— 而漏掉它的代价，是你会把已经解决过的问题重新解决一遍。',
  '',
  '协议：',
  '1. 先读大纲。每一行是一个节点的摘要；判断哪几个相关，**不确定就不用读**。',
  '2. 相关的，用 knowledge_read 取正文（参数是库的 id）。别照着摘要猜正文写了什么。',
  '3. 做完之后，如果这件事"下次还会用到"，用 knowledge_write_node 写进去。',
  '4. 正文最后一行以「什么时候该想起它：」开头 —— 那一行会被取出来放进这段提示。',
].join('\n')

export { LOG_PATH }

/**
 * Register the knowledge tools and the prompt section for this profile.
 * @param ctx - the plugin context carrying `tools` and `systemPrompt`.
 * @returns nothing.
 */
export function apply(ctx) {
  log('apply() entered')

  /** Sources already reported, so each warmer logs its first firing once. */
  const warmed = new Set()

  /**
   * Kick a rebuild for one session's view of one workspace, reporting the source the first time it
   * happens.
   *
   * The session id is not decoration: the outline cache is keyed by workspace *and* session, because two
   * sessions can now read different bases. A warmer that builds the no-session entry while the provider
   * asks for a session's entry leaves the first assembly of every session with an empty outline — which is
   * exactly what happened, and what the service probe showed as `chars=0`.
   */
  const warmFor = (cwd, sessionId, source) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return
    if (!warmed.has(source)) {
      warmed.add(source)
      log(`warmer(${source}) fired for ${cwd}`)
    }
    // A first-time workspace gets its welcome base before anything reads the outline, because the outline
    // is where that base is explained to the model. Idempotent, and a no-op for every workspace that has
    // ever been used.
    void seedIfFirstTime(cwd).then(() => {
      if (needsRefresh(cwd, sessionId)) return refresh(cwd, sessionId)
      return undefined
    })
  }

  /** Set once the outline provider has been reached, for the same reason. */
  let probed = false

  /** Set once the session shape has been reported, for the same reason. */
  let shapeLogged = false

  /** Set once the tools service's surface has been reported, for the same reason. */
  let probedTools = false

  if (!ctx.tools || typeof ctx.tools.register !== 'function') {
    log('FAIL: ctx.tools.register is not available — the tools service is not mounted')
  } else {
    let registered = 0
    for (const tool of TOOLS) {
      try {
        ctx.tools.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          // Shape copied from dsh-read-animation, whose registration is known to be accepted:
          // an output schema plus a render that returns content blocks.
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          // These mutate files, so two of them must not run at once.
          isConcurrencySafe: () => false,
          execute: (args, exec) => tool.execute(args, exec),
        })
        registered += 1
        log(`registered ${tool.name}`)
      } catch (error) {
        log(`FAIL registering ${tool.name}: ${describeError(error)}`)
      }
    }
    log(`tools done: ${registered}/${TOOLS.length}`)
  }

  // Which method actually dispatches a tool call?
  //
  // The plan is to hand knowledge to the model at the moment it reaches for a file, rather than hoping it
  // remembers to look — the same shape `dsh-read-animation` uses to wrap `admitPromptContent`. That needs the
  // dispatcher's name, and guessing service members has already cost this project twice (see the `slots`
  // note above). So: print the surface, once, and read it back from the log.
  if (ctx.tools && !probedTools) {
    probedTools = true
    const surface = new Set()
    for (let at = ctx.tools; at && at !== Object.prototype; at = Object.getPrototypeOf(at)) {
      for (const key of Object.getOwnPropertyNames(at)) {
        if (key === 'constructor') continue
        let kind = '?'
        try {
          kind = typeof ctx.tools[key] === 'function' ? '()' : 'v'
        } catch {
          kind = '!'
        }
        surface.add(key + kind)
      }
    }
    log('tools surface: ' + [...surface].sort().join(' '))

    // The two that look designed for this are `contentProjectors` and `contentFinalizers`: the probe shows
    // them as values rather than methods, so they may be lists something can be added to. Print their shape —
    // and the dispatcher's source — so the next step does not need another restart just to guess.
    const shapeOf = (value) => {
      if (value === null || value === undefined) return String(value)
      if (Array.isArray(value)) {
        return 'array(' + value.length + ')' + (value.length ? ' of ' + value.map((item) => typeof item).join(',') : '')
      }
      return typeof value
    }
    for (const key of ['contentProjectors', 'contentFinalizers', 'canonicalResults', 'layers',
      'deferredContexts', 'concludingExecutions', 'contentFinalizers']) {
      try {
        log('tools.' + key + ' = ' + shapeOf(ctx.tools[key]))
      } catch (error) {
        log('tools.' + key + ' threw: ' + describeError(error))
      }
    }
    for (const key of ['dispatchToolBody', 'postExecute', 'prepareExecution', 'finishScheduledExecution']) {
      try {
        const fn = ctx.tools[key]
        log('tools.' + key + ' arity=' + (typeof fn === 'function' ? fn.length : 'n/a'))
        if (typeof fn === 'function') log('  ' + key + ' src: ' + String(fn).replace(/\s+/g, ' ').slice(0, 260))
      } catch (error) {
        log('tools.' + key + ' threw: ' + describeError(error))
      }
    }
    try {
      const projectors = ctx.tools.contentProjectors
      if (projectors && typeof projectors.forEach === 'function') {
        projectors.forEach((item, index) => {
          log('  projector[' + index + '] ' + (item && item.name ? item.name : typeof item)
            + ' :: ' + String(item && item.project ? item.project : item).replace(/\s+/g, ' ').slice(0, 170))
        })
      }
    } catch (error) {
      log('projector walk threw: ' + describeError(error))
    }

    // The surface has been logged, so the logging wrapper has done its job. It is replaced below by one that
    // attaches notes to results rather than printing shapes into the log.
  }

  // Hand the relevant nodes to the model at the moment it reaches for a file.
  //
  // Not a reminder. The outline and the protocol are already in the prompt, and on 2026-10-15 that was
  // demonstrably not enough — the author of this plugin edited `lib/state.js`, said "refresh will do", and the
  // node saying otherwise was in context the whole time. A reminder competes with everything else in a long
  // context; this arrives attached to the call that is about to touch the file.
  //
  // ### Why the event and not a wrapped method
  //
  // The first version wrapped `ctx.tools.dispatchToolBody` and appended text to its return value. It fired —
  // the log said so — and nothing reached the model: `dispatchScheduledExecution` runs every result through
  // `normalizeDispatchResult` and `markCanonical`, which validate results against a `WeakMap` keyed by the
  // dispatch that produced them, so a decorated copy is not the canonical one.
  //
  // Reading the bundle (it is not compressed, so this needs no restart) found the supported path:
  //
  //     for (const context of result.additionalContexts ?? []) acceptContext(context)
  //
  // and DSH's own PostToolUse bridge uses it — `ctx.on('tools/post-execute', …)`, returning
  // `{ ...downstream, additionalContexts: [message, …] }`. An entry is a user message, built by
  // `createUserMessage`, which a `link:`ed plugin cannot import, so the shape is spelled out here.
  const noteCache = new Map()
  const installInjection = () => {
    if (typeof ctx.on !== 'function') {
      log('inject: ctx.on is not available; no action-time notes')
      return
    }
    ctx.on('tools/post-execute', async (exec, result, next) => {
      // Let the rest of the chain run first: the note belongs after whatever the tool itself reported.
      const downstream = typeof next === 'function' ? await next() : result
      try {
        const hit = ruleFor(describeArgs([exec]))
        if (!hit) return downstream
        const note = noteForRule(hit)
        if (!note) return downstream
        const message = {
          id: 'kb-note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
          role: 'user',
          content: [{ type: 'text', text: note }],
          source: { kind: 'dsh-knowledge-tree' },
        }
        log('inject: attached ' + hit.rule.nodes.join('+') + ' to ' + exec.name + ' of ' + hit.path)
        return {
          ...downstream,
          additionalContexts: [message, ...(downstream && downstream.additionalContexts) || []],
        }
      } catch (error) {
        // A failure here must never break the tool call it was decorating.
        log('inject: could not attach the note: ' + describeError(error))
        return downstream
      }
    })
    log('inject: tools/post-execute registered')
  }

  /** The node texts for a rule, read once per workspace and cached briefly. */
  const noteForRule = (hit) => {
    const workspace = workspaceOf(hit.path)
    if (!workspace) return ''
    let cache = noteCache.get(workspace)
    if (!cache || Date.now() - cache.at > 5000) {
      cache = { at: Date.now(), texts: readNodeTexts(workspace) }
      noteCache.set(workspace, cache)
    }
    return noteFor(hit.rule, cache.texts)
  }

  /**
   * Title and first line of the named nodes, from every base in the workspace.
   *
   * Deliberately short. The note is read in passing, next to a tool result — a full body would be a wall of
   * text in the one place that has to stay legible, and the model can call `knowledge_read` for the rest.
   */
  function readNodeTexts(workspace) {
    const texts = {}
    const dir = join(workspace, '.dsh-knowledge')
    let names = []
    try {
      // The same two files `lib/store.js` excludes: they are settings, not bases.
      names = readdirSync(dir).filter((name) => name.endsWith('.json')
        && name !== 'selection.json' && name !== 'layout.json')
    } catch {
      return texts
    }
    for (const name of names) {
      try {
        const base = JSON.parse(readFileSync(join(dir, name), 'utf8'))
        for (const node of base.nodes || []) {
          if (!node || typeof node.id !== 'string') continue
          const body = String(node.body || '').split('\n')
            .map((line) => line.trim())
            .find((line) => line.length > 0 && !line.startsWith('#')) || ''
          texts[node.id] = String(node.title || '')
            + (body ? ' —— ' + body.slice(0, 120) : '')
        }
      } catch { /* one unreadable base must not stop the others */ }
    }
    return texts
  }

  installInjection()

  // The panel's write path. Registered before the prompt wiring, so a failure there cannot
  // take saving down with it — the two are independent.
  if (!ctx.webServer || typeof ctx.webServer.register !== 'function') {
    log('FAIL: ctx.webServer.register is not available — the panel would have no way to save')
  } else {
    try {
      ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: createHandler(ctx),
      }), 'knowledge-tree: panel write routes')
      log(`registered the panel write route at ${PREFIX}`)
    } catch (error) {
      log(`FAIL registering the panel write route: ${describeError(error)}`)
    }
  }

  if (!ctx.systemPrompt || typeof ctx.systemPrompt.section !== 'function') {
    log('FAIL: ctx.systemPrompt.section is not available — the prompt service is not mounted')
    return
  }

  // The context's text provider is synchronous, so it can only serve a cached outline, and a
  // cold cache leaves an assembly with nothing to show. Two hooks were tried and both turned
  // out to be structurally too late — the log proved it rather than suggested it:
  //
  //   - `system-prompt/assemble` (a waterfall): `SystemPrompt.assemble` evaluates every
  //     provider's text *while building* the assembly object, then runs the waterfall. Reading
  //     its doc comment ("the mutable assembly built from registered providers") as "the
  //     waterfall helps build it" was the mistake.
  //   - `agent/pre-step` (also a waterfall): measured, it fires *after* the assembly that the
  //     request performs — the log shows the provider reading an empty cache 5ms before it ran.
  //
  // So warm on the earliest lifecycle events instead: a Session exists well before its first
  // turn reaches a model. The step hook stays for later staleness.
  try {
    ctx.effect(() => ctx.on('session/created', (session) => {
      warmFor(session?.header?.cwd, sessionIdOf({ session }), 'session/created')
    }), 'knowledge-tree: warm on session/created')

    ctx.effect(() => ctx.on('agent/created', (payload) => {
      const agent = payload?.agent ?? payload
      warmFor(agent?.session?.header?.cwd, sessionIdOf(agent), 'agent/created')
    }), 'knowledge-tree: warm on agent/created')

    ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
      const agent = payload?.agent
      const cwd = agent?.session?.header?.cwd
      warmFor(cwd, sessionIdOf(agent), 'agent/pre-step')
      if (needsRefresh(cwd, sessionIdOf(agent))) await refresh(cwd, sessionIdOf(agent))
      return next()
    }), 'knowledge-tree: warm before the step')

    log('registered the outline warmers')
  } catch (error) {
    log(`FAIL registering the outline warmers: ${describeError(error)}`)
  }

  // A runtime context, not a prompt section.
  //
  // Two reasons, and the second is the one that settled it:
  //   1. Semantically this *is* runtime context — which knowledge bases are switched on for
  //      this workspace, right now. It is not persona text.
  //   2. Observed behaviour: a fresh Session could see the other runtime contexts (the
  //      workspace notes, the environment snapshot) and could not see this content while it
  //      was a section. Contexts demonstrably reach the model; the section did not.
  // `assemble` also rebuilds `contexts` from the merged providers, evaluated the same way, so
  // a provider function is still available here.
  try {
    // The instruction, before the reference material. Same reason Anthropic's memory tool injects its
    // "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE" at the front: a rule stated where
    // attention is strongest is followed more often, and this is the one line whose being noticed decides
    // whether anything else here is used at all.
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'knowledge-tree.protocol',
      // Early: before first-party guidance, because this is an instruction rather than reference.
      order: 200,
      text: ({ agent }) => (outlineFor(agent?.session?.header?.cwd, sessionIdOf(agent)) ? PROTOCOL : ''),
    }), 'knowledge-tree: the protocol')

    ctx.effect(() => ctx.systemPrompt.context({
      name: 'knowledge-tree',
      // Late: reference material rather than an instruction, so it sits after first-party
      // guidance. External contributions may use any finite order.
      order: 9000,
      // A provider rather than a fixed string, so the outline is read at each assembly. It is
      // synchronous, which is why lib/outline.js caches instead of reading files here.
      text: ({ agent }) => {
        const cwd = agent?.session?.header?.cwd
        const value = outlineFor(cwd, sessionIdOf(agent))
        // Once: what a Session object is actually shaped like. Four guessed names all returned nothing, and
        // a guess costs a restart to test; this costs one restart in total.
        if (!shapeLogged) {
          shapeLogged = true
          try {
            const session = agent && agent.session
            // Anything that looks like a title, wherever it lives. The window has one, so it exists.
            const titleish = []
            const scan = (value, label, depth) => {
              if (!value || typeof value !== 'object' || depth > 2) return
              for (const key of Object.keys(value)) {
                if (/title|name|label|summary|subject/i.test(key)) {
                  const held = value[key]
                  titleish.push(label + '.' + key + '=' + (typeof held === 'string' ? JSON.stringify(held.slice(0, 40)) : typeof held))
                }
              }
            }
            scan(session, 'session', 0)
            scan(session && session.header, 'header', 1)
            scan(session && session.derived, 'derived', 1)
            scan(session && session.headerFold, 'headerFold', 1)
            log('title-ish: ' + (titleish.length ? titleish.join('  ') : 'NONE FOUND'))
            // The value, not just the key list. "Has an id key" and "has a usable id" are the same line in a
            // log otherwise, and that ambiguity is what kept this question open across two sessions.
            const idValue = session && session.header ? session.header.id : undefined
            log('session id: typeof=' + typeof idValue
              + ' value=' + JSON.stringify(idValue === undefined ? null : idValue)
              + ' usable=' + JSON.stringify(sessionIdOf(agent))
              + ' agent.id=' + JSON.stringify(agent && agent.id !== undefined ? agent.id : null))
            log('session shape: session=[' + Object.keys(session || {}).join(',') + ']'
              + ' header=[' + Object.keys((session && session.header) || {}).join(',') + ']'
              + ' id-found=' + JSON.stringify(sessionIdOf(agent)))
          } catch (error) {
            log('FAIL reading the session shape: ' + ((error && error.message) || error))
          }
        }
        // One line ever: whether the provider is reached at all is the difference between
        // "the registration did not take" and "something downstream drops it".
        if (!probed) {
          probed = true
          log(`outline provider reached: cwd=${cwd ?? '(none)'} chars=${value.length}`)
        }
        return value
      },
    }), 'knowledge-tree: runtime context')
    log('registered the knowledge-tree context')
    probeServices(ctx)
  } catch (error) {
    log(`FAIL registering the knowledge-tree context: ${describeError(error)}`)
  }
}
