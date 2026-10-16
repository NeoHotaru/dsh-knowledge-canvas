# dsh-knowledge-canvas

A knowledge base for DeepSeek Harness that the model retrieves from **by judgement, not by similarity**.

## The problem

**You explain something, and the next conversation still does not know it — or worse, it thinks it does, and the note is stale.**

This is not a context-window problem. Measured in one workspace:

```
$ node report-kb-use.mjs
50 tool call(s) in the log, 1 session(s)
  wrote 13 times (ops / …)
  read  1 time  (read-animation)
  ⚠ wrote before reading: nothing was read before the first write
```

**Thirteen writes, one read** — and that one read was a different base. The knowledge was **recorded** and never **used**. Recording is free: a model writes a note in passing. Using it is the hard part, because using it means first knowing the note exists, and then knowing which notes still hold.

## What makes this different

Not a note app with a search box. Four decisions, and everything else follows from them.

### 1. A trigger line instead of a vector index

The **last line** of every node's body says when the node applies:

```
When to recall: <the situation this node is for>
```

That one line — and only that line — goes into the system prompt. So:

- **no embeddings, no vector store, no similarity threshold.** Retrieval is the model deciding, and what it decides on is a sentence a human wrote
- **a node is only findable if its author said when.** That is the whole bet: the hard part of a knowledge base is not storing, it is being *consulted*, and being consulted is a property of how the note is written
- **a node without one is marked.** In the index it shows as `（无触发器）` — the index itself is Chinese, since every other line the model reads from this plugin is — and the write tool says so the moment you write it, because a base full of unfindable nodes looks exactly like a healthy one

### 2. The index is a tree, not a list of chunks

Parent and child are information — "this belongs under that". The index is rendered in hierarchy, so the model reads a structure rather than a pile of fragments. A base that is all peers is a fine base; a base where nothing is under anything is usually a mistake.

### 3. Review markers survive every mode

Every change a model makes carries `[added]` / `[modified]` / `[retired]` until you review it. In **full-text** injection too — which is the version most likely to drop them, and did, until a test session noticed it could no longer tell which paragraphs were unreviewed.

### 4. It tells you whether it worked

`report-kb-use.mjs` reads the plugin's `activity.log` and answers: in this session, how many times was a base read, how many times written, and were anything read *before* the first write. That is where the number in "The problem" came from — and it is the reason this plugin does not claim to improve anything it has not measured.

## The mechanics

| | |
|---|---|
| **Trigger line** | The last line of a body; extracted into the index. The lint above marks it missing |
| **Freshness** | Every base's heading carries its node count and newest stamp, and every write reports its own timestamp — so "my write is not in the index yet" is answerable instead of guessed (guessing wrong means writing it twice) |
| **Two injection modes** | An index by default; any base can opt into **full text**. Each base decides, and the mode is per base, not global |
| **Scope** | Which bases a conversation uses: workspace default, or a per-session override |
| **Off means off** | Switching a base off means the model can neither read nor write it — not merely "it stays out of the prompt" |
| **Plain files** | One base is one JSON file under `<workspace>/.dsh-knowledge/`. Grep it, diff it, commit it, copy it |
| **Seeded tutorial** | The first run in a workspace creates a six-node base explaining all of the above, switched on. Delete it whenever |

## The panel

A canvas on the right: nodes laid out as a tree, pan and zoom, drag to move, right-drag to link, per-node colour and width. Search by title or body, and jump to a node by id — so when a conversation mentions `o14`, you can point at it on screen.

## Install

**npm**: the package is `dsh-knowledge-canvas`. Type it into DSH's "add plugin" dialog.

**From source**:

```json
// profiles/desktop/package.json
"dependencies": { "dsh-knowledge-tree": "link:<path to the checkout>" },
"dsh": { "profile": { "bundles": [ ..., "dsh-knowledge-tree" ] } }
```

> Linking from source uses the `name` **inside that checkout's package.json**.
> The published package is `dsh-knowledge-canvas` (`dsh-knowledge-tree` was taken on npm),
> while the local checkout still calls itself `dsh-knowledge-tree`.

## Tools the model gets

```
knowledge_read             read one base, or list them all
knowledge_create_base      create a base
knowledge_write_node       create or edit a node
knowledge_link             record an association between two nodes
knowledge_remove_node      retire a node (kept in the file, marked)
knowledge_select           switch a base on or off (for this session, or the default)
knowledge_remove_base      move a base out (to .removed/, recoverable)
```

## Development

```sh
npm run check:all      # 9 checks + 326 assertions
```

Editing `index.js` / `lib/*` needs a **Harness restart** (the host half is loaded once at process start);
editing `client.js` needs a page refresh.

## License

MIT
