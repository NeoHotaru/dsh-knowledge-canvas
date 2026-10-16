# dsh-knowledge-canvas

A tree-shaped knowledge base for DeepSeek Harness: a knowledge base you can edit yourself, with tools the model reads and writes.

## The problem

**You explain something, and the next conversation still does not know it — or worse, it thinks it does, and the note is stale.**

This is not a context-window problem. Measured in this workspace:

```
$ node report-kb-use.mjs
50 tool call(s) in the log, 1 session(s)
  wrote 13 times (ops / …)
  read  1 time  (read-animation)
  ⚠ wrote before reading: nothing was read before the first write
```

**Thirteen writes, one read** — and that one read was a different base. The knowledge was **recorded** and never **used**. Recording is free: the model writes a note in passing. Using it is the hard part, because using it means first knowing it exists, and then knowing which of it still holds.

So this plugin does not build better memory. It does two other things:

1. **It makes the knowledge a file you can edit** — not something only the model maintains while you watch
2. **It tells the model when to come and look** — every node ends with a line naming when it applies (see below)

## What it is

```
<workspace>/.dsh-knowledge/<base>.json     one base is one tree
```

- **A panel on the right**: the tree drawn on a canvas you can pan and zoom; drag nodes, draw links, edit bodies
- **Tools for the model**: read, write, link — every change carries an `[added]` / `[modified]` / `[retired]` marker for you to review
- **Per-session selection**: which bases a conversation uses, without changing the workspace default

## Features

| | |
|---|---|
| Canvas | Nodes laid out as a tree, pan and zoom; drag a node and its position is remembered |
| Nodes | Title + body (markdown); width follows the content, and you can set it yourself |
| Links | Right-drag from one node to another to record an association |
| Search | By title or body; the canvas centres on a hit |
| Locate | Jump to a node by id (someone says `o14` in chat — you can point at it on screen) |
| Injection | An index by default (title + trigger line); each base can opt into **full text** |
| Markers | Nodes the model changed carry a marker until you review them |

## The trigger line

The **last line** of a node's body is written as:

```
When to recall: <the situation this node applies to>
```

That line is extracted into the index in the system prompt, so the model knows **when to come and read the node** instead of carrying every body in context. It is the main agreement this plugin makes with the context budget.

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

**Switching a base off means the model can neither read nor write it** — not merely "it stays out of the prompt". (The panel can still edit it: that is you, on a different path.)

## Development

```sh
npm run check:all      # 9 checks + 313 assertions
```

Editing `index.js` / `lib/*` needs a **Harness restart** (the host half is loaded once at process start);
editing `client.js` needs a page refresh.

## License

MIT
