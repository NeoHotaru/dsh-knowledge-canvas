# dsh-knowledge-canvas

**English** · [简体中文](README.zh.md)

A knowledge base for DeepSeek Harness that the model retrieves from **by judgement, not by similarity** — and that you edit on a canvas in the sidebar.

## Features

- Edit knowledge on a canvas: parent/child relationships, associations, four layouts, and resizable nodes.
- Collapse branches and reveal the path to search results. Long notes scroll; title-only nodes offer a reading preview.
- Choose full-text or on-demand injection per base, with individual node overrides.
- Review model edits and inspect which nodes were read, written or removed.
- Read session-scoped diaries as a notebook and reply from the sidebar.
- Attach images and files; choose on-demand or required attachment reading per workspace.

[Usage manual](MANUAL.md) · [Changelog](CHANGELOG.md) · [GitHub Releases](https://github.com/NeoHotaru/dsh-knowledge-canvas/releases)

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
| One row per base | title, read progress, one switch (does this conversation read it), `⋯` menu (rename, delete, colour, export) |
| Canvas toolbar | zoom, fit, **width** (the whole base's default width, not one node), shape, colour, layout |
| 「定位到…」 at the bottom | type an id to jump to that node |

| Gesture | Result |
| --- | --- |
| click a node | opens the editor; click again to close |
| Enter / Space (focused) | same, from the keyboard |
| Shift+Enter | start a link; Enter on the target finishes it |
| drag a node | moves it; the drop is written to `layout.json` |
| hold ~0.26 s then drag | draws a **link** (orange), not a re-parent |
| **Alt + drag a node** | makes the target its parent (grey line) |
| right-click a node | fold/expand, injection policy, new child, change history |
| title arrow on a branch | collapse or expand its descendants |
| right-click empty canvas | menu: new top-level node |
| drag a node out to the input box | hands that node to the conversation |
| the three handles | width, height, both |

Node size means three things in order: this node → the base's default → the canvas zoom. The toolbar's 「宽度」 is the second one.

Four layouts: layers, radial, staircase, compact. Switching recomputes default placement; manual positions stay under your control.

Collapse a branch using its title arrow or context menu. Nested folds are remembered; search, locate and unread navigation reveal the target's ancestor path. The toolbar can expand everything or arrange visible nodes. Folding affects the canvas only, not model access or injection.

Long note bodies scroll independently and offer an Edit action. At title-only zoom levels, hovering or focusing a node opens a reading preview.

## Install

```bash
pnpm add dsh-knowledge-canvas@latest
```

Run the command in the intended DSH profile directory. For manual installation, also add `dsh-knowledge-canvas` to `dsh.profile.bundles` in that profile's package.json, preserving existing entries. A dependency alone does not apply the bundle patch. The DSH Add Plugin UI is the recommended installation path.

Source links also use the package name `dsh-knowledge-canvas`. Internal legacy module ids and data paths remain unchanged for compatibility.

Restart DSH once after installing; the 「知识库」 panel appears in the sidebar. Panel-side changes need only a page reload; host-side changes (`index.js`, `lib/*`) need a restart — that distinction decides what you do after editing.

The first time you open a workspace, a base called 「怎么用这个知识库」 is seeded with everything the panel can do. It upgrades with each release, and nodes you edited are never overwritten.

## Model tools

| Tool | What it does |
| --- | --- |
| `knowledge_read` | read a base or a node; without `base`, list the bases |
| `knowledge_create_base` | create a base with a root node. **Usable immediately** — no `knowledge_select` needed |
| `knowledge_write_node` | write or edit a node. The return carries the id it just created, ready to use as `parent` |
| `knowledge_link` | connect two nodes, and say in one line why they are related |
| `knowledge_remove_node` | mark a node removed (recoverable, not deleted) |
| `knowledge_unlink` | remove an association; the nodes stay, the dashed line goes |
| `knowledge_select` | switch a base on or off for this conversation |
| `knowledge_remove_base` | mark a base removed (recoverable; the file is not deleted) |
| `knowledge_show_images` | Hands a node's pictures to the model as images |

## Settings, per workspace

Settings → 知识库, one block per workspace: the workspace's path, a **记录调用过程** switch (off by default; when on, every tool call is logged and the panel shows 「正在检索 n3（…）」), and per-base index/full switches.

Each base has a full-text or on-demand default. A node may inherit that default or override it in the editor/context menu. Overrides are shared within the workspace and affect only that node. Indexes still consume context; full-text limits and large-base behavior are described in [the manual](MANUAL.md). Attachment reading is a separate setting.

The workspace list is **the directories in the session list ∪ the directories on disk that have `.dsh-knowledge/`** — the second set is recovered from `$DSH_HOME/sessions/`, where each session has a directory named after its workspace path with separators turned into `-`.

## Diary mode (optional)

For people who do not want to organise notes — they want something to remember. A switch at the top of the panel, **per conversation**.

With it on, that conversation writes an entry of its own when a stretch of talk reaches a place worth keeping. Not daily. Not in other conversations.

- **One per conversation**: `diary-<hash>.json`. The switch is per conversation and so is the data — another conversation in the same workspace neither sees it nor can read it.
- **Stored sealed** (AES-256-GCM). A model that `cat`s the file gets base64.
- **The prompt gives conventions, not a voice.** The persona is yours; the plugin does not write letters on your behalf.

Diaries open as a notebook with a monthly catalog, page navigation and revision history. Switch to the canvas to edit. A sidebar reply sends your text and an excerpt of that page to the current conversation, without replacing the composer draft; reply records are stored separately from the diary.

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
- In on-demand mode, the outline carries titles, summaries and trigger lines; bodies are fetched with `knowledge_read`. Full-text mode includes the selected bodies within its limits.

### For contributors

- `npm run check:all` runs four things: identifiers, sprite aspect ratios, a public-tree check (no local paths, addresses or private ids), and its assertions over store/routes/tools (the count is what the run prints).
- **Change a gesture, change the tutorial line that describes it** (`lib/seed.js`, the table at the top), or the tutorial describes something that does not exist.
- The tutorial is recognised **by content** (whichever base shares most of the seed's node ids), not by file name — that rule came from three workspaces keeping it under three different names.

## Development

```bash
npm run check:all     # identifiers + sprites + public tree + assertions
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

## Attachment reading policy

DSH Settings → Knowledge base offers a per-workspace choice, independent of index/full-body injection:

- **On demand (default):** reading a node or base lists attachment paths and sizes, without file content or images. Pass `attachment` to `knowledge_read` with `base` and `node` to fetch one referenced file. Text supports `offset` and `limit`, measured in characters, up to 8,000 per call. `knowledge_show_images` remains available.
- **Required:** reading a node or base includes supported text and Office content (up to 8,000 characters per file) and up to 6 pictures per call. Continuation instructions identify omitted content. This uses more tokens and does not guarantee model attention.

Unsupported formats, including PDFs and archives, retain their paths for another reader. Missing files and image delivery failures are reported. This policy affects knowledge tools; manually dragging nodes into chat still sends session attachments. Preferences survive restarts and other knowledge settings changes.
