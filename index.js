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

import { TOOLS, useHostAttachments } from './lib/tools.js'
import { needsRefresh, outlineFor, refresh } from './lib/outline.js'
import { sessionIdOf } from './lib/session.js'
import { seedIfFirstTime, upgradeTutorial } from './lib/seed.js'
import { PREFIX, createHandler } from './lib/routes.js'
import { diaryBaseFor, readDiary } from './lib/state.js'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { LOG_PATH, describeError, log } from './lib/log.js'
import { describeArgs, noteFor, notesDisabled, ruleFor, workspaceOf } from './lib/inject.js'

/** Cordis plugin name; matches the `id` of this bundle's `cordis.patch.yml` row. */
export const name = 'dsh-knowledge-tree'

/** Everything this plugin needs: the tool registry, the prompt, and the panel's write route. */
export const inject = ['tools', 'systemPrompt', 'webServer', 'sessions']

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
  '',
  '**刚写完一条、而大纲里没有它，不代表没写进去。** 每个库的标题后面带着它的节点数和最新时间戳，',
  '而 knowledge_write_node 的返回里带着那条节点自己的时间戳。比一下：如果那条比大纲上的更新，',
  '说明这份大纲是在你写入之前拼的 —— **不要重写一遍**，那只会让库里多一条重复的。',
].join('\n')

export { LOG_PATH }

/**
 * Register the knowledge tools and the prompt section for this profile.
 * @param ctx - the plugin context carrying `tools` and `systemPrompt`.
 * @returns nothing.
 */
export function apply(ctx) {
  log('apply() entered')
  // The attachment service turns a picture on disk into an image block. A host without it is not an error — the tools
  // answer in text — and the guard is here because an unguarded call once took every tool in this plugin down.
  try {
    // ctx.get, not ctx.attachments: the host exposes services through the accessor. dsh-read-animation reads it the same way.
    useHostAttachments(typeof ctx.get === 'function' ? ctx.get('attachments') : ctx.attachments)
  } catch (error) {
    log('FAIL handing over the attachment service: ' + describeError(error))
  }

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
    //
    // The upgrade is the second half of the same idea, and it is not optional: a tutorial that never changes
    // means every workspace that already ran the plugin keeps a description of the features it did not have —
    // and since the outline is what the model reads, it keeps believing that description. Creation stays
    // narrow (only when the directory is absent); the upgrade only touches nodes whose text is still ours.
    void seedIfFirstTime(cwd)
      .then(() => upgradeTutorial(cwd))
      .then(() => {
        if (needsRefresh(cwd, sessionId)) return refresh(cwd, sessionId)
        return undefined
      })
  }

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
          // Image-capable tools declare both schema and renderer; other tools keep answering in text.
          output: tool.output || {
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

  // The tools surface used to be printed here, once per boot, because the dispatcher's name had to be
  // discovered and guessing service members had already cost this project twice.
  //
  // It is gone now, and that matters for more than tidiness: reading `ctx.tools.dispatchToolBody`,
  // `contentProjectors`, `prepareExecution` and the rest made this plugin depend on four *internal* methods
  // it does not use. `dsh-read-animation`'s COMPATIBILITY.md records what that costs — a plugin wrapping
  // internals cannot state a version floor, because the signature can change without notice.
  //
  // The path this plugin actually uses is `ctx.on('tools/post-execute')`, a published event. What is left
  // below needs only `ctx.tools.register`.

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
        // The switch for comparing two runs that differ in exactly one thing. Checked per call, so dropping
        // the sentinel file changes the next call rather than the next boot.
        if (notesDisabled(workspaceOf(hit.path))) {
          log('inject: suppressed by the sentinel for ' + hit.path)
          return downstream
        }
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
      // Exclude workspace preferences, just as lib/store.js does.
      names = readdirSync(dir).filter((name) => name.endsWith('.json')
        && name !== 'selection.json' && name !== 'layout.json' && name !== '.attachment-settings.json')
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
      void warmDiary(cwd, sessionIdOf(agent))
      if (needsRefresh(cwd, sessionIdOf(agent))) await refresh(cwd, sessionIdOf(agent))
      return next()
    }), 'knowledge-tree: warm before the step')

    log('registered the outline warmers')
  } catch (error) {
    log(`FAIL registering the outline warmers: ${describeError(error)}`)
  }

  // Diary mode: a cache, because the provider below is synchronous.
  //
  // The switch is per session — turning it on in one conversation must not make every other conversation start
  // writing. `diaryCache` holds the last answer per (cwd, session); it is refreshed on `agent/pre-step`, which fires
  // before each step and therefore before each assembly.
  const diaryCache = new Map()
  const diaryKey = (cwd, sessionId) => String(cwd || '') + '\u0000' + String(sessionId || '')
  async function warmDiary(cwd, sessionId) {
    if (!cwd) return
    try {
      // The name of this conversation's own diary goes in the cache too: the prompt has to tell the model which base to
      // write to, and a model that guesses `diary` will be refused by the tools.
      const keeping = await readDiary(cwd, sessionId)
      diaryCache.set(diaryKey(cwd, sessionId), keeping ? diaryBaseFor(sessionId) : null)
    } catch (error) {
      log('FAIL reading the diary switch: ' + describeError(error))
    }
  }

  // What the model is told when the switch is on. Conventions only, never a voice: the persona belongs to the user's
  // preset, and a plugin that writes its own would be putting words in someone else's character.
  const DIARY = [
    '## 日记',
    '',
    '这个会话开了日记。**不用等你被提醒，也不用按天** —— 当一段交流走到了一个值得留下的地方，就写一篇。',
    '写多写少都行，没人会嫌多；但同一件事不要写第二遍。',
    '',
    '怎么写：',
    '- 标题自己拟一句短的，不要用日期当标题',
    '- 一篇只写一件事：今天发生了什么、你怎么想的、想对这个人说什么',
    '- 写完继续正常对话，不要专门宣告"我去写日记了"',
    '- 口吻用你平时说话的样子 —— 不要写成工作报告',
    '',
    '写到哪：这个工作区里名为 `{base}` 的库（就只有这一个名字，别自己另起）。没有就先建一个',
  '（`knowledge_create_base`，id 用 `{base}`），根节点写清楚"按月分组"',
    '—— 每个月一个节点，日记挂在它下面，这样大纲里不会长出几百行。',
  ].join('\n')

  try {
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'knowledge-tree.diary',
      // Just after the outline: it is an instruction about how to write, and it should not sit in front of the
      // protocol that decides whether any of this is read at all.
      order: 9500,
      text: ({ agent }) => {
        const cwd = agent?.session?.header?.cwd
        // The cached value is this conversation's diary base name, or null when it keeps none — the name is part of
        // the text because a model that has to guess it writes to a base the tools will refuse.
        const base = diaryCache.get(diaryKey(cwd, sessionIdOf(agent)))
        return base ? DIARY.split('{base}').join(base) : ''
      },
    }), 'knowledge-tree: the diary conventions')
    log('registered the diary context')
  } catch (error) {
    log('FAIL registering the diary context: ' + describeError(error))
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
        return outlineFor(cwd, sessionIdOf(agent))
      },
    }), 'knowledge-tree: runtime context')
    log('registered the knowledge-tree context')
  } catch (error) {
    log(`FAIL registering the knowledge-tree context: ${describeError(error)}`)
  }
}
