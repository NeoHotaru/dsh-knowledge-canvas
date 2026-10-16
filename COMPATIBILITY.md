# Compatibility

## Which DSH versions this works on

**Floor: `0.0.1-rc.1`** — the earliest published version, measured rather than assumed.

Measured with `probe-compat.py` over **all 35 published versions** of `@deepseek-ai/dsh-tools`
(DSH publishes its whole monorepo at one version, so the tool package carries the real series).
Every member this plugin uses is present from the first release:

| member | where it is declared | evidence at `0.0.1-rc.1` |
|---|---|---|
| `ctx.tools.register` | `@deepseek-ai/dsh-tools` | `register(definition: ToolDefinition): () => void;` |
| `ctx.on('tools/post-execute')` | `@deepseek-ai/dsh-tools` | `'tools/post-execute'(this: Scoped<ToolRegistry>, exec: ToolExecution, result: …, next: …)` |
| `ctx.systemPrompt.section` | `@deepseek-ai/dsh-system-prompt` | *"Unique name — a duplicate registration throws (see `SystemPrompt.section`)"* |
| `ctx.systemPrompt.context` | `@deepseek-ai/dsh-system-prompt` | declared alongside `section` |
| `ctx.sessions.get` | `@deepseek-ai/dsh-session` | present in the service's declarations |
| `ctx.effect` · `ctx.get` | `@deepseek-ai/cordis` | core cordis plugin API |

**This plugin calls no internal method.** It reached that state by removing a debug probe that had been
reading `ctx.tools.dispatchToolBody`, `contentProjectors`, `prepareExecution` and `finishScheduledExecution`.
Those are not part of any published contract, and their presence would have made the table above impossible:
you cannot state a floor for a method whose signature may change without notice.
`dsh-read-animation` documents the same hazard, and it *does* wrap internals — so its floor is a far weaker
claim than this one.

## What this does not claim

- **Type declarations present ≠ same behaviour.** The probe reads `.d.ts` files. A version can declare a
  member and implement it differently; nothing here would see that.
- **One version had no data**: `0.2.1-alpha.4` failed to download (an SSL error, not a missing member). It is
  reported as NO DATA rather than as a pass — a version that could not be fetched is not a version that
  passed.
- **No upper bound.** There is no promise about future DSH versions. The members above are published API, so
  breakage should be announced rather than silent — but that is an expectation, not a guarantee.

## If a DSH release breaks it

Re-run the probe:

```sh
python probe-compat.py            # walks every published version
python probe-compat.py --from 0.2.1   # or from a given version onward
```

It prints one line per version — `OK`, `missing` with the member names, or `NO DATA` — and the first version
where every member is present.
