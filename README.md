# dsh-knowledge-canvas

A knowledge base for DeepSeek Harness that the model retrieves from **by judgement, not by similarity** — and that you edit on a canvas in the sidebar.

## The problem

**You explain something, and the next conversation still does not know it — or worse, it thinks it does, and the note is stale.**

This is not a context-window problem. Measured in one workspace:

```
$ node report-kb-use.mjs
50 tool call(s) in the log, 1 session(s)
  写 13 次（ops / …）
  读 1 次（read-animation）
  ⚠ 先写后读：第一次写入之前没有读过
```

**13 writes, 1 read** — and that read was from a different base. Knowledge was *recorded* and never *used*. Recording is free: the model does it in passing. Using is the hard part: you have to know the entry exists, and which one still holds.

## What makes this different

Every node ends with a line beginning 「什么时候该想起它：」 — "when should this come to mind". That line is what the outline shows, so the model matches a situation rather than an embedding. When it picks wrong, you see the wrong node on the canvas and fix the sentence that misled it.

## On the panel

| Where | What |
| --- | --- |
| Top row | search, read counters, refresh |
| One row per base | title, read progress, index/full switches, `⋯` menu (rename, delete, colour, export) |
| Canvas toolbar | zoom, fit, **width** (the whole base's default width, not one node), shape, colour, layout |
| 「定位到…」 at the bottom | type an id to jump to that node |

| Gesture | Result |
| --- | --- |
| click a node | opens the editor; click again to close |
| Enter / Space (focused) | same, from the keyboard |
| Shift+Enter | start a link; Enter on the target finishes it |
| drag a node | moves it; the drop is written to `layout.json` |
| hold ~0.26 s then drag | draws a **link** (orange), not a re-parent |
| right-drag from a node | same link |
| **Alt + drag a node** | makes the target its parent (grey line) |
| right-click a node | menu: new child / change history |
| right-click empty canvas | menu: new top-level node |
| drag a node out to the input box | hands that node to the conversation |
| the three handles | width, height, both |

Node size means three things in order: this node → the base's default → the canvas zoom. The toolbar's 「宽度」 is the second one.

Four layouts: layers, radial, staircase, compact. Switching only recomputes the default placement.

## Install

```bash
npm install dsh-knowledge-canvas
```

Restart DSH once after installing; the 「知识库」 panel appears in the sidebar. Panel-side changes need only a page reload; host-side changes (`index.js`, `lib/*`) need a restart — that distinction decides what you do after editing.

The first time you open a workspace, a base called 「怎么用这个知识库」 is seeded with everything the panel can do. It upgrades with each release, and nodes you edited are never overwritten.

## Tools the model gets

| Tool | What it does |
| --- | --- |
| `knowledge_read` | read a base or a node; without `base`, list the bases |
| `knowledge_create_base` | create a base with a root node. **Usable immediately** — no `knowledge_select` needed |
| `knowledge_write_node` | write or edit a node. The return carries the id it just created, ready to use as `parent` |
| `knowledge_link` | connect two nodes, and say in one line why they are related |
| `knowledge_remove_node` | mark a node removed (recoverable, not deleted) |
| `knowledge_select` | switch a base on or off for this conversation |

## Settings, per workspace

Settings → 知识库, one block per workspace: the workspace's path, a **记录调用过程** switch (off by default; when on, every tool call is logged and the panel shows 「正在检索 n3（…）」), and per-base index/full switches.

The workspace list is **the directories in the session list ∪ the directories on disk that have `.dsh-knowledge/`** — the second set is recovered from `$DSH_HOME/sessions/`, where each session has a directory named after its workspace path with separators turned into `-`.

## Diary mode (optional)

For people who do not want to organise notes — they want something to remember. A switch at the top of the panel, **per conversation**.

With it on, that conversation writes an entry of its own when a stretch of talk reaches a place worth keeping. Not daily. Not in other conversations.

- **One per conversation**: `diary-<hash>.json`. The switch is per conversation and so is the data — another conversation in the same workspace neither sees it nor can read it.
- **Stored sealed** (AES-256-GCM). A model that `cat`s the file gets base64.
- **The prompt gives conventions, not a voice.** The persona is yours; the plugin does not write letters on your behalf.

## What it will not do

- **It is not a chat log.** Nothing is captured automatically; only what you or the model explicitly write.
- **It does not sync anywhere.** Everything is under `<workspace>/.dsh-knowledge/`, plain JSON: open it in Notepad, commit it, copy the folder. No account, no server.
- **The diary's sealing stops accidents, not readers.** The key is derived from the base name, so anyone who reads this source can decrypt. Stopping a model that goes looking needs a key that never touches the disk — a password or an OS credential — which is a different design.
- **It does not write a persona.** Diary mode injects writing conventions, not a tone.
- **No full-text search.** The box does substring matching over titles and bodies; no index, no embeddings.

## Where the files are

```
<workspace>/.dsh-knowledge/
├── <base id>.json        one file per base: nodes, links, seed fingerprint
├── selection.json        which bases this workspace reads, how they are injected, call logging
├── layout.json           positions, widths, shapes, colours
├── .sessions/<id>.json   this conversation's own switches (including the diary)
└── activity.log          tool-call records, only while call logging is on
```

- **Host** (`index.js`, `lib/*`): injection, tools, routes, the seeded tutorial, the diary conventions.
- **Panel** (`client.js`): canvas, gestures, editor, settings. **It reads those JSON files directly**, not through the host — so when the panel "cannot see a base", check what it read, not what the host answered.
- The outline is assembled before every model call and holds titles, summaries and trigger lines; bodies need an explicit `knowledge_read`.

### For contributors

- `npm run check:all` runs four things: identifiers, sprite aspect ratios, a public-tree check (no local paths, addresses or private ids), and 472 assertions over store/routes/tools.
- **Change a gesture, change the tutorial line that describes it** (`lib/seed.js`, the table at the top), or the tutorial describes something that does not exist.
- The tutorial is recognised **by content** (whichever base shares most of the seed's node ids), not by file name — that rule came from three workspaces keeping it under three different names.

## Development

```bash
npm run check:all     # identifiers + sprites + public tree + 472 assertions
npm test              # assertions only
```

Publishing needs a real terminal (2FA needs a TTY), and after publishing the version stays `Validating` until npm's automated review finishes:

```bash
cd <this repo>
npm publish --registry https://registry.npmjs.org
```

While it is `Validating`, `registry.npmjs.org/.../<version>.tgz` returns 404 — that is not a failed publish.

## License

MIT
