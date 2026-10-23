/**
 * Client half of the knowledge-tree bundle.
 *
 * A right-pane tab type, so the knowledge base sits beside the conversation instead of
 * replacing it. Both stages come from the shipping code:
 *
 *   ctx.sidebarRightTabs.register(definition)   stage one: what the type IS — static only.
 *       `patterns` omitted: a page type, opened by kind, recognizing no address.
 *       `priority` omitted: defaults to 'extension', a type from outside the product.
 *       `guide` NOT omitted: without it the type stays off the guide page with no way in.
 *   sidebar.right.pane.tab / .title             stage two: body and chip title, under the id.
 *
 * Data comes from real files rather than literals. The generated remote client exposes the
 * whole workspaceFiles namespace — `list`, `read`, `readBytes`, `stat`, `changes` — even
 * though the owning package's own published view picks only two of them. Paths are resolved
 * against the Session's workspace, so everything lives under `<workspace>/.dsh-knowledge/`.
 *
 * Load failures render in the panel instead of vanishing into the console: a blank pane is
 * the hardest thing to diagnose from a screenshot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-knowledge-tree',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PACKAGE_ID = 'dsh-knowledge-tree';
    const TAB_KIND = 'knowledge-tree';
    const DIR = '.dsh-knowledge';
    // Must match PREFIX in lib/routes.js. The host resolves the workspace from the Session id,
    // so nothing here ever names a directory.
    const PREFIX = '/dsh-knowledge-tree';

    // Captured in apply(); a closure keeps the component free of unverified prop plumbing.
    let REMOTE = null;
    // The plugin context, kept so the panel can reach a service. Components registered through a slot
    // cannot be handed new props afterwards, and this is the same bridge REMOTE already uses.
    let CTX = null;

    /**
     * Put text into the session's composer, at the caret.
     *
     * @returns null on success, or a message saying why not. A failure the user cannot see reads
     *          exactly like a button that does nothing.
     */
    /**
     * Resolve the per-session composer.
     *
     * The property path is guarded by cordis and throws without an inject entry, and that entry cannot
     * be declared: this service is created per session, so the plugin would wait for it forever.
     * ctx.get is the accessor that works.
     *
     * @returns { input, problem } — one of the two is always set.
     */
    function resolveComposer(sessionId) {
      if (!CTX) return { input: null, problem: '面板还没有连上宿主' };
      const tried = [];
      let service = null;
      try {
        service = CTX.conversation && CTX.conversation.input;
        tried.push('属性=' + (service ? '有' : '空'));
      } catch (error) {
        tried.push('属性=被拦');
      }
      if (!service && typeof CTX.get === 'function') {
        for (const key of ['conversation.input', 'conversation']) {
          try {
            const value = CTX.get(key);
            tried.push('get(' + key + ')=' + (value ? '有' : '空'));
            if (value && !service) service = value;
          } catch (error) {
            tried.push('get(' + key + ')=抛错');
          }
        }
      }
      if (!service) return { input: null, problem: '找不到输入框服务。试过：' + tried.join(' ') };

      const usable = (candidate) => candidate && (
        typeof candidate.insertText === 'function' || typeof candidate.setDraft === 'function'
        || typeof candidate.addAttachments === 'function');

      let input = usable(service) ? service : null;
      if (!input && service.input && usable(service.input)) input = service.input;
      if (!input && service.input && typeof service.input.shell === 'function' && sessionId) {
        try {
          input = service.input.shell(sessionId);
        } catch (error) {
          return { input: null, problem: '取本会话的输入框失败：' + (error && error.message ? error.message : error) };
        }
      }
      if (!input && typeof service.shell === 'function') {
        if (!sessionId) return { input: null, problem: '拿到了服务，但没有本会话的 id' };
        try {
          input = service.shell(sessionId);
        } catch (error) {
          return { input: null, problem: '取本会话的输入框失败：' + (error && error.message ? error.message : error) };
        }
      }
      if (!usable(input)) return { input: null, problem: '输入框服务上没有可用方法。它本身：'
        + Object.keys(service || {}).slice(0, 24).join(',') };
      return { input, problem: null };
    }

    /** Put text into the composer at the caret. @returns null, or why not. */
    function insertText(text, sessionId) {
      const { input, problem } = resolveComposer(sessionId);
      if (!input) return problem;
      try {
        const raw = typeof input.caretSpan === 'function' ? input.caretSpan() : null;
        // The facade hands out `{ ...caretSpan(), draftRev: rev }`; the shell's caretSpan returns only
        // start and end, and insertText refuses when draftRev does not match — measured, not assumed:
        // the refusal printed draftRev=undefined against rev=338.
        const span = raw && input.rev !== undefined
          ? Object.assign({}, raw, { draftRev: input.rev })
          : raw;
        if (typeof input.insertText === 'function' && span) {
          if (input.insertText(text, span) === false) return '输入框拒绝了这次插入（宿主只在草稿空闲时接受）';
          return null;
        }
        if (typeof input.setDraft === 'function') {
          input.setDraft(text);
          return null;
        }
      } catch (error) {
        return '插入失败：' + (error && error.message ? error.message : error);
      }
      return '输入框接口既没有 insertText 也没有 setDraft';
    }

    /**
     * Send a node to the session as a markdown attachment.
     *
     * @returns { ok, problem } — ok means the composer accepted it.
     */
    async function attachNode(node, baseName, sessionId) {
      const { input, problem } = resolveComposer(sessionId);
      if (!input) return { ok: false, problem };
      if (!CTX || typeof CTX.get !== 'function') return { ok: false, problem: '面板还没有连上宿主' };

      let conversation = null;
      try {
        conversation = CTX.get('conversation');
      } catch (error) {
        return { ok: false, problem: '取 conversation 失败：' + (error && error.message ? error.message : error) };
      }
      if (!conversation || typeof conversation.createDrafts !== 'function') {
        return { ok: false, problem: '宿主没有提供 conversation.createDrafts' };
      }

      // Pictures and documents this node points at. The panel cannot read files itself, so the host hands them over as base64;
  // without this a handed-off node carried a line of markdown the model could not open.
  const wanted = [];
  for (const match of String(node.body || '').matchAll(/assets\/[a-f0-9]{16}\.[a-z0-9]{1,5}/g)) {
    if (!wanted.includes(match[0])) wanted.push(match[0]);
  }
  const carried = [];
  const skipped = [];
  for (const rel of wanted.slice(0, 5)) {
    try {
      // No `post` here: this function is module-level, far from the one that owns it. The route takes the session.
      const response = await fetch(PREFIX + '/assetBytes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: sessionId, path: rel }),
      });
      const answer = await response.json().catch(() => null);
      if (!answer || !answer.base64) {
        skipped.push(rel.split('/').pop());
        continue;
      }
      const raw = atob(answer.base64);
      const bytes = new window.Uint8Array(raw.length);
      for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
      carried.push(new File([bytes], answer.name, { type: answer.mime || 'application/octet-stream' }));
    } catch {
      skipped.push(rel.split('/').pop());
    }
  }
  if (wanted.length > 5) skipped.push('（还有 ' + (wanted.length - 5) + ' 个未带）');

  const heading = baseName + ' · ' + node.title;
      const markdown = '# ' + heading + '\n\n' + (node.body || '') + '\n';
      const fileName = (baseName + '-' + node.title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) + '.md';
      const file = new File([markdown], fileName, { type: 'text/markdown' });

      // createDrafts registers the File and uploads it in the background; what the composer needs is the
      // draft id it hands back, not the durable file id from an explicit upload.
      let drafts = null;
      try {
        drafts = conversation.createDrafts(sessionId, [file, ...carried]);
      } catch (error) {
        return { ok: false, problem: 'createDrafts 失败：' + (error && error.message ? error.message : error) };
      }
      if (!Array.isArray(drafts) || drafts.length === 0 || !drafts[0] || !drafts[0].id) {
        let shape = '';
        try {
          shape = JSON.stringify(drafts).slice(0, 240);
        } catch (error) {
          shape = String(drafts);
        }
        return { ok: false, problem: 'createDrafts 没有给出 id。返回的是：' + shape };
      }

      const ids = drafts.map((draft) => draft.id);

      try {
        // Attachment only. The reference chip is a second feature — a visible @mention in the draft —
        // and a hand-built one failed to serialize, which broke sending entirely. ids are all the
        // composer needs to carry the file.
        if (typeof input.addAttachments === 'function') {
          if (input.addAttachments(ids) === false) {
            if (typeof conversation.releaseDraftAttachments === 'function') {
              conversation.releaseDraftAttachments(drafts);
            }
            return { ok: false, problem: '宿主拒绝了这次附件（草稿正在忙）' };
          }
          return { ok: true, problem: null };
        }
        if (typeof input.addFiles === 'function') {
          if (input.addFiles([], ids) === false) {
            if (typeof conversation.releaseDraftAttachments === 'function') {
              conversation.releaseDraftAttachments(drafts);
            }
            return { ok: false, problem: '宿主拒绝了这次附件（草稿正在忙）' };
          }
          return { ok: true, problem: null };
        }
      } catch (error) {
        return { ok: false, problem: '加入草稿失败：' + (error && error.message ? error.message : error) };
      }
      return { ok: false, problem: '输入框接口既没有 addFiles 也没有 addAttachments' };
    }

    /** The reader's own colours: enough to rank importance, few enough to stay a decision. */
    const NODE_COLORS = [
      { hex: '#c0392b', name: '重要' },
      { hex: '#c9761b', name: '注意' },
      { hex: '#2e9e5b', name: '完成' },
      { hex: '#2f6fd0', name: '参考' },
      { hex: '#7d5bbe', name: '待定' },
    ];

    const MARKERS = {
      added: { glyph: '＋', color: '#2e9e5b', text: '新增' },
      modified: { glyph: '~', color: '#c9761b', text: '修改' },
      removed: { glyph: '−', color: '#c0392b', text: '已废弃' },
    };

      const WHALE_VERSION = '2026-10-16'
      /** Where the grid lives. A function, not a constant: `PREFIX` is declared further down this file, so
       *  a const initialiser here would read it before it exists and take the plugin down at load. */
      const whaleSheet = (which) => PREFIX + '/whale' + (which ? '-' + which : '') + '.png?v=' + WHALE_VERSION
      const WHALE_COLS = 5
      const WHALE_ROWS = 3
      /**
       * The loops the mascot can play, and what each one costs to describe.
       *
       * `grid: true` means the sheet is the 3x5 grid rather than a single row, so the background size covers both axes and
       * the frame walk only moves along x. Everything else is one row of frames.
       */
      const WHALE_LOOPS = [
        { loop: 'walk', sheet: '', frames: 5, ms: 780, grid: true, anim: 'kb-whale-idle' },
        { loop: 'wave', sheet: 'wave', frames: 6, ms: 960, grid: false, anim: 'kb-whale-wave' },
        { loop: 'doze', sheet: 'doze', frames: 6, ms: 960, grid: false, anim: 'kb-whale-doze' },
        { loop: 'work', sheet: 'work', frames: 6, ms: 900, grid: false, anim: 'kb-whale-work' },
        { loop: 'eat', sheet: 'eat', frames: 6, ms: 950, grid: false, anim: 'kb-whale-eat' },
      ]
      const WHALE_IDLE_LOOPS = WHALE_LOOPS.filter((entry) => entry.loop !== 'work')
      const WHALE_WORK = WHALE_LOOPS.find((entry) => entry.loop === 'work')

      /** The one animation in the sheet, as CSS. `steps` is what keeps pixel art on its own pixels. */
      // 240 = five frames of the walk cycle at the 48 px they are drawn at.
      // Distances are frames times the display size: the walk cycle is 5 * 72, the three strips are 6 * 72. Written out
      // rather than computed because CSS needs a literal, and a wrong number makes the loop skip frames instead of
      // failing.
      const WHALE_CSS = '@keyframes kb-whale-idle { from { background-position-x: 0 }'
        + ' to { background-position-x: -360px } }'
        + ' @keyframes kb-whale-wave { from { background-position-x: 0 } to { background-position-x: -432px } }'
        + ' @keyframes kb-whale-doze { from { background-position-x: 0 } to { background-position-x: -432px } }'
        + ' @keyframes kb-whale-work { from { background-position-x: 0 } to { background-position-x: -432px } }'
        + ' @keyframes kb-whale-eat { from { background-position-x: 0 } to { background-position-x: -432px } }'

    const SURFACE = 'rgba(128,128,128,0.07)';
    // A node that overlaps another needs an opaque surface, or the box underneath shows
    // through its text. Taken from the host's design system so it follows the theme, with a
    // plain fallback for engines that do not resolve the token.
    /** Roots sit on a slightly firmer surface, so the top of the tree reads as the top. */
    const ROOT_SURFACE = 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,0.13))';
    const SURFACE_SOLID = 'var(--dsw-alias-bg-layer-2, Canvas)';
    // Same reasoning for stacking: the box being edited or dragged has to win both the paint
    // order and the click. Without this, clicking Save landed on the node underneath.
    const ELEVATION = 'var(--dsw-elevation-panel, 0 2px 10px rgba(0,0,0,0.28))';
    const HAIRLINE = 'rgba(128,128,128,0.24)';
    const MUTED = 0.62;
    // The row menu. It floats over the rows below it, so it needs the opaque surface and the
    // elevation for the same reason the node editor does.
    //
    // These two sit below HAIRLINE on purpose: reading it before its declaration is a temporal
    // dead zone error, which throws while the module is being evaluated — so the whole bundle
    // fails, no tab registers, and the pane quietly falls back to its start page. Nothing local
    // catches that: it is not a syntax error, and it is not a name from the wrong component.
    const MENU_STYLE = {
      position: 'absolute',
      top: '100%',
      right: 8,
      zIndex: 20,
      minWidth: 118,
      padding: 4,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      border: '1px solid ' + HAIRLINE,
      borderRadius: 8,
      background: SURFACE_SOLID,
      boxShadow: ELEVATION,
    };
    const MENU_ITEM_STYLE = {
      textAlign: 'left',
      padding: '5px 9px',
      border: 'none',
      borderRadius: 5,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 12,
      cursor: 'pointer',
    };

    /** Shared styling for the editor's two fields. */
    const INPUT_STYLE = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '3px 6px',
      border: '1px solid ' + HAIRLINE,
      borderRadius: 6,
      background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.06))',
      color: 'inherit',
      font: 'inherit',
      fontSize: 12,
    };

    /**
     * A diagram of each arrangement, for the toolbar.
     *
     * A centre with four spokes says "everything fans out from the middle"; blocks stepping down and
     * right say "layers, top to bottom". Both are read faster than the word for them, and the tighter
     * spacing of the last one is the whole difference between it and the first.
     */
    function ShapeIcon({ shape }) {
      const dot = (cx, cy, r) => h('circle', { key: cx + ':' + cy, cx, cy, r });
      const block = (x, y) => h('rect', { key: x + ':' + y, x, y, width: 5.4, height: 3.4, rx: 1 });
      const middle = shape === 'layers'
        ? [block(4.3, 0.6), block(0.6, 5.3), block(4.3, 5.3), block(8, 5.3), block(4.3, 10)]
        : shape === 'staircase'
        ? [block(0.6, 0.6), block(4.4, 5.3), block(8.2, 10)]
        : shape === 'compact'
          ? [dot(7, 7, 2), dot(7, 3.2, 1.3), dot(10.8, 7, 1.3), dot(7, 10.8, 1.3), dot(3.2, 7, 1.3)]
          : [dot(7, 7, 2.2), dot(7, 1.6, 1.5), dot(12.4, 7, 1.5), dot(7, 12.4, 1.5), dot(1.6, 7, 1.5)];
      return h('svg', {
        width: 14, height: 14, viewBox: '0 0 14 14', 'aria-hidden': true,
        style: { display: 'block' },
      }, middle);
    }

    const COLUMN = 208;
    /** Air between two stacked boxes. Rows are measured per box, so there is no fixed row height. */
    const ROW_GAP = 16;
    const BOX_W = 176;
    // How long the canvas takes to slide to a located node. Short enough to feel like an answer rather than
    // an animation, long enough to be seen — and being seen is half its job: it is the evidence that the
    // request ran at all.
    const GLIDE_MS = 300;
    /**
     * Parse the markdown subset the knowledge base actually uses.
     *
     * Blocks: fenced code, tables, unordered lists, ordered lists, paragraphs. Inline: bold and code.
     * Headings are not handled because these bodies do not use them — a node already has a title. Tables
     * were skipped on the same reasoning until real notes in this workspace turned out to contain them.
     *
     * @returns {Array<{type, text?, items?}>} blocks, each with plain strings for the renderer.
     */
    // Which session's pictures to ask for. Module-level because renderMarkdown is a plain function, far from the state that
// knows the session; the panel sets this when it mounts and when the session changes.
let assetSession = ''

function parseMarkdown(source) {
      const lines = String(source || '').split('\n');
      const blocks = [];
      let paragraph = [];
      let list = null;
      let fence = null;

      const flushParagraph = () => {
        if (paragraph.length === 0) return;
        blocks.push({ type: 'p', text: paragraph.join('\n') });
        paragraph = [];
      };
      const flushList = () => {
        if (!list) return;
        blocks.push(list);
        list = null;
      };

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (fence !== null) {
          if (/^\s*\`\`\`/.test(line)) {
            blocks.push({ type: 'code', text: fence.join('\n') });
            fence = null;
          } else {
            fence.push(line);
          }
          continue;
        }
        if (/^\s*\`\`\`/.test(line)) {
          flushParagraph();
          flushList();
          fence = [];
          continue;
        }
        // A table: a row of cells, then a separator row made of dashes. Both are needed — one line starting
        // with a pipe is just text, and treating it as a table would swallow ordinary prose.
        const cellsOf = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
        if (/^\s*\|/.test(line) && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[index + 1] || '')) {
          flushParagraph();
          flushList();
          const head = cellsOf(line);
          const rows = [];
          let at = index + 2;
          while (at < lines.length && /^\s*\|/.test(lines[at])) {
            rows.push(cellsOf(lines[at]));
            at += 1;
          }
          blocks.push({ type: 'table', head, rows });
          index = at - 1;
          continue;
        }
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (bullet || numbered) {
          flushParagraph();
          const kind = bullet ? 'ul' : 'ol';
          if (!list || list.type !== kind) {
            flushList();
            list = { type: kind, items: [] };
          }
          list.items.push((bullet || numbered)[1]);
          continue;
        }
        if (/^\s*$/.test(line)) {
          flushParagraph();
          flushList();
          continue;
        }
        flushList();
        paragraph.push(line);
      }
      // An unclosed fence is still shown as code: half a snippet reads better than a paragraph of it.
      if (fence !== null) blocks.push({ type: 'code', text: fence.join('\n') });
      flushParagraph();
      flushList();
      return blocks;
    }

    /**
     * Split one line into plain, bold and code spans.
     *
     * @returns {Array<{text, bold?, code?}>} spans in order.
     */
    function inlineSpans(source) {
      const content = String(source || '');
      const spans = [];
      const pattern = /(\*\*[^*]+\*\*|\`[^\`]+\`)/g;
      let at = 0;
      for (const match of content.matchAll(pattern)) {
        if (match.index > at) spans.push({ text: content.slice(at, match.index) });
        const token = match[0];
        if (token.slice(0, 2) === '**') spans.push({ text: token.slice(2, -2), bold: true });
        else spans.push({ text: token.slice(1, -1), code: true });
        at = match.index + token.length;
      }
      if (at < content.length) spans.push({ text: content.slice(at) });
      return spans;
    }

    /** Render one line of markdown as spans. */
    function renderInline(source, keyPrefix) {
      return inlineSpans(source).map((span, index) => {
        if (span.bold) {
          return h('strong', { key: keyPrefix + 'b' + index, style: { fontWeight: 700 } }, span.text);
        }
        if (span.code) {
          return h('code', {
            key: keyPrefix + 'c' + index,
            style: {
              padding: '0 3px', borderRadius: 3, fontSize: '0.94em',
              background: 'rgba(128,128,128,0.16)',
            },
          }, span.text);
        }
        return h('span', { key: keyPrefix + 't' + index }, span.text);
      });
    }

    /**
     * Render a node body as elements.
     *
     * Elements rather than HTML: the bodies come from a file the model writes, and feeding that through
     * innerHTML would make every note an injection point. React escapes text it is given, so this path
     * cannot execute anything.
     */
    function renderMarkdown(source, keyPrefix) {
      return parseMarkdown(source).map((block, index) => {
        const key = keyPrefix + index;
        if (block.type === 'p') {
      // A picture on its own line. Anything else in the paragraph stays text, so a body that merely mentions a path is not
      // turned into an image by accident.
      const picture = /^!\[[^\]]*\]\((assets\/[a-f0-9]{16}\.(?:png|jpe?g|gif|webp|svg))\)$/.exec(String(block.text || '').trim())
      // An attachment on its own line. Same shape as a picture line, different label: [名字](assets/xxx.md).
      const fileLink = /^\[([^\]]+)\]\((assets\/[a-f0-9]{16}\.[a-z0-9]{1,12})\)$/.exec(String(block.text || '').trim());
      if (fileLink) {
        const href = PREFIX + '/asset?' + (assetSession ? 'session=' + encodeURIComponent(assetSession) + '&' : '')
          + 'path=' + encodeURIComponent(fileLink[2]);
        return h('a', {
          key, href, target: '_blank', rel: 'noreferrer',
          title: '在新标签打开',
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 6, padding: '4px 9px',
            borderRadius: 6, border: '1px solid ' + HAIRLINE, textDecoration: 'none', color: 'inherit', fontSize: '0.94em',
          },
        }, '📎', h('span', { style: { maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, fileLink[1]));
      }
      if (picture) {
        const src = PREFIX + '/asset?' + (assetSession ? 'session=' + encodeURIComponent(assetSession) + '&' : '')
          + 'path=' + encodeURIComponent(picture[1])
        // Bounded height on purpose: an unbounded picture made the card taller than the box the user dragged out, and the
        // canvas wheel means zoom, so "scroll to see the rest" was not even available. Click opens the original.
        return h('a', {
          key,
          href: src,
          target: '_blank',
          rel: 'noreferrer',
          title: '在新标签打开原图',
          style: { display: 'block', marginTop: 6 },
        }, h('img', {
          src,
          alt: '',
          loading: 'lazy',
          style: {
            display: 'block', maxWidth: '100%', maxHeight: 160, height: 'auto', width: 'auto',
            objectFit: 'contain', borderRadius: 6, cursor: 'zoom-in',
          },
        }))
      }
    }
    if (block.type === 'code') {
          return h('pre', {
            key,
            style: {
              margin: '6px 0 0', padding: '6px 8px', borderRadius: 6,
              background: 'rgba(128,128,128,0.12)', fontSize: '0.94em', lineHeight: 1.4,
              // Wrapped rather than scrolled sideways. Most fenced blocks in these bodies are lists of
              // points, not source, and a canvas gives no hint that a clipped block can be dragged: at a
              // narrow width every line simply lost its end. Kept as a fallback for the rare unbreakable
              // token that wrapping cannot help with.
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere',
              overflowX: 'auto',
            },
          }, h('code', null, block.text));
        }
        if (block.type === 'table') {
          // Cells wrap: the same reasoning as the code block. A narrow node must not lose the end of a
          // cell, and a table in a note is a reading aid rather than something to scroll sideways.
          const cell = {
            border: '1px solid ' + HAIRLINE, padding: '3px 6px', verticalAlign: 'top',
            overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0,
          };
          return h('table', {
            key,
            style: {
              margin: '6px 0 0', borderCollapse: 'collapse', fontSize: '0.95em',
              width: '100%', tableLayout: 'fixed',
            },
          },
            h('thead', null, h('tr', null, block.head.map((value, at) => h('th', {
              key: at,
              style: Object.assign({}, cell, {
                textAlign: 'left', fontWeight: 600, background: 'rgba(128,128,128,0.10)',
              }),
            }, renderInline(value, key + '-h' + at))))),
            h('tbody', null, block.rows.map((row, rowAt) => h('tr', { key: rowAt },
              block.head.map((_, at) => h('td', { key: at, style: cell },
                renderInline(row[at] === undefined ? '' : row[at], key + '-' + rowAt + '-' + at)))))));
        }
        if (block.type === 'ul' || block.type === 'ol') {
          return h(block.type === 'ul' ? 'ul' : 'ol', {
            key,
            style: {
              margin: '4px 0 0', paddingLeft: 18,
              listStyleType: block.type === 'ul' ? 'disc' : 'decimal',
            },
          }, block.items.map((item, at) => h('li', { key: at }, renderInline(item, key + '-' + at))));
        }
        return h('div', { key, style: { marginTop: 4 } },
          block.text.split('\n').map((line, at) => h('div', { key: at }, renderInline(line, key + '-' + at))));
      });
    }

    /** The width range the store enforces, repeated here so the control and the store agree. */
    const MIN_BOX_W = 120;
    const MAX_BOX_W = 720;

    /**
     * The widest a box grows on its own, before somebody asks for more.
     *
     * Below MAX_BOX_W on purpose: the ceiling a user can drag to is not the ceiling a guess should reach,
     * and past this a box is wider than a comfortable reading measure while the canvas stops fitting.
     */
    const AUTO_MAX_W = 420;
    // Automatic cards stay browseable; full content scrolls inside the body. A user-set height wins.
    const AUTO_MAX_H = 320;

    /**
     * Parse a stamp: `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`.
     *
     * Both exist in the files. Nodes written before the time was recorded carry only a date, and reading
     * them as if they had a time would invent one.
     */
    function whenOf(at) {
      if (typeof at !== 'string') return null;
      const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(at.trim());
      if (!match) return null;
      const time = new Date(
        Number(match[1]), Number(match[2]) - 1, Number(match[3]),
        match[4] === undefined ? 0 : Number(match[4]),
        match[5] === undefined ? 0 : Number(match[5]),
      ).getTime();
      if (!Number.isFinite(time)) return null;
      return {
        time,
        date: match[1] + '-' + match[2] + '-' + match[3],
        clock: match[4] === undefined ? '' : match[4] + ':' + match[5],
      };
    }

    /** How much of the text around a match is shown. */
    const SNIPPET = 44;

    /**
     * Every node whose title or body contains the query.
     *
     * Case-insensitive, and a removed node is skipped: it is not current knowledge, so offering it as a
     * search result would send the reader to something the base has retired.
     *
     * One result per node, not per occurrence — a node that mentions the word six times is one place to
     * look, and six rows saying so would bury the other places. A title match is listed before a body
     * match, and the snippet is cut around the first body occurrence.
     *
     * @returns {Array<{baseId, baseName, nodeId, title, inTitle, snippet}>}
     */
    function searchBases(bases, query) {
      const needle = String(query || '').trim().toLowerCase();
      if (needle.length === 0) return [];
      const found = [];
      for (const base of bases || []) {
        for (const node of base.nodes || []) {
          if (node.change === 'removed') continue;
          const title = String(node.title || '');
          const body = String(node.body || '');
          const inTitle = title.toLowerCase().includes(needle);
          const at = body.toLowerCase().indexOf(needle);
          if (!inTitle && at === -1) continue;
          let snippet = '';
          if (at !== -1) {
            // Cut around the match rather than from the start: the beginning of a long note is rarely the
            // part worth seeing when you have just searched for a word.
            const from = Math.max(0, at - Math.floor(SNIPPET / 3));
            snippet = (from > 0 ? '…' : '') + body.slice(from, from + SNIPPET).replace(/\s+/g, ' ').trim()
              + (from + SNIPPET < body.length ? '…' : '');
          }
          found.push({
            baseId: base.id,
            baseName: base.name || base.id,
            nodeId: node.id,
            title,
            inTitle,
            snippet,
          });
        }
      }
      // Title matches first: a node named after the thing is usually the thing.
      found.sort((left, right) => (Number(right.inTitle) - Number(left.inTitle))
        || left.baseId.localeCompare(right.baseId)
        || left.nodeId.localeCompare(right.nodeId));
      return found;
    }

    /**
     * A label and a colour per session, for the byline shown under a node.
     *
     * The id is what the file stores and it is unreadable, so each one gets a letter. Letters are assigned
     * over a traversal in id order rather than in file order, so adding a node tomorrow does not rename the
     * sessions of today — a label that moves is worse than no label.
     */
    /**
     * A session id as the file name the host writes it under.
     *
     * Mirrors sessionFileStem in lib/session.js. It has to: the host names the file and the panel reads it,
     * and an id containing a colon — every IM session — was written encoded and read raw. The panel then
     * reported a missing file for a list that existed.
     *
     * check-client-loads.mjs compares this against the host's function on a spread of ids, so the copy
     * cannot drift unnoticed.
     */
    function sessionFileName(sessionId) {
      return String(sessionId || '').replace(/[^A-Za-z0-9._-]/g, (ch) => '%'
        + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
    }

    function sessionLabels(bases, names) {
      const ids = [];
      for (const base of bases || []) {
        for (const node of base.nodes || []) {
          if (typeof node.by === 'string' && node.by.length > 0 && !ids.includes(node.by)) ids.push(node.by);
        }
      }
      // Oldest first, so the colours run in the order the sessions appeared rather than in id order.
      const firstSeen = new Map();
      for (const base of bases || []) {
        for (const node of base.nodes || []) {
          if (typeof node.by !== 'string' || node.by.length === 0) continue;
          const when = whenOf(node.at);
          if (!when) continue;
          const seen = firstSeen.get(node.by);
          if (seen === undefined || when.time < seen) firstSeen.set(node.by, when.time);
        }
      }
      // Sorted by when each session first wrote, so the reading order matches the order they appeared.
      ids.sort((left, right) => (firstSeen.get(left) || 0) - (firstSeen.get(right) || 0));

      const labels = new Map();
      for (const id of ids) {
        // From the id, not from the position: assigned by position, adding one session shifted every
        // colour, and a colour that moves is not an identity. This one is the same forever.
        let hue = 0;
        for (let at = 0; at < id.length; at += 1) hue = (hue * 31 + id.charCodeAt(at)) % 360;
        // The user's name when they have given one; empty until then, because the node already prints the
        // time and a label made of the same time says nothing.
        const named = names && typeof names[id] === 'string' ? names[id] : '';
        labels.set(id, { label: named, hue });
      }
      return labels;
    }

    /** A short label for a stamp: today and yesterday by name, a date beyond that. */
    function shortWhen(at) {
      const parsed = whenOf(at);
      if (!parsed) return '';
      const days = Math.floor((Date.now() - parsed.time) / 86400000);
      if (days < 0) return parsed.date;
      if (days === 0) return '今天' + (parsed.clock ? ' ' + parsed.clock : '');
      if (days === 1) return '昨天' + (parsed.clock ? ' ' + parsed.clock : '');
      return parsed.date.slice(5);
    }

    /**
     * How wide a node box should be.
     *
     * A width set on *this node* is a decision about this node and is never second-guessed. A width set on
     * the base is a floor rather than an exact answer — a long body may need more room, and treating 176 as
     * exact turned every long note into a thin column, which is what happened once a base width had been
     * set: the estimate could never fire.
     *
     * The host has the same function for the same reason — it is the input to the horizontal step between
     * siblings — but the client half cannot import it, so it exists here too.
     */
    /**
     * The box a node occupies when its body is not drawn.
     *
     * Below `DETAIL_ZOOM` a node renders its title only, so the box on screen is shorter than the one the body
     * used to need — and the geometry has to know that, or every edge arrives at the edge of a box that is no
     * longer there. The user's description of the result was exact: the lines look cut in half.
     *
     * This is *not* the compact mode that was reverted. That one changed the width and the layout to make a
     * large base fit; this one only keeps the edges attached to what is actually drawn, and the width stays
     * whatever the reader set.
     */
    function oneLineBox(node, width) {
      const full = estimateBox(node)
      // The overview must reserve the same effective width as NodeBox, including per-node overrides.
      const boxWidth = Number.isFinite(width) ? width : full.w
      const title = String((node && node.title) || '')
      const perLine = Math.max(8, (boxWidth - BOX_PADDING) / GLYPH_W)
      const titleLines = Math.ceil((title.length / perLine) + 1)
      return { w: boxWidth, h: Math.max(BOX_H, Math.round(9 + titleLines * 22 + 9 + 15)) }
    }

    function boxOf(widths, nodeWidths, baseId, nodeId, node) {
      // A bare number is what this field used to hold: a width. Reading it as one keeps existing files
      // working, which is why the store does the same.
      const stored = nodeWidths && nodeId ? nodeWidths[nodeId] : undefined;
      const entry = stored && typeof stored === 'object' ? stored : stored === undefined ? {} : { w: stored };
      const box = {};
      if (Number.isFinite(entry.w)) box.w = entry.w;
      if (Number.isFinite(entry.h)) box.h = entry.h;
      if (box.w !== undefined) return box;
      const fromBase = Number.isFinite(widths ? widths[baseId] : undefined) ? widths[baseId] : BOX_W;
      box.w = node ? Math.max(fromBase, estimateBox(node).w) : fromBase;
      return box;
    }

    /** The width alone, for the layout's horizontal step. */
    function widthOf(widths, nodeWidths, baseId, nodeId, node) {
      return boxOf(widths, nodeWidths, baseId, nodeId, node).w;
    }
    const BOX_H = 62;

    /**
     * Does the segment a→b touch this box?
     *
     * Boxes carry their own width and height: a node grows taller when its text wraps, and using
     * one assumed height made a link start inside a two-line node and let the obstacle test miss
     * boxes it only grazed. Pure geometry, so the load check asserts on it rather than leaving it
     * to be eyeballed on the canvas.
     */
    function segmentHitsBox(a, b, box) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let near = 0;
      let far = 1;
      for (const [origin, delta, lo, hi] of [
        [a.x, dx, box.x, box.x + box.w],
        [a.y, dy, box.y, box.y + box.h],
      ]) {
        if (Math.abs(delta) < 1e-6) {
          // Parallel to this axis: inside the slab or not at all.
          if (origin < lo || origin > hi) return false;
          continue;
        }
        let enter = (lo - origin) / delta;
        let leave = (hi - origin) / delta;
        if (enter > leave) {
          const swap = enter;
          enter = leave;
          leave = swap;
        }
        near = Math.max(near, enter);
        far = Math.min(far, leave);
        if (near > far) return false;
      }
      return true;
    }

/** Roughly how wide one character is at the body's size, CJK included. */
const GLYPH_W = 15.5;

/** Padding either side of the text, plus the room the byline needs. */
const BOX_PADDING = 26;

/**
 * The zoom range, and the zoom below which nodes stop drawing their bodies.
 *
 * `MIN_ZOOM` is 0.12 rather than the 0.4 it started at. That floor was chosen for reading, and the reason to
 * zoom out is not reading — it is seeing the shape of a large base in order to reorganise it. A
 * thirty-three-node tree needs roughly 15% to fit, so at 40% the reader could never see more than three or
 * four nodes at once, and the "fit" button was clamped by the same floor.
 *
 * Below `DETAIL_ZOOM` a node draws its title and skips the body, which is illegible at that scale anyway.
 *
 * Module scope, not inside `Tree`, because `edgeStroke` needs them too and it lives up here with the rest of
 * the pure geometry — which is also what makes it checkable from a Node script.
 */
const MIN_ZOOM = 0.12;
const MAX_ZOOM = 2.6;
const DETAIL_ZOOM = 0.55;

/** Lines a version shows in the history card before it folds. See `VersionBody`. */
const FOLD_LINES = 6;

/**
 * The width and height a node wants, from its text alone.
 *
 * The width keeps the shape readable rather than fitting a constant: a body is assumed to want about ten
 * lines, so a longer one gets a wider box up to the ceiling and a short one stays at the floor. The default
 * used to be a fixed 176, and a body of a few hundred characters wrapped into twenty-odd lines — a thin
 * column, which is what the user reported.
 *
 * The height is computed at that width, in the same function, because a height counted at the wrong width
 * is simply wrong. Measuring is exact and happens a frame later; this covers the frame in between and any
 * case where the measurement comes back empty. It is deliberately generous — too tall leaves a gap, too
 * short is the bug being fixed.
 *
 * @returns {{w: number, h: number}} pixels, both inside the ranges the store enforces.
 */
function estimateBox(node) {
  const title = String((node && node.title) || '');
  const body = String((node && node.body) || '');
  const wanted = BOX_PADDING + ((body.length + title.length) / 10) * GLYPH_W;
  const w = Math.max(BOX_W, Math.min(AUTO_MAX_W, Math.round(wanted)));
  const perLine = Math.max(8, (w - BOX_PADDING) / GLYPH_W);
  const lines = (text) => (String(text || '').length / perLine) + 1;
  // The same cap is applied to the rendered box through sizeOf, not only to this estimate.
  // Otherwise the layout would reserve a small box while the actual long body overlaps its neighbours.
  const bodyLines = Math.ceil(lines(body));
  const titleLines = Math.ceil(lines(title));
  const h = Math.min(AUTO_MAX_H, Math.max(BOX_H, Math.round(9 + titleLines * 22 + 5 + bodyLines * 24 + 9 + 15)));
  return { w, h };
}

    /**
     * Which unread node the walk should go to next.
     *
     * `trail` loses an entry every time the walk runs, because landing on a node acknowledges it, and
     * `current` is the node already on screen. An index into the trail drifts against that shrink —
     * it reaches the end while items remain, and it skips the one after whatever it just reviewed.
     * Asking the question directly has one answer at every length.
     *
     * @returns the next item, or null when only the current node is left.
     */
    function nextUnread(trail, current) {
      if (!Array.isArray(trail)) return null;
      return trail.find((item) => item && item.node !== current) || null;
    }

    /** A box's centre. */
    function centreOf(rect) {
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    }

    /**
     * Where the straight line from one box's centre towards a point leaves that box.
     *
     * Drawn centre to centre the line would run under the text, so it is clipped to the box's own
     * rectangle. The size has to be the measured one: with a fixed height the exit point landed a
     * few pixels *inside* any node whose text had wrapped, so the dashed line visibly started
     * under the text instead of at the border.
     */
    function edgePoint(rect, towards) {
      const centre = centreOf(rect);
      const dx = towards.x - centre.x;
      const dy = towards.y - centre.y;
      if (dx === 0 && dy === 0) return centre;
      const scale = Math.min(
        dx === 0 ? Infinity : (rect.w / 2) / Math.abs(dx),
        dy === 0 ? Infinity : (rect.h / 2) / Math.abs(dy),
      );
      return { x: centre.x + dx * scale, y: centre.y + dy * scale };
    }

    /** Does a quadratic Bézier from a to b, with this control point, pass through the box? */
    function curveHitsBox(a, control, b, box) {
      // A quadratic and every sampled segment lie in the convex hull of these three points.
      // Most nodes are nowhere near this edge; reject them before the 12 segment tests.
      if (Math.max(a.x, control.x, b.x) < box.x
        || Math.min(a.x, control.x, b.x) > box.x + box.w
        || Math.max(a.y, control.y, b.y) < box.y
        || Math.min(a.y, control.y, b.y) > box.y + box.h) return false;
      const STEPS = 12;
      let previous = a;
      for (let step = 1; step <= STEPS; step += 1) {
        const t = step / STEPS;
        const u = 1 - t;
        const point = {
          x: u * u * a.x + 2 * u * t * control.x + t * t * b.x,
          y: u * u * a.y + 2 * u * t * control.y + t * t * b.y,
        };
        if (segmentHitsBox(previous, point, box)) return true;
        previous = point;
      }
      return false;
    }

    /**
     * The best drawing of one link between two boxes.
     *
     * Tries every attachment pair and keeps the one that crosses the fewest boxes. Sixteen short
     * searches per link buys the thing that actually matters here — a clean line — and costs
     * nothing at the scale this panel runs at. Crossings dominate the score, so a detour is only
     * ever chosen over a line through a node; length and bow then break the ties towards the
     * plainest option, which is why a straight line usually wins outright.
     */
    function bestLink(from, to, boxes) {
      let best = null;
      for (const start of anchorsOf(from)) {
        for (const end of anchorsOf(to)) {
          const control = routeLink(start, end, boxes);
          const crossed = boxes.filter((box) => curveHitsBox(start, control, end, box)).length;
          const bow = Math.hypot(control.x - (start.x + end.x) / 2, control.y - (start.y + end.y) / 2);
          const length = Math.hypot(end.x - start.x, end.y - start.y);
          const score = crossed * 100000 + length + bow * 2;
          if (!best || score < best.score) best = { start, end, control, crossed, bow, score };
        }
      }
      return best;
    }

    /**
     * Whether an edge should fade back because the pointer is on a node it does not touch.
     *
     * Pulled out as a function because the failure mode is invisible: fading the hovered node's
     * own edges looks like "the highlight did not work" and gives no clue which comparison is
     * wrong. With nothing under the pointer every edge stays lit.
     */
    /**
     * The colour of an edge at a given zoom, and why it is not a constant.
     *
     * The edges were `rgba(128,128,128,0.42)` at `1.1` units, inside a `transform: scale(k)` layer — so at 31%
     * they were a third of a pixel wide at 42% opacity, and the antialiasing turned that into a pale smudge.
     * The user's description of the result was exact: it reads as cards scattered on a background rather than
     * as a graph. That is backwards, because zooming out is *for* seeing the structure, and the lines are the
     * structure.
     *
     * So the weight is fixed in screen pixels (`vector-effect: non-scaling-stroke`, which does this natively
     * rather than by dividing by `k` by hand) and the contrast rises as the canvas shrinks — smoothly, because
     * a step at the threshold would be a visible pop at exactly the moment the reader is looking for structure.
     *
     * @param k - the canvas scale.
     * @returns a CSS colour, one of a continuous family between the two extremes.
     */
    function edgeStroke(k) {
      const FAR = 0.78         // at or below MIN_ZOOM: the lines are the subject
      const NEAR = 0.42        // at or above DETAIL_ZOOM: the bodies are the subject
      const span = DETAIL_ZOOM - MIN_ZOOM
      const t = span > 0 ? Math.min(1, Math.max(0, (DETAIL_ZOOM - k) / span)) : 0
      return 'rgba(128,128,128,' + (NEAR + (FAR - NEAR) * t).toFixed(3) + ')'
    }

    /**
     * Line-level diff between two versions of a node's body.
     *
     * The history card had no diff, and without one it does not actually answer "what changed". Two full bodies
     * side by side leave the reader to do the comparing — and the asymmetry is worse than it looks: an addition
     * is visible because the new text is longer, while a deletion means noticing an absence inside a wall of
     * text, which is the thing people are worst at. The user's question after reading a version that had grown
     * was exactly that: "what does it look like when something was removed?"
     *
     * Longest common subsequence over lines, then walk it. O(n·m) in lines, which for a knowledge node — tens
     * of lines, occasionally a couple of hundred — is nothing, and it is exact rather than heuristic. A
     * word-level diff would read better on a reworded sentence and is not worth the machinery here: the unit
     * people edit in these bodies is the line.
     *
     * @returns `{ old: [...], next: [...] }` — the same lines with a `kind` of `same` / `added` / `removed`.
     * `old` is what the earlier version said (its deleted lines marked); `next` is what the later one says (its
     * added lines marked). A line can only be `added` in `next` or `removed` in `old`, never both.
     */
    function diffLines(before, after) {
      const a = (typeof before === 'string' ? before : '').split('\n');
      const b = (typeof after === 'string' ? after : '').split('\n');
      /**
       * Whether two non-blank lines are the same line. Kept separate from the walk so the blank-line rule below
       * stays readable: this is exact string equality and nothing else.
       */
      const sameLine = (left, right) => left === right;
      // Lengths of the common suffix/prefix, thrown away before the table is built. Bodies are usually mostly
      // unchanged, so this is what keeps the quadratic part proportional to the edit rather than to the file.
      const table = [];
      for (let i = 0; i <= a.length; i += 1) table.push(new Array(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i -= 1) {
        for (let j = b.length - 1; j >= 0; j -= 1) {
          table[i][j] = sameLine(a[i], b[j])
            ? table[i + 1][j + 1] + 1
            : Math.max(table[i + 1][j], table[i][j + 1]);
        }
      }
      const old = [];
      const next = [];
      let i = 0;
      let j = 0;
      while (i < a.length && j < b.length) {
        if (sameLine(a[i], b[j])) {
          old.push({ kind: 'same', text: a[i] });
          next.push({ kind: 'same', text: b[j] });
          i += 1;
          j += 1;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
          old.push({ kind: 'removed', text: a[i] });
          i += 1;
        } else {
          next.push({ kind: 'added', text: b[j] });
          j += 1;
        }
      }
      while (i < a.length) { old.push({ kind: 'removed', text: a[i] }); i += 1; }
      while (j < b.length) { next.push({ kind: 'added', text: b[j] }); j += 1; }
      return { old, next };
    }

    /**
     * Whether a diff row is worth colouring.
     *
     * A blank line is a real difference — the diff is right to report it — but it is not a content change, and
     * marking it is worse than useless. The first real use of this card proved it: the only deletion between the
     * two versions of `o17` was a single empty line, so the card said "红色是之后被删掉的" and then pointed at a
     * red line that cannot be seen, because there is nothing on it. It spends the reader's attention and returns
     * nothing.
     *
     * So the diff stays exact and the *rendering* decides what deserves a mark. Whitespace-only lines are shown
     * plain, and the card's count of changes ignores them too — a count is a promise about how much there is to
     * look at, and it must not promise a blank line.
     */
    function worthMarking(row) {
      return row.kind !== 'same' && row.text.trim() !== '';
    }

    /**
     * What each kept version lost, given the version that replaced it.
     *
     * Extracted from the card because the rule it encodes is the one that was wrong, and wrong in a way nothing
     * reported: every entry was compared against the entry below it, but the newest entry is replaced by the
     * node itself — and the entry below it is often one written before the store kept contents, with no body at
     * all. So the comparison silently produced nothing and the newest version rendered with no marks, which is
     * exactly the "I still don't see any red" the reader reported. A pure function can be asserted; a chain of
     * ternaries inside a `.map` inside a JSX expression cannot.
     *
     * @param entries - history, newest first, as the store keeps it reversed for display.
     * @param currentBody - the node's own body: the version that replaced `entries[0]`.
     * @returns one `{ lines }` per entry, in the same order. `lines` is the marked old side, or null when there
     * is nothing to compare against — never an empty array pretending a comparison happened.
     */
    function historyMarks(entries, currentBody) {
      return entries.map((entry, index) => {
        const replacing = index === 0 ? { body: currentBody } : entries[index - 1];
        const lines = replacing && replacing.body !== undefined && entry.body !== undefined
          ? diffLines(entry.body || '', replacing.body || '').old
          : null;
        return { lines };
      });
    }

    function edgeFades(spotlight, fromId, toId) {
      return spotlight !== null && spotlight !== fromId && spotlight !== toId;
    }

    /**
     * The value the edge routing is memoised on.
     *
     * The routing is quadratic in the node count, so it must not run on a pan frame — and a memo keyed on the
     * objects it reads would never hit, because `ordered` and `placed` are rebuilt on every render. Hence a
     * string. The whole safety of that memo is this function: **if it omits an input, the edges are drawn
     * where things used to be, and nothing reports it.**
     *
     * So it is pure and it is exported on `__geometry`, which lets a check assert the property that matters:
     * change any single input and the key must change.
     *
     * @param boxes - one `{ id, parent, x, y, w, h }` per node, in render order. `w`/`h` may be null.
     * @param drag - the drag in flight, or null.
     * @param links - `[{ from, to, note }]`, every drawn link.
     * @param unsaved - iterable of `from>to` pairs drawn as pending.
     */
    function routeKeyOf(boxes, drag, links, unsaved) {
      // `kind` is part of the key: the band's colour depends on it, and a press that changes it without moving the
      // pointer would otherwise keep drawing the previous colour.
      const parts = [drag
        ? 'drag:' + (drag.kind || 'link') + ',' + drag.from + ',' + drag.x + ',' + drag.y
        : 'drag:-'];
      for (const box of boxes) {
        parts.push(box.id + '<' + (box.parent || '') + '>'
          + (box.x === null || box.x === undefined
            ? 'none'
            : box.x + ',' + box.y + ',' + box.w + ',' + box.h));
      }
      // The note is an input as well: the drawn curve does not depend on it, but the click target carries it
      // into the note editor, so a key that omitted it would open the editor holding a stale note.
      for (const link of links) parts.push(link.from + '>' + link.to + ':' + (link.note || ''));
      for (const id of unsaved) parts.push('unsaved:' + id);
      return parts.join('|');
    }

    /**
     * The points a link may attach to: the middle of each edge.
     *
     * Which one gets used is not a detail. Picking the point where the centre-to-centre line
     * crosses the border happens to be the worst choice whenever the target sits straight below the
     * source: the arrival is pinned to the top edge, the line has to come down through everything
     * stacked between them, and no amount of bowing fixes it. Entering from the side is often a
     * straight line through open canvas instead — the same nodes, the same link, a completely
     * different drawing.
     */
    function anchorsOf(rect) {
      return [
        { x: rect.x + rect.w / 2, y: rect.y },
        { x: rect.x + rect.w, y: rect.y + rect.h / 2 },
        { x: rect.x + rect.w / 2, y: rect.y + rect.h },
        { x: rect.x, y: rect.y + rect.h / 2 },
      ];
    }

    /**
     * Route a link between two boxes, bowing around whatever is in the way.
     *
     * Three things make this less obvious than it looks.
     *
     * The obstacle test follows the *curve*, not the straight chord. Testing the chord is not
     * conservative at all: the bow exists precisely to swing the line sideways, and the first
     * version curved happily through the neighbour of the box it was avoiding.
     *
     * The obstacle set only ever grows. Replacing it with whatever the new curve happens to hit
     * makes the router oscillate — bow, become clear, straighten, hit the box again — which is
     * exactly what the first attempt at this did.
     *
     * And the bow keeps widening until the curve reports clear. A quadratic deviates by 2t(1-t) of
     * its control offset, so it hugs the chord near its ends: a box sitting close to either
     * endpoint gets grazed even when the midpoint clears it by a wide margin, which is why the
     * analytic offset alone was not enough.
     *
     * And there is a ceiling on how hard this should try. Clearing a pair of stacked boxes needs a
     * control offset of several hundred pixels for a chord a few hundred long, because a quadratic
     * delivers only 2t(1-t) of its offset away from the midpoint. Past the point where the curve
     * stops looking like a line and starts looking like a loop, a slight graze reads better — so
     * the bow stays at the analytic minimum and no attempt is made to widen it.
     *
     * If one side cannot clear everything, the other is tried before giving up.
     */
    function routeLink(a, b, boxes) {
      const clear = (control) => boxes.every((box) => !curveHitsBox(a, control, b, box));
      const hitCount = (control) => boxes.filter((box) => curveHitsBox(a, control, b, box)).length;

      const march = (side) => {
        let known = [];
        let control = linkControlPoint(a, b, [], side);
        for (let pass = 0; pass < 8; pass += 1) {
          const added = boxes.filter(
            (box) => !known.includes(box) && curveHitsBox(a, control, b, box),
          );
          if (added.length > 0) known = known.concat(added);
          control = linkControlPoint(a, b, known, side);
          if (clear(control)) break;
        }
        return control;
      };

      const preferred = march(0);
      if (clear(preferred)) return preferred;
      const mirrored = march(-1);
      // Nothing clears everything: take the one that runs through the fewest boxes.
      return hitCount(mirrored) < hitCount(preferred) ? mirrored : preferred;
    }

    /**
     * The control point for a link between two boxes.
     *
     * A quadratic with its control at the chord's midpoint *is* the straight line, so the bowed
     * and un-bowed cases are one expression: the control moves sideways only when something is
     * actually in the way, by just enough to clear the worst of it, on whichever side needs less.
     * That is the whole point of this over the lane routing it replaced — the detour is local and
     * proportional, not a canvas-wide rectangle.
     */
    function linkControlPoint(a, b, obstacles, side = 0) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (!obstacles || obstacles.length === 0) return mid;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      if (length < 1e-6) return mid;
      const nx = -dy / length;
      const ny = dx / length;
      const ux = dx / length;
      const uy = dy / length;
      // Clearance is measured from the obstacle's corners, not from its centre plus half its
      // size. A line that only clips a corner needs a small shift, and the centre-based version
      // asked for a large one anyway. It changes nothing when a box is crossed through its
      // middle — that genuinely needs about half its width, which is why a long link that passes
      // over a node comes back as a wide arc rather than a gentle bend: there is no small detour
      // that misses a box the line runs through.
      const MARGIN = 10;
      let plus = 0;
      let minus = 0;
      for (const box of obstacles) {
        for (const corner of [
          { x: box.x, y: box.y },
          { x: box.x + box.w, y: box.y },
          { x: box.x, y: box.y + box.h },
          { x: box.x + box.w, y: box.y + box.h },
        ]) {
          const along = Math.max(0, Math.min(length, (corner.x - a.x) * ux + (corner.y - a.y) * uy));
          const side = (corner.x - (a.x + ux * along)) * nx + (corner.y - (a.y + uy * along)) * ny;
          if (side >= 0) plus = Math.max(plus, side + MARGIN);
          else minus = Math.max(minus, -side + MARGIN);
        }
      }
      // Choosing the cheaper side is only meaningful when both sides are occupied. With an
      // obstacle on one side only there is no choice: bowing the other way leaves it untouched.
      // (Written the other way round first, and a unit test caught it — bowing by zero is not a
      // cheap detour, it is no detour, and the line still runs through the box.)
      //
      // `side` forces a direction: 0 picks the cheaper one, +1 and -1 are the two sides as the
      // normal defines them. routeLink uses that to try the other side when one cannot clear
      // everything, which happens whenever two obstacles sit on the same side of the chord.
      const plusBlocked = plus > 0;
      const minusBlocked = minus > 0;
      let wanted = 0;
      if (side === 1) wanted = plus;
      else if (side === -1) wanted = -minus;
      else if (plusBlocked && minusBlocked) wanted = plus <= minus ? plus : -minus;
      else if (plusBlocked) wanted = plus;
      else if (minusBlocked) wanted = -minus;
      // A quadratic reaches half its control offset at the midpoint, so double it.
      return { x: mid.x + nx * wanted * 2, y: mid.y + ny * wanted * 2 };
    }

    /** A RemoteResult may arrive as {value} or bare; either way a failure must be thrown. */
    function unwrap(result) {
      if (result && typeof result === 'object') {
        if (result.error) throw result.error;
        if ('value' in result) return result.value;
      }
      return result;
    }

    /** Pre-order walk over parent links, since the file stores structure and not layout. */
    function layout(nodes) {
      const byParent = new Map();
      nodes.forEach((node) => {
        const key = node.parent === undefined ? null : node.parent;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(node);
      });
      const ordered = [];
      const walk = (parent, depth) => {
        (byParent.get(parent) || []).forEach((node) => {
          ordered.push({ node, depth });
          walk(node.id, depth + 1);
        });
      };
      walk(null, 0);
      // Anything whose parent is missing still has to appear, or the tree would hide it.
      nodes.forEach((node) => {
        if (!ordered.some((entry) => entry.node.id === node.id)) ordered.push({ node, depth: 0 });
      });
      return ordered;
    }

    /** A linear, iterative forest index. Malformed orphan/cyclic data remains inspectable. */
    function subtreeIndex(nodes) {
      const byId = new Map((nodes || []).map((node) => [node.id, node]));
      const parentOf = new Map();
      for (const node of byId.values()) parentOf.set(node.id,
        byId.has(node.parent) && node.parent !== node.id ? node.parent : null);
      const checked = new Set();
      for (const id of byId.keys()) {
        const path = new Set();
        let cursor = id;
        while (cursor !== null && !checked.has(cursor)) {
          if (path.has(cursor)) { parentOf.set(cursor, null); break; }
          path.add(cursor); cursor = parentOf.get(cursor);
        }
        for (const member of path) checked.add(member);
      }
      const children = new Map(), roots = [];
      for (const id of byId.keys()) children.set(id, []);
      for (const [id, parent] of parentOf) {
        if (parent === null) roots.push(id);
        else children.get(parent).push(id);
      }
      const order = [], stack = roots.slice().reverse();
      while (stack.length) {
        const id = stack.pop(); order.push(id);
        const kids = children.get(id);
        for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
      }
      const descendants = new Map(order.map((id) => [id, 0]));
      for (let i = order.length - 1; i >= 0; i -= 1) {
        const id = order[i], parent = parentOf.get(id);
        if (parent !== null) descendants.set(parent, descendants.get(parent) + descendants.get(id) + 1);
      }
      return { byId, parentOf, children, roots, order, descendants };
    }

    function foldedNodes(index, collapsedIds) {
      const folded = new Set(Array.isArray(collapsedIds) ? collapsedIds : []);
      const hidden = new Set();
      for (const id of index.order) {
        const parent = index.parentOf.get(id);
        if (parent !== null && (hidden.has(parent) || folded.has(parent))) hidden.add(id);
      }
      return hidden;
    }

    function applyCollapse(index, collapsedIds, operation) {
      const next = new Set(Array.isArray(collapsedIds) ? collapsedIds : []);
      if (operation.expandAll) return [];
      if (operation.reveal !== undefined) {
        let parent = index.parentOf.get(operation.reveal);
        while (parent !== undefined && parent !== null) { next.delete(parent); parent = index.parentOf.get(parent); }
      } else if (operation.collapsed && index.descendants.get(operation.node) > 0) next.add(operation.node);
      else if (operation.collapsed === false) next.delete(operation.node);
      return [...next];
    }

    function Glyph({ size = 16 }) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.35,
        strokeLinecap: 'round',
        'aria-hidden': true,
        style: { display: 'block' },
      },
        h('circle', { cx: 8, cy: 3.1, r: 1.75 }),
        h('circle', { cx: 3.3, cy: 12.4, r: 1.75 }),
        h('circle', { cx: 12.7, cy: 12.4, r: 1.75 }),
        h('path', { d: 'M7.3 4.5 L4.1 10.9 M8.7 4.5 L11.9 10.9' }),
      );
    }

    function Switch({ checked, onChange, label }) {
      const track = 36;
      const knob = 15;
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        onClick: () => onChange(!checked),
        style: {
          position: 'relative',
          flex: '0 0 auto',
          width: track,
          height: 21,
          padding: 0,
          border: '1px solid ' + (checked ? '#2e9e5b' : HAIRLINE),
          borderRadius: 11,
          background: checked ? '#2e9e5b' : 'rgba(128,128,128,0.10)',
          cursor: 'pointer',
          transition: 'background 130ms ease, border-color 130ms ease',
        },
      }, h('span', {
        'aria-hidden': true,
        style: {
          position: 'absolute',
          top: 2,
          left: checked ? track - knob - 3 : 2,
          width: knob,
          height: knob,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.28)',
          transition: 'left 130ms ease',
        },
      }));
    }

    /**
     * The model's mark on a node: added, modified, or parked.
     *
     * A dot in the top-right corner rather than a badge over the corner. The badge carried a glyph
     * and the node's left stripe repeated the colour, which spent the loudest part of the box on
     * information the reader did not ask for — and left nothing for the colour they choose
     * themselves. A dot is enough to notice; the tooltip and the ✓ are what act on it.
     */
    function Marker({ change }) {
      const marker = MARKERS[change];
      if (!marker) return null;
      return h('span', {
        title: marker.text,
        'aria-label': marker.text,
        style: {
          position: 'absolute',
          top: 5,
          right: 5,
          width: 8,
          height: 8,
          borderRadius: 4,
          background: marker.color,
          pointerEvents: 'none',
        },
      });
    }

    function NodeEditor({ node, x, y, onSave, onClose, color, onColor, onRemove, onPurge, onRevert, onAttachPicture, boxWidth, injectionMode, defaultInjection, onInjection }) {
      const [paletteOpen, setPaletteOpen] = React.useState(false);
  /** 上传完之后决定它在正文里的样子：图片是 ![]()，其它是 [名字]()。 */
  const appendAttachment = (saved) => {
    // onAttachPicture resolves to the path itself; the uploader that hands back an object is a different call site. Accepting
    // both is cheaper than two helpers — but it has to be explicit, because reading `.rel` off a string just silently did nothing.
    const rel = typeof saved === 'string' ? saved : saved && saved.rel;
    if (!rel) {
      setAttachProblem((saved && saved.error) || '附件没有上传成功');
      return;
    }
    setAttachProblem('');
    const shown = (typeof saved === 'object' && saved && saved.name) || rel.split('/').pop();
    const isImage = /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(rel);
    const line = isImage ? '![](' + rel + ')' : '[' + shown + '](' + rel + ')';
    setBody((current) => (current.trimEnd() ? current.trimEnd() + '\n\n' : '') + line);
  };


      const [title, setTitle] = React.useState(node.title || '');
      const [body, setBody] = React.useState(node.body || '');

  /** 正文里引用到的附件，去重后最多 6 个；编辑器下方就地显示，点了就能移除。 */
  const [attachProblem, setAttachProblem] = React.useState('');
  /** 正文里这个附件写着什么名字：取 [名字](path) 的标签，没有就用存储名。 */
  const labelOf = (rel) => {
    const found = new RegExp('\\[([^\\]]+)\\]\\(' + rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)').exec(String(body || ''));
    return found ? found[1] : '';
  };
  const attachedRefs = [...new Set(String(body || '').match(/assets\/[a-f0-9]{16}\.[a-z0-9]{1,5}/g) || [])].slice(0, 6);
      const gone = node.change === 'removed';
      return h('div', {
        // Kept for hit testing, which must still find the editor under the pointer.
        'data-node-id': node.id,
        // Skipped by the measurement: this element's height is not the node's height.
        'data-kb-editor': 'true',
        onPointerDown: (event) => event.stopPropagation(),
        style: {
          position: 'absolute',
          left: x,
          top: y,
          // A floor, because this is a form: three buttons and a colour control do not fit in a
          // 120px box, and the node's own width is what the user was sizing.
          width: Math.max(boxWidth || BOX_W, 250),
          minHeight: BOX_H,
          boxSizing: 'border-box',
          padding: '9px 11px 9px 13px',
          border: '1px solid ' + HAIRLINE,
          borderLeft: '3px solid ' + (node.change ? MARKERS[node.change].color : 'transparent'),
          borderRadius: 9,
          // Opaque and lifted: the editor is taller than a node box, so it necessarily overlaps
          // the node below, and it has to read as sitting on top of that node — and receive the
          // click, or Save would hit the box underneath.
          zIndex: 40,
          background: SURFACE_SOLID,
          boxShadow: ELEVATION,
          font: 'inherit',
          opacity: gone ? 0.85 : 1,
        },
      },
        h('input', {
          value: title,
          autoFocus: true,
          'aria-label': '节点标题',
          onChange: (event) => setTitle(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') { event.preventDefault(); onSave(node.id, { title, body }); }
            if (event.key === 'Escape') { event.preventDefault(); onClose(node.id); }
          },
          style: Object.assign({}, INPUT_STYLE, { fontWeight: 600, marginBottom: 4 }),
        }),
        h('textarea', {
          onPaste: (event) => {
            const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'));
            if (!item) return;
            const file = item.getAsFile();
            if (!file) return;
            event.preventDefault();
            onAttachPicture(file).then(appendAttachment);
          },
          onDragOver: (event) => event.preventDefault(),
          onDrop: (event) => {
            const files = [...(event.dataTransfer?.files || [])];
            if (files.length === 0) return;
            event.preventDefault();
            for (const file of files) onAttachPicture(file).then(appendAttachment);
          },
          value: body,
          // The height follows the text, up to a point. A fixed two rows meant editing a paragraph through
          // a letterbox, and the box gave no clue how much there was. The ceiling is there because a very
          // long body should scroll rather than push the buttons off the canvas; below it, drag the corner
          // and it stays where you put it.
          rows: Math.max(3, Math.min(18, String(body || '').split('\n').length + 1)),
          'aria-label': '节点内容',
          onChange: (event) => setBody(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') { event.preventDefault(); onClose(node.id); }
          },
          style: Object.assign({}, INPUT_STYLE, { resize: 'vertical', lineHeight: 1.45 }),
        }),

        h('label', { style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, fontSize: 12 } },
          '内容注入', h('select', {
            'aria-label': '节点内容注入方式', value: injectionMode || 'inherit',
            onChange: (event) => onInjection(node.id, event.target.value),
            style: { font: 'inherit', color: 'inherit', background: SURFACE_SOLID, border: '1px solid ' + HAIRLINE, borderRadius: 5, padding: 3 },
          }, h('option', { value: 'inherit' }, '跟随知识库（' + (defaultInjection === 'full' ? '全文' : '按需') + '）'),
            h('option', { value: 'full' }, '全文注入'), h('option', { value: 'index' }, '按需读取'))),
        h('div', { style: { fontSize: 11, opacity: 0.65, marginTop: 4 } }, '立即保存，仅设置此节点；同工作区共享。'),
        // 附件入口：点它选文件，或把文件拖进这个方框。虚线框是「可放东西进来」的通用约定。
        h('label', {
          'data-kb-attach': 'box',
          title: '添加附件：图片直接显示，其它文件显示成附件条',
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            marginTop: 6, height: 34, borderRadius: 8, border: '1px dashed ' + HAIRLINE,
            fontSize: 11.5, opacity: 0.7, cursor: 'pointer',
          },
          onDragOver: (event) => event.preventDefault(),
          onDrop: (event) => {
            event.preventDefault();
            for (const file of [...(event.dataTransfer?.files || [])]) onAttachPicture(file).then(appendAttachment);
          },
        }, h('span', { style: { fontSize: 14, lineHeight: 1 } }, '＋'), '添加附件',
          h('input', {
            type: 'file', multiple: true, style: { display: 'none' },
            onChange: (event) => {
              for (const file of [...(event.target.files || [])]) onAttachPicture(file).then(appendAttachment);
              event.target.value = '';
            },
          })),

          // 已经进正文的附件就地显示：缩略图或文件条，带 × 移除。没有这一条，用户只能从 markdown 猜自己有没有成功。
          attachProblem ? h('div', {
          style: { marginTop: 6, fontSize: 11.5, color: '#c0392b' },
          'data-kb-attach-error': 'true',
        }, '附件没有上传成功：' + attachProblem) : null,
        attachedRefs.length > 0 ? h('div', { style: { marginTop: 2 } }, attachedRefs.map((rel) => {
            const isImage = /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(rel);
            const src = PREFIX + '/asset?' + (assetSession ? 'session=' + encodeURIComponent(assetSession) + '&' : '')
              + 'path=' + encodeURIComponent(rel);
            return h('span', { key: rel, style: { display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 8, marginTop: 6 } },
              isImage ? h('img', { src, alt: '', style: { height: 44, borderRadius: 4, border: '1px solid ' + HAIRLINE } })
                : h('span', { style: { fontSize: 11, opacity: 0.75 } }, '📎 ' + (labelOf(rel) || rel.split('/').pop())),
              h('button', {
                type: 'button',
                title: '从正文里移除这个附件（文件仍留在 assets 里）',
                onClick: () => setBody((current) => current.split('\n').filter((line) => !line.includes(rel)).join('\n')),
                style: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, opacity: 0.6, padding: 0 },
              }, '×'),
            );
          })) : null,
        // A fixed set of swatches rather than a colour picker: five choices are enough to say "this
        // one matters", and a native picker would put an OS dialog in the middle of a canvas.
        // One button showing the current colour, opening a small panel. A native picker was never an
        // option — it puts an OS dialog in the middle of a canvas — and six swatches plus 无色 took most
        // of the row on their own.
        h('div', {
          style: { display: 'flex', gap: 6, marginTop: 8, alignItems: 'center', position: 'relative' },
        },
          h('span', { style: { fontSize: 11, opacity: 0.6 } }, '标记'),
          h('button', {
            type: 'button',
            title: '这个节点的标记颜色',
            'aria-expanded': paletteOpen,
            onClick: () => setPaletteOpen((current) => !current),
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '1px 7px', border: '1px solid ' + HAIRLINE, borderRadius: 6,
              background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 11,
              cursor: 'pointer',
            },
          },
            h('span', {
              style: {
                width: 11, height: 11, borderRadius: 6, display: 'inline-block',
                background: color || 'transparent',
                border: '1px solid ' + (color ? 'transparent' : HAIRLINE),
              },
            }),
            h('span', null, color ? '已设' : '无色'),
          ),
          paletteOpen ? h('div', {
            'data-kb-palette': 'true',
            style: {
              position: 'absolute', left: 34, top: 22, zIndex: 6,
              display: 'flex', gap: 5, alignItems: 'center', padding: 5,
              // SOLID, not SURFACE. `SURFACE` is 7% grey — right for a card sitting in a list, where seeing the
              // layers through it is the point. This is a popover over a node's text, and a menu you can read the
              // sentence behind is a menu you have to squint at.
              border: '1px solid ' + HAIRLINE, borderRadius: 8, background: SURFACE_SOLID,
              boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
            },
          },
            ...NODE_COLORS.map((swatch) => h('button', {
              key: swatch.hex,
              type: 'button',
              title: swatch.name,
              'aria-label': swatch.name,
              onClick: () => { onColor(node.id, swatch.hex); setPaletteOpen(false); },
              style: {
                width: 16, height: 16, padding: 0, borderRadius: 8, background: swatch.hex,
                border: color === swatch.hex ? '2px solid rgba(128,128,128,0.9)' : '1px solid ' + HAIRLINE,
                cursor: 'pointer',
              },
            })),
            h('button', {
              type: 'button',
              onClick: () => { onColor(node.id, null); setPaletteOpen(false); },
              style: {
                padding: '1px 6px', border: '1px solid transparent', borderRadius: 6,
                background: 'transparent', color: 'inherit', font: 'inherit',
                fontSize: 11, cursor: 'pointer', opacity: 0.65,
              },
            }, '无色'),
          ) : null,
        ),
        h('div', { style: { display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' } },
          h('button', {
            type: 'button',
            onClick: () => onSave(node.id, { title, body }),
            style: {
              padding: '2px 9px', border: '1px solid ' + HAIRLINE, borderRadius: 6,
              background: 'transparent', color: 'inherit', font: 'inherit',
              fontSize: 11.5, cursor: 'pointer',
            },
          }, '保存'),
          // Only when there is something to undo, and only for this node: the editor is where someone notices they want it.
          node.change ? h('button', {
            type: 'button',
            title: '把这个节点还没看过的改动撤回：新增的删掉、改过的回到上一版、移除的恢复',
            onClick: () => onRevert(node.id),
            style: {
              padding: '2px 9px', border: '1px solid ' + HAIRLINE, borderRadius: 6,
              background: 'transparent', color: 'inherit', font: 'inherit',
              fontSize: 11.5, cursor: 'pointer',
            },
          }, '撤销改动') : null,
          // Two stages on one button. On a live node it marks the node removed — reversible, and the
          // marker is what makes the change reviewable. On an already-removed node the same place
          // offers the permanent delete, so an unwanted node does not have to sit in the canvas.
          node.change === 'removed' ? h('button', {
            type: 'button',
            title: '从文件里彻底删掉这个节点，无法撤销',
            onClick: () => onPurge(node.id),
            style: {
              marginLeft: 'auto', padding: '2px 9px', border: '1px solid rgba(192,57,43,0.7)',
              borderRadius: 6, background: 'rgba(192,57,43,0.10)', color: '#c0392b', font: 'inherit',
              fontSize: 11.5, cursor: 'pointer',
            },
          }, '彻底删除') : h('button', {
            type: 'button',
            title: '标记为已废弃：节点保留并变灰，不再注入给模型，孩子上提到它的父节点',
            onClick: () => onRemove(node.id),
            style: {
              marginLeft: 'auto', padding: '2px 9px', border: '1px solid rgba(192,57,43,0.45)',
              borderRadius: 6, background: 'transparent', color: '#c0392b', font: 'inherit',
              fontSize: 11.5, cursor: 'pointer',
            },
          }, '废弃'),
          h('button', {
            type: 'button',
            onClick: () => onClose(node.id),
            style: {
              padding: '2px 9px', border: '1px solid transparent', borderRadius: 6,
              background: 'transparent', color: 'inherit', font: 'inherit',
              fontSize: 11.5, cursor: 'pointer', opacity: 0.7,
            },
          }, '取消'),
          h('span', { style: { fontSize: 11, opacity: 0.55 } }, '回车保存 · Esc 取消'),
        ),
      );
    }

    /**
     * A body that slides open and closed.
     *
     * Height is the one property the rules allow here — there is no transform equivalent that
     * does not squash the content — and it costs layout on every frame, which is why the
     * duration stays at 200ms rather than the longer feel a panel this tall seems to invite.
     * The height is measured instead of animating to `auto`, and once open it settles back to
     * `auto` so a tree that grows while it is open does not get clipped.
     */
    function Collapsible({ open, children }) {
      const ref = React.useRef(null);
      const [height, setHeight] = React.useState(open ? 'auto' : '0px');
      const seen = React.useRef(false);

      React.useLayoutEffect(() => {
        const node = ref.current;
        if (!node) return undefined;
        // Collapsed content must not be reachable by Tab, or focus vanishes into a zero-height
        // box and the next Tab press looks like it did nothing.
        node.inert = !open;
        if (!seen.current) {
          seen.current = true;
          setHeight(open ? 'auto' : '0px');
          return undefined;
        }
        if (open) {
          setHeight(node.scrollHeight + 'px');
          return undefined;
        }
        // Closing: to a pixel value in this frame, to zero on the next. Going straight from
        // `auto` to `0px` leaves the transition nothing to interpolate from.
        setHeight(node.scrollHeight + 'px');
        const frame = requestAnimationFrame(() => setHeight('0px'));
        return () => cancelAnimationFrame(frame);
      }, [open]);

      return h('div', {
        ref,
        'data-kb-collapse': 'true',
        style: { height, opacity: open ? 1 : 0, overflow: 'hidden' },
        onTransitionEnd: (event) => {
          // Settle back to auto once the opening motion is over.
          if (open && event.propertyName === 'height') setHeight('auto');
        },
      },
        // Rendered per instance rather than once, so it exists whenever a body does, with no
        // dependency on some other component happening to be mounted. Duplicate identical style
        // tags are harmless.
        h('style', null,
          '[data-kb-collapse] { transition: height 200ms cubic-bezier(.22,1,.36,1),'
          + ' opacity 200ms cubic-bezier(.22,1,.36,1); }'
          // Reduced motion keeps the fade and drops the resize movement: fewer and gentler, not
          // zero — and the thing that changes position is what goes.
          + '@media (prefers-reduced-motion: reduce) {'
          + ' [data-kb-collapse] { transition: opacity 120ms linear, height 1ms linear; } }'),
        children,
      );
    }

    function NodeBox({
      entry, x, y, onPressStart, onActivate, onReview, onSpotlight, color, isFocus, onNodeMenu,
      isSource, isTarget, isEdited, isArmed, boxWidth, boxHeight, liveWidth, liveHeight, onResizeStart,
      byline, injectionMode, descendantCount, collapsed, onToggleCollapse,
      onRename,
      /** False when the canvas is zoomed out far enough that a body would be illegible. */
      detail,
    }) {
      const node = entry.node;
      const bodyRef = React.useRef(null);
      const contentRef = React.useRef(null);
      const scrollHintRef = React.useRef(null);
      const [bodyOverflows, setBodyOverflows] = React.useState(false);
      React.useLayoutEffect(() => {
        const body = bodyRef.current;
        const content = contentRef.current;
        if (!body || !content || detail === false) {
          setBodyOverflows(false);
          return undefined;
        }
        const measure = () => {
          // Account for the hint's own height so showing it cannot manufacture an overflow.
          const hintHeight = scrollHintRef.current ? scrollHintRef.current.offsetHeight : 0;
          const next = body.scrollHeight > body.clientHeight + hintHeight + 1;
          setBodyOverflows((current) => current === next ? current : next);
        };
        measure();
        // Watch content as well: an image can load without resizing its scroll viewport.
        if (typeof ResizeObserver !== 'function') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(body);
        observer.observe(content);
        return () => observer.disconnect();
      }, [detail, node.id]);
      const gone = node.change === 'removed';
      // The reader's own colour for this node, if they set one. It takes the stripe; the model's
      // mark no longer competes for it. Declared before the line that reads it — this exact
      // ordering mistake is why the panel has been blank twice.
      const owned = typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : null;
      // Nothing by default: an uncoloured node shows a bare edge, not a coloured one that means
      // nothing. The change dot says what the model did; this says what the reader thinks.
      const accent = owned || 'transparent';
      // A base can have several roots — the flow base has two — and all of them are top level.
      const isRoot = (entry.depth || 0) === 0;
      const isDeep = (entry.depth || 0) >= 2;
      const markdown = React.useMemo(() => detail === false ? null
        : renderMarkdown(node.body, 'md' + node.id), [node.id, node.body, detail]);

      return h('div', {
        // Hit testing reads this back off the element, so the drag needs no coordinate math.
        'data-node-id': node.id,
        'data-kb-node': 'true',
        // The context menu is declared once, further down beside the pointer handlers that it has to agree
        // with. Declaring it here as well is what broke it: in an object literal the later key silently wins,
        // so this handler never ran and every right-click fell through to the canvas.
        'data-armed': isArmed ? 'true' : undefined,
        'data-target': isTarget ? 'true' : undefined,
        'data-focus': isFocus ? 'true' : undefined,
        // Pointer events rather than mouse events, and on the box itself: the canvas is scaled and
        // panned, so anything that computes "which node is under the cursor" by hand drifts.
        onPointerEnter: () => onSpotlight(node.id),
        onPointerLeave: () => onSpotlight(null),
        onFocus: () => onSpotlight(node.id),
        onBlur: () => onSpotlight(null),
        title: detail === false ? node.title : undefined,
        onPointerDown: (event) => {
          // The right button is the menu's. It used to start a link here, which meant every right-click
          // also began a connection and the two gestures could not be told apart.
          if (event.button !== 0) return;
          onPressStart(node.id, event);
        },
        onContextMenu: (event) => {
          // Two handlers for one key used to sit here — this one and the history one above — and in an
          // object literal the last wins, so the history menu was never reachable: every right-click fell
          // through to the canvas and offered 新建节点.
          event.preventDefault();
          event.stopPropagation();
          // A menu rather than the history directly: right-click is the only gesture left that can mean "do
          // something with this node", and structure now lives there too. History is the third item, so nothing
          // became unreachable.
          if (onNodeMenu) onNodeMenu(node.id, event);
        },
        tabIndex: 0,
        role: 'button',
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onActivate(node.id, event.shiftKey ? 'link' : 'edit');
        },
        style: {
          position: 'absolute',
          left: x,
          top: y,
          width: liveWidth || boxWidth || BOX_W,
          // A set height fixes the box and its body scrolls. Without a height the box grows with its
          // text, which is the normal case and not something to override.
          height: liveHeight || boxHeight || undefined,
          overflow: (liveHeight || boxHeight) ? 'hidden' : undefined,
          display: 'flex',
          flexDirection: 'column',
          minHeight: BOX_H,
          boxSizing: 'border-box',
          padding: '9px 11px 9px 13px',
          border: '1px solid ' + (gone
            ? 'rgba(192,57,43,0.45)'
            : isRoot ? 'rgba(128,128,128,0.55)' : isDeep ? 'rgba(128,128,128,0.14)' : HAIRLINE),
          borderLeft: '3px solid ' + accent,
          borderRadius: 9,
          // While it is being dragged a node passes over its neighbours, so it has to be
          // opaque and on top for the same reason the editor does.
          zIndex: isArmed ? 30 : 1,
          background: isArmed ? SURFACE_SOLID : (isRoot ? ROOT_SURFACE : SURFACE),
          opacity: gone ? 0.6 : 1,
          font: 'inherit',
          // No inline `outline`: the armed, target and focus-visible outlines all live in the
          // component stylesheet, because an inline value would win over `:focus-visible`.
          boxShadow: isArmed ? ELEVATION : (isSource
            ? '0 0 0 2px #c9761b inset'
            : isRoot ? ELEVATION : 'none'),
          touchAction: 'none',
        },
      },
        h(Marker, { change: node.change }),
        isEdited ? h('span', {
          // Hung off the corner rather than inside it. Every inside corner is occupied — the change
          // dot owns the top-right, the ✓ owns the bottom-right, and the title and body run through
          // the other two — so an inside dot lands on the text. It only appears when a save failed,
          // so it is a warning, and amber rather than grey.
          title: '改动没保存成功',
          style: {
            position: 'absolute', bottom: -5, left: -5, width: 10, height: 10,
            borderRadius: 5, background: '#c9761b',
            boxShadow: '0 0 0 2px ' + (isArmed ? SURFACE_SOLID : SURFACE),
          },
        }) : null,
        // Accept the model's change without changing it. Editing the text also clears the
        // marker, but having to touch the wording just to nod at it is a bad habit to teach.
        node.change && node.change !== 'removed' ? h('button', {
          type: 'button',
          title: '看过了 —— 清掉这个复核标记',
          onPointerDown: (event) => event.stopPropagation(),
          onClick: (event) => {
            event.stopPropagation();
            onReview(node.id);
          },
          style: {
            position: 'absolute', bottom: -9, right: -9, width: 18, height: 18,
            boxSizing: 'border-box', padding: 0,
            border: '1px solid ' + HAIRLINE, borderRadius: 9,
            background: SURFACE_SOLID, color: 'inherit', font: 'inherit',
            fontSize: 11, lineHeight: '16px', cursor: 'pointer', zIndex: 3,
          },
        }, '✓') : null,
        h('div', {
          'data-kb-node-title': 'true',
          style: {
            fontSize: isRoot ? 17 : 16,
            flexShrink: 0,
            fontWeight: isRoot ? 700 : 600,
            letterSpacing: isRoot ? 0 : 0.1,
            textDecoration: gone ? 'line-through' : 'none',
            overflowWrap: 'anywhere', wordBreak: 'break-word',
          },
        },
          descendantCount > 0 ? h('button', {
            type: 'button',
            'data-kb-collapse': node.id,
            'aria-expanded': !collapsed,
            'aria-label': (collapsed ? '展开子树：' : '折叠子树：') + node.title,
            title: collapsed ? '展开子树' : '折叠子树',
            onPointerDown: (event) => event.stopPropagation(),
            onKeyDown: (event) => event.stopPropagation(),
            onClick: (event) => { event.stopPropagation(); onToggleCollapse(node.id); },
            style: { width: 22, height: 22, padding: 0, marginRight: 3, border: 'none', borderRadius: 4,
              background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', verticalAlign: 'baseline' },
          }, collapsed ? '▸' : '▾') : null,
          node.title,
          // The id, because that is what the tools and the conversation call this node. Without it, "read
          // o14" is an instruction you cannot follow: the canvas shows titles, and nothing on screen says
          // which one is o14.
          //
          // A bordered chip rather than dimmed text. The box is already a muted grey, so opacity on top of it
          // produced grey-on-grey that could not be read — and this is a handle, not part of the title, so it
          // should look like a tag. The border carries the contrast; the text stays close to full strength.
          h('span', {
            style: {
              marginLeft: 5, fontSize: 9.5, fontWeight: 500, lineHeight: '14px',
              padding: '0 4px', borderRadius: 4, border: '1px solid ' + HAIRLINE,
              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', opacity: 0.85,
            },
          }, node.id),
          injectionMode ? h('span', {
            'data-kb-injection': injectionMode,
            title: '此节点单独指定为' + (injectionMode === 'full' ? '全文注入' : '按需读取') + '，不影响子节点',
            style: { marginLeft: 5, fontSize: 11, fontWeight: 400, whiteSpace: 'nowrap' },
          }, injectionMode === 'full' ? '全文' : '按需') : null,
          descendantCount > 0 ? h('span', {
            'data-kb-collapse-summary': collapsed ? 'collapsed' : 'expanded',
            style: { display: 'block', height: 16, lineHeight: '16px', marginTop: 3, fontSize: 11,
              fontWeight: 400, opacity: 0.8, whiteSpace: 'nowrap' },
          }, collapsed ? '已收起 ' + descendantCount + ' 个节点' : descendantCount + ' 个后代节点') : null,
        ),
        // `overflowWrap: anywhere` so a long identifier or path breaks instead of running out of the
        // box and under its neighbour, which is what made the canvas look like it was stacking.
        h('div', {
          'data-kb-node-body': 'true',
          ref: bodyRef,
          'data-kb-overflow': bodyOverflows ? 'true' : undefined,
          tabIndex: bodyOverflows && detail !== false ? 0 : undefined,
          'aria-label': bodyOverflows ? '长文正文，可滚动阅读' : undefined,
          onKeyDown: (event) => {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) event.stopPropagation();
          },
          'data-kb-scroll': 'true',
          style: {
            marginTop: 5, fontSize: 15, opacity: 0.88, lineHeight: 1.55,
            overflowWrap: 'anywhere', wordBreak: 'break-word',
            // A fixed-height box scrolls its text. minHeight: 0 is what allows a flex child to be smaller
            // than its content; without it the box grows anyway and the setting does nothing.
            minHeight: 0,
            // Always scrollable and always marked: with a fixed height only, a node that had neither a live height nor a
            // dragged one could not be scrolled at all — the text overflowed, the box did not grow, and the wheel over it
            // zoomed the canvas. A box that fits its content shows no scrollbar, so this costs nothing when empty.
            overflowY: 'auto',
            scrollbarWidth: 'thin',
            scrollbarGutter: 'stable',
            scrollbarColor: 'rgba(128,128,128,0.85) rgba(128,128,128,0.18)',
            overscrollBehavior: 'contain',
            // Only when it actually scrolls: the mark tells the canvas to leave the wheel alone.
            // Parenthesised because the conditional binds to the spread's operand — which is what is
            // wanted, but reads as if it were not.
          },
        }, h('div', { ref: contentRef, 'data-kb-node-content': 'true' }, markdown)),
        bodyOverflows && detail !== false ? h('div', {
          ref: scrollHintRef,
          'data-kb-scroll-hint': 'true',
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
            flexShrink: 0, paddingTop: 4, fontSize: 11.5, lineHeight: '17px',
          },
        }, h('span', { style: { opacity: 0.8 } }, '↕ 长文 · 滚动阅读'),
          h('button', {
            type: 'button',
            'aria-label': '编辑长文节点：' + node.title,
            onPointerDown: (event) => event.stopPropagation(),
            onKeyDown: (event) => event.stopPropagation(),
            onClick: (event) => { event.stopPropagation(); onActivate(node.id, 'edit'); },
            style: {
              padding: '0 5px', border: '1px solid ' + HAIRLINE, borderRadius: 4,
              background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', flexShrink: 0,
            },
          }, '编辑')) : null,
        // The stamp, when the file has one. Absent stays absent: a node written before stamps existed has
        // no date, and showing a made-up one would be worse than showing nothing.
        detail !== false ? h('div', {
          style: {
            marginTop: 5, fontSize: 11, opacity: 0.7, fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
            display: 'flex', gap: 5, alignItems: 'baseline', flexWrap: 'wrap',
          },
        },
          node.at ? h('span', null, '写入 ' + shortWhen(node.at)) : null,
          // A dot when the session has no name yet. The colour groups a session's edits at a glance — that
          // part works — while the text waits for a name worth printing. The time above already says when,
          // so a label made of the same time would say nothing, and the letter it used to show said
          // something false: it came from sorting ids.
          byline ? h(onRename ? 'button' : 'span', {
            type: onRename ? 'button' : undefined,
            onClick: onRename ? (event) => { event.stopPropagation(); onRename(); } : undefined,
            title: byline.label
              ? '这个节点是「' + byline.label + '」写的'
              : '这个节点是另一个会话写的（还没有名字）',
            style: {
              // The 8px box is for the unnamed case, which draws a dot. Height was left unconditional while
              // width was not, so a named session's text — 10px font — was laid out inside an 8px box and
              // spilled out of the pill. Both dimensions and the line height now depend on which one it is.
              padding: byline.label ? '0 5px' : 0, borderRadius: 999, fontSize: 10,
              width: byline.label ? 'auto' : 8,
              height: byline.label ? 'auto' : 8,
              lineHeight: byline.label ? '14px' : undefined,
              maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              display: 'inline-block', verticalAlign: 'middle',
              border: '1px solid hsla(' + byline.hue + ', 55%, 50%, 0.5)',
              color: 'hsl(' + byline.hue + ', 55%, 42%)',
              background: 'hsla(' + byline.hue + ', 55%, 50%, 0.28)',
              opacity: 0.9, font: 'inherit', cursor: onRename ? 'pointer' : 'default',
            },
          }, byline.label || '●') : null,
        ) : null,
        // The resize edge. A child of the box, so it sees the press before the box does and can stop it
        // from becoming a move — without that, pressing the edge drags the node and the cursor lies.
        gone ? null : h('div', {
          'data-kb-resize': 'true',
          title: '拖动这里调整这个节点的宽度',
          onPointerDown: (event) => {
            if (event.button !== 0) return;
            onResizeStart('x')(event);
          },
          onPointerMove: (event) => {
            // Only a hint: the cursor has to say "resize" before the press, not after.
            event.currentTarget.style.opacity = '1';
          },
          onPointerLeave: (event) => {
            event.currentTarget.style.opacity = '0';
          },
          style: {
            position: 'absolute', top: 0, right: 0, bottom: 0, width: 7,
            cursor: 'ew-resize', opacity: 0, borderRadius: '0 8px 8px 0',
            background: 'linear-gradient(to right, transparent, rgba(128,128,128,0.35))',
            transition: 'opacity 160ms',
          },
        }),
        // The bottom edge, and the corner where the two meet. The corner is last so it wins the press.
        gone ? null : h('div', {
          title: '拖动这里调整这个节点的高度',
          onPointerDown: (event) => {
            if (event.button !== 0) return;
            onResizeStart('y')(event);
          },
          style: {
            position: 'absolute', left: 0, right: 0, bottom: 0, height: 6,
            cursor: 'ns-resize', opacity: 0, borderRadius: '0 0 8px 8px',
            background: 'linear-gradient(to bottom, transparent, rgba(128,128,128,0.35))',
            transition: 'opacity 160ms',
          },
        }),
        gone ? null : h('div', {
          title: '拖动这里同时调整宽度和高度',
          onPointerDown: (event) => {
            if (event.button !== 0) return;
            onResizeStart('xy')(event);
          },
          style: {
            position: 'absolute', right: 0, bottom: 0, width: 12, height: 12,
            cursor: 'nwse-resize', borderRadius: '0 0 8px 0',
          },
        }),
      );
    }

    function Tree({
      focusNode, onFocusShown, onLocate,
      names,
      labels,
      base, extraLinks, onLink, onParent, onCreateChild, edits, onEdit, onReview, fullscreen, positions, onMove,
      /**
       * `(nodeId) => void`. Swaps the panel over to that node's edit history.
       *
       * It goes up to Body because the history is a whole-panel view: a 300×360 card inside the canvas forced a
       * 1,900-character body into a keyhole, and covered the canvas it was opened to compare against.
       */
      onShowHistory,
      /**
       * `(from, to, note) => void`. Writes one link's note.
       *
       * The model is required to write a note when it links two nodes; the user is not, because they are the
       * only reader of their own panel — but they have to be able to, and that editor lives in this component
       * rather than in `Tree` because `post` does.
       */
      onSetLinkNote,
      colors, onColor, focusId, onResetLayout, shape, onSetShape, onRemoveNode, onRevertNode, onCreateNode, onPurgeNode,
      onSendToChat, widths, nodeWidths, onSetWidth, onAttachPicture, nodeInjection, defaultInjection, onInjection,
      collapsedNodes, onCollapse, onArrange }) {
      const ordered = React.useMemo(() => layout(base.nodes || []), [base.nodes]);
      const branches = React.useMemo(() => subtreeIndex(base.nodes || []), [base.nodes]);
      const hiddenNodes = React.useMemo(() => foldedNodes(branches, collapsedNodes), [branches, collapsedNodes]);
      const folded = new Set(Array.isArray(collapsedNodes) ? collapsedNodes : []);
      const visibleOrdered = React.useMemo(() => ordered.filter((entry) => !hiddenNodes.has(entry.node.id)), [ordered, hiddenNodes]);
      const [arrangeRequest, setArrangeRequest] = React.useState(false);
      const arrangementEntries = arrangeRequest ? visibleOrdered : ordered;
      const lastPlacement = React.useRef({});
      const [foldNotice, setFoldNotice] = React.useState('');
      /**
       * `ordered` by id, built once per render.
       *
       * Two callers used to scan the array instead — the layout's `sizeOf` and the geometry's `rectOf` — and
       * both are called about once per node per edge, which made looking a node up quadratic in the node
       * count. It lives here rather than next to `rectOf` because the layout runs first and needs it too.
       *
       * This was briefly part of the compact-mode commit, which was reverted. It is not part of that idea, and
       * is re-applied on its own.
       */
      const entryById = React.useMemo(() => new Map(ordered.map((entry) => [entry.node.id, entry])), [ordered]);
      const depthOf = {};
      ordered.forEach((entry) => { depthOf[entry.node.id] = entry.depth; });

      const [drag, setDrag] = React.useState(null);
      const [hover, setHover] = React.useState(null);
      // The node under the pointer, used to light up only its own edges. Worth the state: with a
      // dozen links on the canvas, the thing that makes them unreadable is that they all shout at
      // once, and no routing scheme fixes that — only taking the others out of the way does.
      const [spotlight, setSpotlight] = React.useState(null);
      const [editingId, setEditingId] = React.useState(null);
      const toggleCollapse = (id) => {
        if (!folded.has(id) && editingId && foldedNodes(branches, [id]).has(editingId)) {
          setFoldNotice('请先保存或取消正在编辑的节点，再折叠它的上级。');
          return;
        }
        setFoldNotice('');
        onCollapse({ node: id, collapsed: !folded.has(id) });
      };
      // The canvas menu: where it sits on screen and where in the canvas the click landed. Both are
      // needed — the menu is drawn outside the zoomed layer so it stays legible, while the node has to
      // be placed in the canvas's own coordinates.
      const [canvasMenu, setCanvasMenu] = React.useState(null);
      /** Right-click on a node: `{ id, sx, sy }`, screen-relative inside the canvas. */
      const [nodeMenu, setNodeMenu] = React.useState(null);
      // The dragged node's stand-in, in screen coordinates. Rendered fixed so the canvas's overflow
      // cannot clip it: the whole point is to watch it leave.
      const [ghost, setGhost] = React.useState(null);
      // A width being dragged on a node's edge. Held in Tree so every box can see it, and so the value
      // survives the re-renders the drag itself causes.
      const [resizing, setResizing] = React.useState(null);

      const [view, setView] = React.useState({ k: 1, x: 0, y: 0 });

      /**
       * Whether nodes are drawn without their bodies.
       *
       * A ref rather than reading `view` inside `rectOf`, because `rectOf` is called by code that runs before
       * `view` is declared — the focus-and-centre effect — and a block-scoped `const` read that early is a
       * throw, not a warning. Published immediately below, in the same render, because the layout reads it and
       * the layout runs before the zoom helpers do.
       */
      const detailRef = React.useRef(true);
      detailRef.current = view.k >= DETAIL_ZOOM;

      // The edge drag. Movement is divided by the zoom, because the width is in canvas units: at 50% a
      // 100px drag is a 200px box, and forgetting that is the difference between the edge tracking the
      // pointer and running away from it.
      React.useEffect(() => {
        if (!resizing) return undefined;
        const move = (event) => {
          // Divided by the zoom, because both numbers are in canvas units.
          setResizing((current) => {
            if (!current) return current;
            const next = { ...current };
            if (current.axis !== 'y') {
              next.width = Math.round(current.startWidth + (event.clientX - current.startX) / view.k);
            }
            if (current.axis !== 'x') {
              next.height = Math.round(current.startHeight + (event.clientY - current.startY) / view.k);
            }
            return next;
          });
        };
        const up = () => {
          const width = Math.round(Math.min(720, Math.max(120, resizing.width)));
          const height = Math.round(Math.min(2000, Math.max(40, resizing.height)));
          setResizing(null);
          const changed = (resizing.axis !== 'y' && width !== resizing.startWidth)
            || (resizing.axis !== 'x' && height !== resizing.startHeight);
          if (!changed) return;
          onSetWidth(resizing.id, {
            w: resizing.axis === 'y' ? undefined : width,
            h: resizing.axis === 'x' ? undefined : height,
          });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        return () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
        };
      }, [resizing, view.k, onSetWidth]);
      const [moving, setMoving] = React.useState(null);
      const [armed, setArmed] = React.useState(null);
      // The numbers from the last completed drag, so they can be read after the button is released
      // rather than only during the gesture.
      const [lastDrag, setLastDrag] = React.useState(null);
      const boxRef = React.useRef(null);
      const press = React.useRef(null);
      // The two terms the drop position is computed from, kept for the readout: the pointer in
      // canvas coordinates and the grab offset taken at the hold.
      const lastPointer = React.useRef(null);
      const grabOffset = React.useRef(null);
      const pan = React.useRef(null);
      const link = React.useRef(null);
      const timer = React.useRef(null);

      // Moving a node needs a hold, editing does not. The asymmetry is deliberate: a click
      // mis-read as a move really moves the node and has to be put back, while a move mis-read
      // as a click only opens an editor that Escape closes. So movement alone never arms a
      // move — and a press that travelled but was released before the hold does nothing at
      // all, rather than falling back to either.
      const HOLD_MS = 260;
      const MOVE_SLOP = 5;

      const declared = base.links || [];
      const allLinks = declared.concat(extraLinks || []).filter(
        (link) => depthOf[link.from] !== undefined && depthOf[link.to] !== undefined
          && !hiddenNodes.has(link.from) && !hiddenNodes.has(link.to));
      const unsaved = new Set((extraLinks || []).map((link) => link.from + '>' + link.to));

      // Links are drawn as direct dashed lines between the two boxes.
      //
      // They used to leave sideways, run down a lane in the outer margin and come back in at the
      // target's row. That kept them off the boxes, but it turned a handful of links into a wall
      // of rectangles, and it was the wrong trade: an association is expected to cross things,
      // while a parent-child edge is not — which is why those stay as curves. Two drawing styles
      // on one canvas was itself the tell that only one of them had been thought through.
      const offsetX = 16;
      // Real box sizes, measured from the DOM.
      //
      // A node grows taller when its text wraps, and every piece of geometry used to assume one
      // height for all of them. That put a link's start a few pixels *inside* a two-line node —
      // visible as a dashed line beginning under the text — and made the obstacle test miss boxes
      // it only grazed. `offsetHeight` is the layout size, so the canvas's zoom transform does not
      // affect it, which is exactly what the geometry wants.
      const [sizes, setSizes] = React.useState({});
      // Measuring is the most expensive thing a render does: a `querySelectorAll` over the whole canvas plus
      // three forced layout reads per node (`offsetWidth`, `offsetHeight`, `scrollHeight`). With no dependency
      // list this ran after *every* render — including every frame of a pan or zoom — and a single frame with
      // 33 nodes paid 99 layout reads. Six nodes felt fine; that gap is what the user saw.
      //
      // It cannot simply depend on the sizes, because the sizes are what it computes. So it depends on the
      // things that can change a node's rendered height: which nodes exist, how wide the user has dragged
      // them, what is being edited, and **the text itself** — a body that grew has to be re-measured, and the
      // first version of this key carried `base.id` instead, which does not change when you save. The comment
      // there claimed the object identity was the signal; the code had the id. The code was the wrong one.
      const measureKey = (() => {
        const parts = [];
        for (const entry of ordered) {
          const node = entry.node;
          parts.push(node.id + ':' + widthOf(widths, nodeWidths, base.id, node.id, node)
            + ':' + (node.title || '').length + ':' + (node.body || '').length
            + ':' + (nodeInjection?.[node.id] || ''));
        }
        parts.push('e' + (edits ? Object.keys(edits).join(',') : ''));
        parts.push('visible:' + visibleOrdered.map((entry) => entry.node.id).join(','));
        return parts.join('|');
      })();
      React.useLayoutEffect(() => {
        const holder = boxRef.current;
        // Collapsed overview cards must not overwrite the full-detail measurements.
        if (!holder || !detailRef.current) return;
        const found = Object.fromEntries(Object.entries(sizes).filter(([id]) => branches.byId.has(id)));
        let changed = false;
        holder.querySelectorAll('[data-node-id]').forEach((element) => {
          // An editor is not the node. Measuring it fed its own height back into the layout, so
          // opening one re-flowed the whole tree and the node under the pointer moved.
          if (element.hasAttribute('data-kb-editor')) {
            const id = element.getAttribute('data-node-id');
            if (sizes[id]) found[id] = sizes[id];
            return;
          }
          const id = element.getAttribute('data-node-id');
          const w = element.offsetWidth;
          // The larger of the two: offsetHeight is the box's layout height, scrollHeight the height
          // of its content. They agree normally; when they do not, the content height is what the
          // layout needs, and taking the box height alone silently skipped the node.
          const h = Math.max(element.offsetHeight, element.scrollHeight);
          if (!id || w <= 0 || h <= 0) return;
          found[id] = { w, h };
          const before = sizes[id];
          if (!before || before.w !== w || before.h !== h) changed = true;
        });
        // Only when something actually moved, or this would re-render forever.
        if (changed || Object.keys(found).length !== Object.keys(sizes).length) setSizes(found);
        // `measureKey` and not the sizes: see above. `boxRef` is stable, and `ordered`/`widths`/`edits` are
        // all folded into the key.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [measureKey, base.nodes, edits, editingId, view.k >= DETAIL_ZOOM]);
      // Pan/zoom within one detail mode changes the camera, not the graph.
      const { placed: layoutPlaced, sizeOf, width, height } = React.useMemo(() => {
      const placed = {};
      for (const item of arrangementEntries) placed[item.node.id] = { x: 0, y: 0 };

      const sizeOf = (id) => {
        const item = entryById.get(id);
        // Without a body drawn, the box is one line — and the geometry has to agree with what is on screen, or
        // every edge arrives at the edge of a box that is no longer there.
        if (!detailRef.current) return oneLineBox(item ? item.node : {},
          widthOf(widths, nodeWidths, base.id, id, item ? item.node : undefined));
        const box = boxOf(widths, nodeWidths, base.id, id, item ? item.node : undefined);
        if (Number.isFinite(box.h)) return { w: box.w, h: box.h };
        const found = sizes[id];
        return { w: box.w, h: Math.min(AUTO_MAX_H, found ? found.h : estimateBox(item ? item.node : {}).h) };
      };

      const childIndex = new Map();
      for (const item of arrangementEntries) {
        const parent = item.node.parent;
        if (!childIndex.has(parent)) childIndex.set(parent, []);
        childIndex.get(parent).push(item);
      }
      const childrenOf = (id) => childIndex.get(id) || [];
      const known = new Set(arrangementEntries.map((item) => item.node.id));
      const roots = arrangementEntries.filter((item) => !item.node.parent || !known.has(item.node.parent));

      // Radial placement.
      //
      // Leaves are the unit of width: a subtree's angular slice is proportional to how many leaves
      // it holds, so a branch with many children gets room and a single chain gets a narrow wedge.
      // The ring is an ellipse rather than a circle because the boxes are much wider than they are
      // tall, and a circle would waste the horizontal space they need most.
      const leaves = new Map();
      const countLeaves = (id) => {
        const kids = childrenOf(id);
        const total = kids.length === 0
          ? 1
          : kids.reduce((sum, kid) => sum + countLeaves(kid.node.id), 0);
        leaves.set(id, total);
        return total;
      };
      for (const root of roots) countLeaves(root.node.id);

      // Compact is the same shape with tighter rings. A separate arrangement would need its own
      // separating pass; density is the honest difference.
      const dense = shape === 'compact' ? 0.62 : 1;
      const RING_X = 250 * dense;
      const RING_Y = 190 * dense;
      const centre = { x: offsetX + 120, y: 40 };

      const spread = (id, from, to, depth) => {
        const middle = (from + to) / 2;
        placed[id].x = Math.round(centre.x + Math.cos(middle) * depth * RING_X);
        placed[id].y = Math.round(centre.y + Math.sin(middle) * depth * RING_Y);
        const whole = leaves.get(id) || 1;
        let cursor = from;
        for (const kid of childrenOf(id)) {
          const share = (to - from) * ((leaves.get(kid.node.id) || 1) / whole);
          spread(kid.node.id, cursor, cursor + share, depth + 1);
          cursor += share;
        }
      };

      if (shape === 'layers') {
        // One row per depth, and every parent centred over the span its own subtree occupies. The
        // horizontal order is therefore meaningful: a node sits directly above its children, and
        // siblings from different parents never interleave.
        //
        // Spans are computed first (a leaf is as wide as its box; a parent is as wide as its
        // children plus the gaps between them), then everything is placed inside that span.
        const GAP_X = 34;
        const GAP_Y = 76;
        const spans = new Map();
        const spanOf = (id) => {
          if (spans.has(id)) return spans.get(id);
          const kids = childrenOf(id);
          const span = kids.length === 0 ? sizeOf(id).w
            : kids.reduce((sum, kid) => sum + spanOf(kid.node.id), 0) + GAP_X * (kids.length - 1);
          spans.set(id, span);
          return span;
        };

        let shelf = 10;
        const depths = [];
        for (const item of arrangementEntries) {
          if (!depths[item.depth]) depths[item.depth] = 0;
          depths[item.depth] = Math.max(depths[item.depth], sizeOf(item.node.id).h);
        }

        const layOut = (id, left) => {
          const spot = placed[id];
          const size = sizeOf(id);
          const kids = childrenOf(id);
          if (kids.length === 0) {
            spot.x = left;
            return;
          }
          let cursor = left;
          for (const kid of kids) {
            layOut(kid.node.id, cursor);
            cursor += spanOf(kid.node.id) + GAP_X;
          }
          const first = placed[kids[0].node.id];
          const last = placed[kids[kids.length - 1].node.id];
          const spanEnd = last.x + sizeOf(kids[kids.length - 1].node.id).w;
          // Centred over the children's span, never left of it.
          spot.x = Math.max(left, Math.round((first.x + spanEnd) / 2 - size.w / 2));
        };

        // The y for each depth is the same for every node on that row, so a row is a row.
        const rowTop = [];
        let shelfY = 10;
        for (let depth = 0; depth < depths.length; depth += 1) {
          rowTop[depth] = shelfY;
          shelfY += (depths[depth] || BOX_H) + GAP_Y;
        }
        for (const item of arrangementEntries) placed[item.node.id].y = rowTop[item.depth] || 10;

        let cursor = 10;
        for (const root of roots) {
          layOut(root.node.id, cursor);
          cursor += spanOf(root.node.id) + GAP_X * 2;
        }
      } else if (shape === 'staircase') {
        // One column per depth, one row per node in visit order, each row as tall as its own box.
        // This is the arrangement the panel had before the radial one, and for a straight chain of
        // steps — which is exactly what a release flow is — it reads better than a fan.
        let stack = 10;
        for (const item of arrangementEntries) {
          placed[item.node.id] = { x: offsetX + item.depth * COLUMN, y: stack };
          stack += sizeOf(item.node.id).h + ROW_GAP;
        }
      } else {
        const rootLeaves = roots.reduce((sum, item) => sum + (leaves.get(item.node.id) || 1), 0);
        let rootAngle = -Math.PI / 2;
        for (const root of roots) {
          const share = (Math.PI * 2) * ((leaves.get(root.node.id) || 1) / Math.max(1, rootLeaves));
          spread(root.node.id, rootAngle, rootAngle + share, 0);
          rootAngle += share;
        }
      }

      // A node the user dragged keeps where they put it; the automatic layout gives way to it.
      //
      // Applied before the separating pass, not after: a node the user dragged is part of the
      // arrangement, and it has to be part of what the pass checks. Applied afterwards it could sit on
      // top of a neighbour and nothing would move it.
      // A node the user dragged keeps where they put it; the automatic layout gives way to it.
      for (const item of arrangementEntries) {
        const spot = !arrangeRequest && positions && positions[item.node.id];
        if (spot) placed[item.node.id] = { x: spot.x, y: spot.y };
      }

      // Separating pass: anything still overlapping is pushed apart until it clears.
      const ids = arrangementEntries.map((item) => item.node.id);
      for (let round = 0; round < 60; round += 1) {
        let bumped = false;
        for (let i = 0; i < ids.length; i += 1) {
          for (let j = i + 1; j < ids.length; j += 1) {
            // Explicit positions are the reader's arrangement; never push those boxes while folding.
            if (!arrangeRequest && (positions?.[ids[i]] || positions?.[ids[j]])) continue;
            const a = placed[ids[i]];
            const b = placed[ids[j]];
            const aSize = sizeOf(ids[i]);
            const bSize = sizeOf(ids[j]);
            const gap = 18;
            const overlapX = Math.min(a.x + aSize.w + gap, b.x + bSize.w + gap) - Math.max(a.x, b.x);
            const overlapY = Math.min(a.y + aSize.h + gap, b.y + bSize.h + gap) - Math.max(a.y, b.y);
            if (overlapX <= 0 || overlapY <= 0) continue;
            const push = overlapY / 2 + 1;
            if (a.y <= b.y) {
              a.y -= push;
              b.y += push;
            } else {
              a.y += push;
              b.y -= push;
            }
            bumped = true;
          }
        }
        if (!bumped) break;
      }

      // The bounds are taken here, before the overrides: where a node has been dragged to is the
      // user's business, but it must not move the canvas's origin out from under everything else.
      const automatic = {};
      for (const item of arrangementEntries) automatic[item.node.id] = { ...placed[item.node.id] };

      // Bounds come from where the boxes actually ended up, including the space above and to the
      // left of the origin that a radial layout reaches into.
      let minX = 0;
      let minY = 0;
      let maxX = 0;
      let maxY = 0;
      for (const item of arrangementEntries) {
        const spot = automatic[item.node.id] || placed[item.node.id];
        const size = sizeOf(item.node.id);
        minX = Math.min(minX, spot.x);
        minY = Math.min(minY, spot.y);
        maxX = Math.max(maxX, spot.x + size.w);
        maxY = Math.max(maxY, spot.y + size.h);
      }
      // Shift everything into positive coordinates: the canvas renders from its own top-left, and
      // a node at a negative coordinate would be drawn outside it.
      if (minX < 0 || minY < 0) {
        for (const item of arrangementEntries) {
          placed[item.node.id].x -= minX;
          placed[item.node.id].y -= minY;
        }
        maxX -= minX;
        maxY -= minY;
      }
      const width = maxX + 24;
      const height = maxY + 24;

      return { placed, sizeOf, width, height };
      }, [arrangementEntries, sizes, widths, nodeWidths, base.id, shape, positions, arrangeRequest, view.k >= DETAIL_ZOOM]);
      const placed = { ...layoutPlaced };
      React.useLayoutEffect(() => {
        if (arrangeRequest) {
          onArrange({ ...lastPlacement.current, ...layoutPlaced });
          setArrangeRequest(false);
        } else lastPlacement.current = layoutPlaced;
      }, [arrangeRequest, layoutPlaced]);


      // The latest placement, for callbacks that outlive the render that created them — the hold
      // timer reads it a quarter of a second after the press, by which time the layout may have run
      // again.
      // Centre the view on a node when the unread walk lands on it. Keyed on the id so asking for
      // the same node twice does not fight the user's own panning.
      const centred = React.useRef(null);
      React.useEffect(() => {
        if (!focusId || centred.current === focusId) return;
        if (hiddenNodes.has(focusId)) { onCollapse({ reveal: focusId }); return; }
        const holder = boxRef.current;
        const spot = placed[focusId];
        if (!holder || !spot) return;
        const rect = holder.getBoundingClientRect();
        const size = sizes[focusId] || { w: BOX_W, h: BOX_H };
        centred.current = focusId;
        setView((current) => ({
          k: current.k,
          x: rect.width / 2 - (spot.x + size.w / 2) * current.k,
          y: rect.height / 2 - (spot.y + size.h / 2) * current.k,
        }));
      }, [focusId, placed, sizes, hiddenNodes]);

      // Which node's edit history is open, and the entries it should show. The entries come from the node
      // itself — it carries its own last ten edits — so this is a lookup, not a fetch.
      const [historyFor, setHistoryFor] = React.useState(null);
      /**
       * The link whose note is being edited: `{ from, to, note, x, y }` in canvas coordinates.
       *
       * The model must write a note when it links two nodes — the note is what other sessions see in their
       * outline, and a line with nothing on it cannot be acted on. The user is not required to, because they
       * are the only reader of their own panel; but they must be able to, and the visible line is 1.4px and
       * hopeless to hit, so each link gets an invisible fat copy to click.
       */
      /**
       * The node whose edit history is being edited: ...
       */
      const [noteFor, setNoteFor] = React.useState(null);

      const placedRef = React.useRef({});
      // The positions the nodes are actually drawn at. The bounds shift is baked into their
      // left/top, so this is also the space the pointer arrives in.
      placedRef.current = placed;

      // A search result asked to be shown. This is the one moment the positions are certainly known — the
      // layout computed them on the line above — so centring here is deterministic, where an effect would
      // have to guess whether the tree had been drawn yet.
      // Sliding to a located node rather than jumping to it.
      //
      // A jump is indistinguishable from nothing happening: at the instant after the click there is no
      // evidence that anything ran, and if the layout is slow to arrive the wait reads as a freeze. The
      // movement is the receipt — you can watch the request land, and see where it landed.
      //
      // `viewRef` because the effect closes over the render it was created in; reading `view` there would
      // animate from wherever the canvas was several frames ago. Cancelled on any user gesture, so a pan or
      // a wheel during the slide wins instead of fighting it.
      const viewRef = React.useRef(view);
      viewRef.current = view;
      const glideRef = React.useRef(0);
      const glideTo = (target) => {
        cancelAnimationFrame(glideRef.current);
        const reduce = typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const from = viewRef.current;
        if (reduce || from.k !== target.k) {
          // Zoom changes are not animated: the slide is about saying "here", and scaling the whole canvas
          // on the way would be a different, noisier statement.
          setView(target);
          return;
        }
        const started = Date.now();
        const step = () => {
          const t = Math.min(1, (Date.now() - started) / GLIDE_MS);
          // Ease-out cubic, the same shape the edges use: quick to arrive, gentle to settle.
          const eased = 1 - Math.pow(1 - t, 3);
          setView({
            k: target.k,
            x: from.x + (target.x - from.x) * eased,
            y: from.y + (target.y - from.y) * eased,
          });
          if (t < 1) glideRef.current = requestAnimationFrame(step);
        };
        glideRef.current = requestAnimationFrame(step);
      };

      // A locate request — from the search results or the canvas's own dropdown — is handled by an effect,
      // exactly like the unread walk's `focusId` above.
      //
      // This used to run inline in the render body. It reported `centred` and the canvas did not move: a
      // render-phase `setView` on this component combined with a render-phase `setState` on the parent is not
      // a supported pattern, and the pan was lost. The effect above is the same operation written the way
      // React does support, and it works — so this now matches it rather than inventing a second shape.
      React.useEffect(() => {
        if (!focusNode) return undefined;
        if (hiddenNodes.has(focusNode.nodeId)) { onCollapse({ reveal: focusNode.nodeId }); return undefined; }
        const spot = placedRef.current[focusNode.nodeId];
        const holder = boxRef.current;
        if (!spot || !holder) {
          onFocusShown('unknown-node', focusNode.nodeId);
          return undefined;
        }
        const rect = holder.getBoundingClientRect();
        const size = sizeOf(focusNode.nodeId);
        const k = viewRef.current.k;
        glideTo({
          k,
          x: rect.width / 2 - (spot.x + size.w / 2) * k,
          y: rect.height / 2 - (spot.y + size.h / 2) * k,
        });
        // Cleared after the pan, so a re-render does not yank the canvas back while the user is looking.
        // The outcome goes back with it: a locate request that lands on a node this canvas does not draw is
        // otherwise indistinguishable from one that panned, because both end with the request cleared.
        onFocusShown('centred', focusNode.nodeId);
        return undefined;
      }, [focusNode, hiddenNodes]);

      // The node being dragged follows the pointer live, and the edges follow it.
      // The pointer's space is the drawn space: the shift is inside the nodes' own left/top, not
      // in the layer's transform.
      if (moving && placed[moving.id]) placed[moving.id] = { x: moving.x, y: moving.y };


      /**
       * A node's box for geometry: where it sits, and how big it really is.
       *
       * The lookup is the Map built at the top of this render, not `ordered.find` — see its comment.
       */
      const rectOf = (id) => {
        if (hiddenNodes.has(id)) return null;
        const spot = placed[id];
        if (!spot) return null;
        // Same rule as `sizeOf`: the box the geometry uses is the box that is drawn.
        const size = sizeOf(id);
        return { x: spot.x, y: spot.y, w: size.w, h: size.h };
      };



      // The canvas: k scales, x/y translate, origin at the top-left so the maths stays simple.
      // A local point (lx, ly) lands at viewport (x + k*lx, y + k*ly).
      // MIN_ZOOM / MAX_ZOOM / DETAIL_ZOOM live at module scope — see their comment there, and `edgeStroke`,
      // which needs the same numbers to know how far out the canvas is.

      const clampZoom = (value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

      /** Zoom about one viewport point, so whatever sits under the cursor stays under it. */
      const zoomAt = (factor, viewX, viewY) => {
        setView((current) => {
          const k = clampZoom(current.k * factor);
          if (k === current.k) return current;
          const ratio = k / current.k;
          return { k, x: viewX - (viewX - current.x) * ratio, y: viewY - (viewY - current.y) * ratio };
        });
      };

      const fitTo = (contentWidth, contentHeight) => {
        const rect = boxRef.current && boxRef.current.getBoundingClientRect();
        let left = 0, top = 0;
        if (hiddenNodes.size > 0 && visibleOrdered.length > 0) {
          const boxes = visibleOrdered.map((entry) => rectOf(entry.node.id)).filter(Boolean);
          left = Math.min(...boxes.map((box) => box.x)) - 12;
          top = Math.min(...boxes.map((box) => box.y)) - 12;
          contentWidth = Math.max(...boxes.map((box) => box.x + box.w)) - left + 12;
          contentHeight = Math.max(...boxes.map((box) => box.y + box.h)) - top + 12;
        }
        if (!rect || !contentWidth || !contentHeight) {
          setView({ k: 1, x: 0, y: 0 });
          return;
        }
        const k = clampZoom(Math.min(1,
          (rect.width - 24) / contentWidth, (rect.height - 24) / contentHeight));
        setView({
          k,
          x: Math.max(12, (rect.width - contentWidth * k) / 2) - left * k,
          y: Math.max(12, (rect.height - contentHeight * k) / 2) - top * k,
        });
      };

      const localPoint = (event) => {
        const rect = boxRef.current && boxRef.current.getBoundingClientRect();
        if (!rect) return { x: 0, y: 0 };
        // Undo the canvas transform: the rectangle is the transformed box, so a screen delta
        // divided by k is a local delta. Skipping this put the rubber band in the wrong place
        // the moment the canvas was zoomed.
        return {
          x: (event.clientX - rect.left - view.x) / view.k,
          y: (event.clientY - rect.top - view.y) / view.k,
        };
      };

      /** Panning starts on the canvas background, never on a node. */
      const onCanvasPointerDown = (event) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (target && target.closest && target.closest('[data-node-id]')) return;
        // A press inside an open menu belongs to the menu. Clearing it here — which is what this did for one
        // round — unmounts it on pointerdown, so the click that follows lands on nothing and every item silently
        // does nothing. The menus close themselves when an item is chosen, and this closes them when the press
        // lands anywhere else, which is the split it should have had from the start.
        if (target && target.closest
          && target.closest('[data-kb-canvas-menu], [data-kb-node-menu]')) return;
        const rect = boxRef.current && boxRef.current.getBoundingClientRect();
        if (!rect) return;
        // A press on the background dismisses any open menu.
        setCanvasMenu(null);
        setNodeMenu(null);
        pan.current = { startX: event.clientX, startY: event.clientY, view };
        event.preventDefault();
      };

      React.useEffect(() => {
        // One React render per animation frame, not one per pointer event.
        //
        // This is the fix for what the user reported, and the shape of it is worth keeping: panning felt
        // heavy while zooming felt fine, which rules out the rasterisation theory (zoom is the one that
        // redraws every node's shadow, panning is pure compositing). The difference is event rate — a wheel
        // is throttled by the browser, a high-report-rate mouse emits `pointermove` well over a hundred times
        // a second, and each one was its own `setView`. So the cost scaled with node count (each render is
        // more expensive) and not with content length, and making each render cheaper — the routing memo, the
        // rect lookup, the size measurement — could not fix it, because the problem was the number of renders.
        //
        // The latest pointer position wins; intermediate ones are dropped, which is what a frame is for.
        let queued = null;
        let frame = 0;
        const flush = () => {
          frame = 0;
          const latest = queued;
          queued = null;
          if (!latest || !pan.current) return;
          setView({
            k: latest.view.k,
            x: latest.view.x + (latest.clientX - latest.startX),
            y: latest.view.y + (latest.clientY - latest.startY),
          });
        };
        const move = (event) => {
          const current = pan.current;
          if (!current) return;
          queued = { view: current.view, startX: current.startX, startY: current.startY,
            clientX: event.clientX, clientY: event.clientY };
          if (!frame) frame = requestAnimationFrame(flush);
        };
        const up = () => {
          pan.current = null;
          queued = null;
          if (frame) { cancelAnimationFrame(frame); frame = 0; }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        return () => {
          if (frame) cancelAnimationFrame(frame);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
        };
      }, []);

      const onWheel = (event) => {
        // A wheel over something that scrolls belongs to that thing. The editor sits inside this canvas,
        // so without this its textarea scrolled and the canvas zoomed at the same time. Returning before
        // preventDefault is what matters: the canvas stops claiming the event, and the field scrolls.
        const scrollable = event.target && event.target.closest
          ? event.target.closest('textarea, input, [data-kb-editor], [data-kb-scroll]')
          : null;
        if (scrollable) return;
        // A wheel during the slide takes over: the user's gesture is the more recent intent.
        cancelAnimationFrame(glideRef.current);
        const rect = boxRef.current && boxRef.current.getBoundingClientRect();
        if (!rect) return;
        // Plain wheel zooms, about the pointer. Wheel-panning was never needed: dragging the
        // background already pans, and it is the more direct gesture, so the wheel does only
        // this one thing. The factor follows the delta so a trackpad's small steps stay fine
        // while a mouse notch moves a visible amount.
        event.preventDefault();
        const factor = Math.exp(-event.deltaY / 600);
        zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
      };

      // Attached by hand: React's onWheel is passive, so it cannot stop the page from scrolling. The ref
      // keeps the listener from being re-attached on every pan — the handler reads through it.
      const wheelRef = React.useRef(onWheel);
      wheelRef.current = onWheel;
      React.useEffect(() => {
        const element = boxRef.current;
        if (!element) return undefined;
        const listener = (event) => wheelRef.current(event);
        element.addEventListener('wheel', listener, { passive: false });
        return () => element.removeEventListener('wheel', listener);
      }, []);

      const nodeUnder = (event) => {
        const element = typeof document.elementFromPoint === 'function'
          ? document.elementFromPoint(event.clientX, event.clientY)
          : null;
        const holder = element && element.closest ? element.closest('[data-node-id]') : null;
        return holder ? holder.getAttribute('data-node-id') : null;
      };

      /** Left press. Hold to arm a move; release without holding is a click, and that edits. */
      // The gesture effect below subscribes once, so anything it calls must read state as it is at
      // the moment of the event rather than at the moment of subscription. A pointer that moves one
      // pixel after a zoom was otherwise converted with the viewport from before the zoom, and the
      // node flew off to wherever that landed.
      const liveRef = React.useRef({ localPoint });
      liveRef.current = { localPoint };

      const onPressStart = (id, event) => {
        const point = localPoint(event);
        const spot = placed[id];
        // The grab offset is taken here, at the press, because the drag starts here. It used to be taken
        // when the hold fired, which is the same instant only while the hold was what armed the move.
        //
        // The live placement is read rather than the one this render closed over: between the press and the
        // first movement the layout can run again — measured sizes arrive, the separating pass settles — and
        // a stale spot made the node snap back to where it had been a moment earlier.
        const now = placedRef.current[id] || spot;
        // Alt at the moment of the press decides what this drag is for. Read here rather than on every move: the
        // gesture is chosen by how it started, and a modifier pressed halfway through would otherwise rewrite what
        // the release means.
        const parenting = Boolean(event && event.altKey);
        press.current = {
          id,
          x0: point.x,
          y0: point.y,
          last: point,
          spot,
          dx: now ? point.x - now.x : 0,
          dy: now ? point.y - now.y : 0,
          // Armed at once: dragging moves the node. The hold below turns this into a link instead.
          armed: !parenting,
          displaced: false,
          linking: false,
          parenting,
          x: now ? now.x : 0,
          y: now ? now.y : 0,
        };
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          const current = press.current;
          if (!current || !current.spot) return;
          // One decision, at one instant. Already moving means the user is dragging, so the hold means
          // nothing; still means the hold was deliberate, so it becomes a link.
          //
          // The hold no longer arms the move, so everything it used to set up — the grab offset, the live
          // placement — is taken at the press instead, where the drag now begins.
          // A hold while Alt is down must not turn this into a link: the gesture was decided at the press.
          if (current.displaced || current.parenting) return;
          current.linking = true;
          link.current = { from: current.id };
          setArmed(null);
          setDrag({ from: current.id, x: current.last.x, y: current.last.y });
        }, HOLD_MS);
      };

      /**
       * A free spot next to one node, for a node that has just been created.
       *
       * Without this a new node has no manual position, so it lands wherever the automatic layout puts it — and
       * once the user has dragged things around, that can be the far side of the canvas from the parent they just
       * made it under. Which defeats the point of "new child": the child should appear at the child's place.
       *
       * Below the anchor first (that is where a child reads as belonging), then to its right, stepping further
       * down each time something is in the way. The clearance test uses the same gap the separating pass uses, so
       * a spot this returns is one that pass will not immediately push somewhere else.
       */
      const freeSpotNear = (anchorId) => {
        const anchor = rectOf(anchorId);
        if (!anchor) return null;
        // The new node has no measurements yet — nothing has been rendered. Its title is what it will be created
        // with, so this is the estimate the layout itself would use.
        const guess = estimateBox({ title: '新节点', body: '' });
        const w = Math.max(120, guess.w);
        const h = Math.max(72, guess.h);
        const gap = 22;
        const others = ordered
          .filter((entry) => entry.node.id !== anchorId)
          .map((entry) => rectOf(entry.node.id))
          .filter(Boolean);
        const clear = (x, y) => !others.some((rect) => x < rect.x + rect.w + 18
          && x + w + 18 > rect.x
          && y < rect.y + rect.h + 18
          && y + h + 18 > rect.y);
        const starts = [{ x: anchor.x, y: anchor.y + anchor.h + gap },
          { x: anchor.x + anchor.w + gap, y: anchor.y }];
        for (const start of starts) {
          for (let step = 0; step < 30; step += 1) {
            const y = start.y + step * (h + gap);
            if (clear(start.x, y)) return { x: start.x, y };
          }
        }
        // Everything nearby is taken: below the anchor anyway, and let the separating pass sort it out.
        return starts[0];
      };


      /**
       * Open a node's history card, placed at a point given in canvas coordinates.
       *
       * The card is a thing on the canvas — it takes the same transform the nodes do — so its position has to be in
       * canvas units, and clamped to what can actually be seen at the current pan and zoom. Clamping to `0` here was
       * wrong for the same reason it was wrong before: `0` is the canvas origin, not its visible edge.
       */
      const openHistoryCard = (id, point) => {
        const frame = boxRef.current ? boxRef.current.getBoundingClientRect() : null;
        if (!frame || !view.k) return setHistoryFor({ id, x: point.x, y: point.y });
        const CARD_W = 300;
        const CARD_MAX_H = 380;
        const left = -view.x / view.k;
        const top = -view.y / view.k;
        const right = (frame.width - view.x) / view.k;
        const bottom = (frame.height - view.y) / view.k;
        return setHistoryFor({
          id,
          x: Math.max(left, Math.min(point.x, Math.max(left, right - CARD_W))),
          y: Math.max(top, Math.min(point.y, Math.max(top, bottom - CARD_MAX_H))),
        });
      };

      /** Keyboard path: Shift+Enter starts a link, Enter on another node finishes it. */
      const onActivate = (id, mode) => {
        if (drag && drag.from !== id) {
          const from = drag.from;
          setDrag(null);
          setHover(null);
          onLink(from, id);
          return;
        }
        if (mode === 'link') {
          const rect = rectOf(id);
          if (rect) {
            link.current = { from: id };
            // Keyboard-initiated drag: the band starts on the box's own right edge.
            setDrag({ from: id, x: rect.x + rect.w, y: rect.y + rect.h / 2 });
          }
          return;
        }
        setEditingId((current) => (current === id ? null : id));
      };

      // One owner for the whole canvas gesture: left drags move, a held press links, a press on
      // the background pans. Handling the first two in separate effects made pointerup
      // ambiguous, because both effects fired for the same release.
      React.useEffect(() => {
        const step = (event) => {
          const point = liveRef.current.localPoint(event);
          const left = press.current;
          if (left) {
            left.last = point;
            lastPointer.current = point;
            // Alt held: the drag is building structure, not moving the box and not drawing an association.
            // Same preview machinery as a link — the band plus the highlighted target — with `kind` marking it so
            // the line is drawn grey. Orange already means "these two are related"; a parent edge is a different
            // claim and must not look like the same one for even a moment.
            if (left.parenting) {
              setDrag({ from: left.id, x: point.x, y: point.y, kind: 'parent' });
              const under = nodeUnder(event);
              setHover(under && under !== left.id ? under : null);
              return;
            }
            if (left.linking) {
              setDrag({ from: left.id, x: point.x, y: point.y });
              const under = nodeUnder(event);
              setHover(under && under !== left.id ? under : null);
              return;
            }
            if (!left.displaced && Math.hypot(point.x - left.x0, point.y - left.y0) > MOVE_SLOP) {
              // Picked up. The dashed outline appears on the first real movement rather than on the press,
              // so a click does not flash it.
              left.displaced = true;
              setArmed(left.id);
            }
            left.x = point.x - left.dx;
            left.y = point.y - left.dy;
            setMoving({ id: left.id, x: left.x, y: left.y });
            // The same test the release uses, evaluated while the pointer moves, so the ghost's colour
            // and the outcome of the drop can never disagree.
            const frame = boxRef.current ? boxRef.current.getBoundingClientRect() : null;
            const carried = ordered.find((item) => item.node.id === left.id);
            setGhost({
              x: event.clientX,
              y: event.clientY,
              title: carried ? carried.node.title : left.id,
              outside: Boolean(frame && (
                event.clientX < frame.left || event.clientX > frame.right
                || event.clientY < frame.top || event.clientY > frame.bottom
              )),
            });
            return;
          }
          const right = link.current;
          if (right) {
            setDrag({ from: right.from, x: point.x, y: point.y });
            const id = nodeUnder(event);
            setHover(id && id !== right.from ? id : null);
          }
        };
        const up = (event) => {
          const left = press.current;
          const right = link.current;
          press.current = null;
          link.current = null;
          clearTimeout(timer.current);
          setArmed(null);
          setDrag(null);
          setHover(null);
          setGhost(null);
          if (left) {
            if (left.parenting) {
              // Released over another node: that node becomes the parent. Released anywhere else: nothing was
              // asked for, and nothing changes — an accidental Alt-drag must not silently detach a node or move it
              // to the top level.
              //
              // Named `over` rather than `under`: the linking branch below declares its own `under` in this same
              // block, and two declarations of one name in one scope is a TDZ failure the checker catches before
              // the browser ever runs it.
              const over = nodeUnder(event);
              if (over && over !== left.id) onParent(left.id, over);
            } else if (left.linking) {
              const under = nodeUnder(event);
              if (under && under !== left.id) onLink(left.id, under);
            } else if (left.displaced) {
              setMoving(null);
              // Releasing outside the canvas is the gesture for "take this to the conversation". The
              // node stays where it was: it was not being moved, it was being handed over.
              const frame = boxRef.current ? boxRef.current.getBoundingClientRect() : null;
              if (frame && event && (
                event.clientX < frame.left || event.clientX > frame.right
                || event.clientY < frame.top || event.clientY > frame.bottom
              )) {
                onSendToChat(left.id);
                press.current = null;
                return;
              }
              setLastDrag({
                id: left.id,
                x: left.x,
                y: left.y,
                // The shifted position, the one the drag reads — not the pre-shift layout.
                auto: placedRef.current ? placedRef.current[left.id] : null,
                point: lastPointer.current,
                grab: grabOffset.current,
              });
              onMove(left.id, left.x, left.y);
            } else {
              setEditingId((existing) => (existing === left.id ? null : left.id));
            }
          }
          if (right) {
            const id = nodeUnder(event);
            if (id && id !== right.from) onLink(right.from, id);
          }
        };
        const cancel = () => {
          press.current = null;
          link.current = null;
          clearTimeout(timer.current);
          setArmed(null);
          setMoving(null);
          setDrag(null);
          setHover(null);
        };
        window.addEventListener('pointermove', step);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', cancel);
        return () => {
          window.removeEventListener('pointermove', step);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', cancel);
        };
      }, [onLink, onMove]);

      // The routing below is quadratic in the node count: every edge tries all 16 attachment pairs, and each
      // pair is tested against every other box in the canvas. Measured on this workspace's own bases that came
      // to about 30 000 operations per render — and it sat inside the pan/zoom transform layer, so a single
      // frame of dragging paid for all of it. That is what "the canvas gets heavy as the content grows" was.
      //
      // A memo over the objects would never hit: `ordered` and `placed` are rebuilt on every render, so a
      // dependency list of them rebuilds every render too. The key is therefore a value, and it names
      // everything the routing reads — each node's box, its parent, the links, the drag in flight, and the
      // unsaved set. A key that misses one of those draws the edges where things used to be, and does it
      // silently; that list is the whole mechanism, so it is written out rather than inferred.
      const routeKey = (() => {
        const boxes = [];
        for (const entry of visibleOrdered) {
          const box = rectOf(entry.node.id);
          boxes.push({
            id: entry.node.id,
            parent: entry.node.parent || '',
            x: box ? box.x : null,
            y: box ? box.y : null,
            w: box ? box.w : null,
            h: box ? box.h : null,
          });
        }
        return routeKeyOf(boxes, drag, allLinks, unsaved);
      })();

      const routed = React.useMemo(() => {
        const parentEdges = [];
        visibleOrdered.forEach((entry) => {
          const parent = entry.node.parent ? rectOf(entry.node.parent) : null;
          const self = rectOf(entry.node.id);
          if (parent && self) {
            const others = visibleOrdered
              .filter((item) => item.node.id !== entry.node.parent && item.node.id !== entry.node.id)
              .map((item) => rectOf(item.node.id)).filter(Boolean);
            parentEdges.push({
              fromId: entry.node.parent, from: parent, toId: entry.node.id, to: self,
              route: bestLink(parent, self, others),
            });
          }
        });

        // centreOf and edgePoint live with the other pure geometry, so the load check can assert on
        // them: whether a link starts on the border or a few pixels inside is exactly the kind of bug
        // that is obvious in a screenshot and invisible in a passing test suite.
        const linkPaths = allLinks.map((link) => {
          const from = rectOf(link.from);
          const to = rectOf(link.to);
          if (!from || !to) return null;
          // Every other box in the canvas is a candidate obstacle; routeLink decides which of them
          // the curve actually has to avoid, working from the curve rather than from the chord.
          const others = visibleOrdered
            .filter((entry) => entry.node.id !== link.from && entry.node.id !== link.to)
            .map((entry) => rectOf(entry.node.id))
            .filter(Boolean);

          // Try every attachment pair and keep the best drawing.
          const { start: a, end: b, control, bow } = bestLink(from, to, others);
          return {
            from: link.from,
            to: link.to,
            // Carried through so the click target can open the editor with what is already there.
            note: link.note || '',
            d: 'M' + a.x.toFixed(1) + ' ' + a.y.toFixed(1)
              + ' Q' + control.x.toFixed(1) + ' ' + control.y.toFixed(1)
              + ' ' + b.x.toFixed(1) + ' ' + b.y.toFixed(1),
            bowed: bow > 0.5,
            pending: unsaved.has(link.from + '>' + link.to),
          };
        }).filter(Boolean);

        const band = drag && rectOf(drag.from)
          ? (() => {
            const start = edgePoint(rectOf(drag.from), { x: drag.x, y: drag.y });
            return 'M' + start.x + ' ' + start.y + ' L' + drag.x + ' ' + drag.y;
          })()
          : null;
        return { parentEdges, linkPaths, band };
        // routeKey names every input on purpose. Listing the objects as well would rebuild on every render
        // and defeat the memo — which is the failure this whole block exists to avoid, in the other direction.
      }, [routeKey]);
      const { parentEdges, linkPaths, band } = routed;

      // The canvas needs a height of its own. `flex: 1` alone does nothing here: the pane gives
      // the tab body no definite height, so `height: 100%` resolves to auto, the flex container
      // has no free space to distribute, and the canvas gets pinned at its minimum. Measured
      // from the rendered panel, it sat at exactly the old minimum. Sizing off the viewport is
      // the robust alternative, since the right pane is full height.
      const canvasMin = fullscreen ? '72vh' : '56vh';
      const previewEntry = view.k < DETAIL_ZOOM && spotlight !== null && !hiddenNodes.has(spotlight) && !moving && !drag && !pan.current
        ? entryById.get(spotlight) : null;
      const previewNode = previewEntry ? Object.assign({}, previewEntry.node, edits && edits[spotlight]) : null;
      const previewBody = previewNode ? String(previewNode.body || '')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '图片：$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/\*\*|__|`/g, '') : '';
      const toolButton = (label, title, onClick) => h('button', {
        type: 'button',
        title,
        onClick,
        style: {
          padding: '1px 7px',
          border: '1px solid ' + HAIRLINE,
          borderRadius: 6,
          background: 'transparent',
          color: 'inherit',
          font: 'inherit',
          fontSize: 11.5,
          cursor: 'pointer',
        },
      }, label);

      // A set of controls that act on the same thing, drawn as one pill so the grouping is visible.
      const toolGroup = (title, children) => h('span', {
        title,
        style: {
          display: 'inline-flex', alignItems: 'center',
          border: '1px solid ' + HAIRLINE, borderRadius: 7, overflow: 'hidden',
        },
      }, children.map((child, index) => (child == null ? null : h('span', {
        key: index,
        style: index === 0
          ? { display: 'inline-flex' }
          : { display: 'inline-flex', borderLeft: '1px solid ' + HAIRLINE },
      }, child))));

      return h(React.Fragment, null,
        // Component-local styles, rendered as an element so unmounting removes them. The two
        // states below have to live here rather than inline: an inline `outline` would beat
        // `:focus-visible`, which would leave keyboard focus with no visible indicator.
        h('style', null,
          '[data-kb-canvas], [data-kb-canvas] * { user-select: none; -webkit-user-select: none; }'
          + '[data-kb-canvas] input, [data-kb-canvas] textarea { user-select: text; -webkit-user-select: text; }'
          + '[data-kb-canvas] pre, [data-kb-canvas] code { font-family: "Cascadia Code", Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace; }'
          + '[data-kb-node] { cursor: pointer; }'
          + '[data-kb-node][data-armed="true"] { cursor: grabbing; outline: 2px dashed #c9761b; outline-offset: 2px; }'
          + '[data-kb-node][data-target="true"] { outline: 2px solid #c9761b; outline-offset: 2px; }'
          // The unread walk's destination. Thicker and further out than the drag target, because it
          // has to be findable on a canvas the user did not just click on.
          + '[data-kb-node][data-focus="true"] { outline: 2px solid #c9761b; outline-offset: 4px; }'
          + '[data-kb-node]:focus { outline: none; }'
          + '[data-kb-node]:focus-visible { outline: 2px solid rgba(128,128,128,0.75); outline-offset: 2px; }'
          + '[data-reorderable] { cursor: grab; }'
          + '[data-lifted="true"] { cursor: grabbing; }'
          + '[data-kb-canvas] svg { pointer-events: none; }'
          // The two directions are deliberately unequal.
          //
          // With one duration for both, switching nodes drops the old set and lifts the new set in
          // lockstep, which reads as the canvas flashing to a different drawing. Letting the rising
          // lines arrive first and the receding ones trail behind turns it into a handover: the new
          // emphasis is readable almost immediately, and what it replaced is still on its way out
          // rather than already gone. Hover happens constantly, so "quick" here still means quick.
          //
          // Less dim than it was, for the same reason: the size of the jump is what reads as a
          // flash, and 0.12 was a bigger one than the emphasis needed.
          + '[data-kb-edge] { opacity: 1; transition: opacity 200ms cubic-bezier(.22,1,.36,1); }'
          + '[data-kb-edge][data-dim="true"] {'
          + ' opacity: 0.16; transition: opacity 340ms cubic-bezier(.22,1,.36,1); }'
          + '@media (prefers-reduced-motion: reduce) {'
          + ' [data-kb-edge], [data-kb-edge][data-dim="true"] { transition-duration: 1ms; } }'),
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' },
        },
          toolGroup('缩放', [
            toolButton('−', '缩小', () => zoomAt(1 / 1.2, 0, 0)),
            h('button', {
              type: 'button',
              // The readout and the 1:1 button were two controls doing one job. The one that
              // already showed the number keeps it.
              title: '回到 100%',
              onClick: () => setView({ k: 1, x: 0, y: 0 }),
              style: {
                padding: '1px 8px', border: 'none', background: 'transparent', color: 'inherit',
                font: 'inherit', fontSize: 11.5, opacity: 0.75, minWidth: 44, cursor: 'pointer',
              },
            }, Math.round(view.k * 100) + '%'),
            toolButton('＋', '放大', () => zoomAt(1.2, 0, 0)),
          ]),
          toolButton('适应', '缩放到刚好放下', () => fitTo(width, height)),
          folded.size > 0 ? toolButton('全部展开', '展开这份知识库中的所有分支', () => onCollapse({ expandAll: true })) : null,
          folded.size > 0 ? toolButton('整理可见节点', '按当前排版整理可见节点；隐藏节点保留原位置', () => setArrangeRequest(true)) : null,
          foldNotice ? h('span', { role: 'status', style: { fontSize: 12 } }, foldNotice) : null,
          // Labelled: a bare number in a row of buttons does not say what it measures.
          h('span', {
            // This used to say a single node's width was set "in its editor". It is not: the editor holds the
            // title, the body, the colour and the removal buttons. A tooltip pointing at a control which does not
            // exist is worse than no tooltip — the reader goes looking, fails, and concludes they cannot find it
            // rather than that it is not there. The per-node handles are the right edge, the bottom edge, and the
            // corner where they meet.
            title: '这份知识库里节点的默认宽度。单个节点的宽度靠拖它的右边缘（只改宽）、'
              + '下边缘（只改高）或右下角（两者一起）改。',
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 5,
              border: '1px solid ' + HAIRLINE, borderRadius: 7, padding: '1px 7px',
            },
          },
          h('span', { style: { fontSize: 11, opacity: 0.6 } }, '宽度'),
          h('input', {
            type: 'number',
            min: 120,
            max: 720,
            step: 10,
            value: Math.round(widthOf(widths, {}, base.id, '')),
            'aria-label': '这份知识库里节点的宽度',
            onChange: (event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next)) return;
              if (next < 120 || next > 720) return;
              onSetWidth(null, Math.round(next));
            },
            style: {
              width: 46, padding: '1px 3px', border: 'none', background: 'transparent',
              color: 'inherit', font: 'inherit', fontSize: 11.5,
            },
          })),
          // Drawn rather than named: the shape is the label. Switching one clears this base's dragged
          // positions, which the tooltip says out loud.
          toolGroup('排版方式', [
            ['layers', '分层', '按层排开，父节点在上'],
            ['radial', '放射', '中心向四周扇开'],
            ['staircase', '阶梯', '按层分列，从上往下'],
            ['compact', '紧凑', '放射但环更小，更密'],
          ].map(([key, label, hint]) => h('button', {
            key,
            type: 'button',
            title: label + '：' + hint + '（会取消这份库里手动拖过的位置）',
            'aria-label': label + '：' + hint,
            'aria-pressed': shape === key,
            onClick: () => {
              onSetShape(key);
              // Choosing an arrangement is a request to look at it. The template recomputes every position,
              // so the view you had is now pointing at empty canvas — which is exactly what "the canvas went
              // blank" was: the nodes had moved, not disappeared, and finding them again was the user's job.
              //
              // Centring on the root is what makes the choice legible: the new shape appears under the
              // cursor, sliding into place. `onLocate` is called in the same handler as the shape change, so
              // the glide reads the layout this change produced rather than the one it replaced.
              const root = ordered.find((entry) => !entry.node.parent || entry.node.parent === 'root');
              if (onLocate && root) onLocate(root.node.id);
            },
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 22,
              padding: 0,
              border: '1px solid ' + (shape === key ? 'rgba(128,128,128,0.75)' : HAIRLINE),
              borderRadius: 6,
              background: shape === key ? SURFACE : 'transparent',
              color: 'inherit',
              opacity: shape === key ? 1 : 0.62,
              cursor: 'pointer',
            },
          }, h(ShapeIcon, { shape: key })))),
          // `positions` here is already this base's map, keyed by node id — Body hands down
          // positions[base.id]. Indexing it again with base.id returned undefined, so the button
          // never rendered at all.
          Object.keys(positions || {}).length > 0
        ? toolButton('重排', '取消这份库里手动拖过的位置，让自动排版重新排列', () => {
            onResetLayout(base);
            // Positions move underneath the viewport. Without bringing the view to the new content, the rearranged
            // nodes end up somewhere off-screen and no gesture leads back to them — only 定位 did.
            requestAnimationFrame(() => fitTo(width, height));
          })
            : null,
          // Folded into the zoom readout above, which already showed the same thing.
          h('span', { style: { fontSize: 11, opacity: 0.5 } },
            '滚轮缩放 · 拖空白平移 · 拖节点移动 · 长按节点拉连线 · Alt+拖节点挂成子节点'),
          h('span', { style: { fontSize: 11, opacity: 0.5 } }, '右键节点看修改历史'),
          // Jump to a node by its id, which is the handle every tool call and every conversation uses.
          //
          // The canvas shows titles, so an instruction like "read o14" had no way to be followed: the id was
          // nowhere on screen. Printing the id on each box helps you confirm one you already found; this is
          // what lets you find it — pick it, and the canvas centres on it.
          onLocate ? h('select', {
            value: '',
            'aria-label': '定位到节点',
            title: '按 id 定位：选中后画布以该节点为中心',
            onChange: (event) => {
              const id = event.target.value;
              if (id) onLocate(id);
              // Back to the placeholder, so the same node can be picked again after panning away.
              event.target.value = '';
            },
            style: Object.assign({}, INPUT_STYLE, {
              flex: '0 0 auto', maxWidth: 190, padding: '1px 4px', fontSize: 11,
            }),
          },
            h('option', { value: '' }, '定位到…'),
            ordered.map((entry) => h('option', {
              key: entry.node.id,
              value: entry.node.id,
            }, entry.node.id + ' · ' + (entry.node.title || '（无标题）'))),
          ) : null,
        ),
        h('div', {
          ref: boxRef,
          'data-kb-canvas': 'true',
          onPointerDown: (event) => {
            if (!(event.target && event.target.closest && event.target.closest('[data-kb-canvas-menu]'))) {
              setCanvasMenu(null);
            }
            // A press on the canvas takes over from the slide, whatever the press turns out to be — a pan, a
            // node drag, or the start of a long press. Letting the animation finish would move the ground
            // under the gesture that just began.
            cancelAnimationFrame(glideRef.current);
            onCanvasPointerDown(event);
          },
          onContextMenu: (event) => {
            // The node's own handler stops propagation, but that depends on React's event system reaching it
            // first. This asks the DOM instead: a gesture that began on a node belongs to the node.
            const origin = event.target && event.target.closest ? event.target.closest('[data-node-id]') : null;
            if (origin) return;
            event.preventDefault();
            const holder = boxRef.current;
            if (!holder) return;
            const rect = holder.getBoundingClientRect();
            const spot = localPoint(event);
            // One menu at a time: a leftover node menu under a new canvas menu would look like one menu with
            // items from two different targets.
            setNodeMenu(null);
            setCanvasMenu({
              sx: event.clientX - rect.left,
              sy: event.clientY - rect.top,
              x: spot.x,
              y: spot.y,
            });
          },
          style: {
            position: 'relative',
            // Kept so the canvas fills properly if a host ever gives the body a definite height;
            // the min-height above is what actually sizes it today.
            flex: '1 1 auto',
            minHeight: canvasMin,
            fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
            marginTop: 6,
            overflow: 'hidden',
            border: '1px solid ' + HAIRLINE,
            borderRadius: 9,
            background: 'rgba(128,128,128,0.04)',
            cursor: 'grab',
            touchAction: 'none',
          },
        },
          previewNode ? h('aside', {
            'data-kb-reading-preview': 'true',
            'aria-label': '节点阅读预览',
            style: {
              position: 'absolute', left: 12, bottom: 12, zIndex: 35,
              width: 'calc(100% - 24px)', maxWidth: 390, padding: '12px 15px',
              boxSizing: 'border-box', border: '1px solid ' + HAIRLINE,
              borderRadius: 8, background: SURFACE_SOLID, color: 'inherit',
              boxShadow: '0 4px 18px rgba(0,0,0,0.12)', pointerEvents: 'none',
            },
          }, h('strong', { style: { fontSize: 14, lineHeight: 1.5, overflowWrap: 'anywhere' } }, previewNode.title),
            h('div', { style: { marginTop: 6, fontSize: 13, lineHeight: 1.6, opacity: 0.9, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
              previewBody.slice(0, 220) + (previewBody.length > 220 ? '…' : '')),
            h('div', { style: { marginTop: 7, fontSize: 11, opacity: 0.7 } }, previewNode.id + ' · 点击节点编辑，或放大阅读全文')) : null,
          ghost ? h('div', {
            'data-kb-ghost': ghost.outside ? 'outside' : 'inside',
            style: {
              position: 'fixed',
              left: ghost.x + 12,
              top: ghost.y + 12,
              zIndex: 40,
              pointerEvents: 'none',
              maxWidth: 240,
              padding: '4px 9px',
              borderRadius: 7,
              fontSize: 11.5,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              border: '1px solid ' + (ghost.outside ? '#c9761b' : HAIRLINE),
              background: ghost.outside ? 'rgba(201,118,27,0.16)' : SURFACE,
              color: 'inherit',
              boxShadow: '0 4px 14px rgba(0,0,0,0.16)',
            },
          }, ghost.outside ? ghost.title + '  →  松手放进输入框' : ghost.title) : null,
          // Right-click on a node. Same box as the canvas menu, because it is the same kind of control; the items
          // differ because the subject does — this one is about one node, and two of the three build structure.
          nodeMenu ? h('div', {
            'data-kb-node-menu': nodeMenu.id,
            style: {
              // Fixed, and clamped: the canvas can be panned and zoomed, the menu cannot.
              position: 'fixed',
              left: Math.min(Math.max(0, (nodeMenu.clientX || 0) + 4), Math.max(0, window.innerWidth - 172)),
              top: Math.min(Math.max(0, (nodeMenu.clientY || 0) + 4), Math.max(0, window.innerHeight - 280)),
              zIndex: 5,
              minWidth: 148,
              padding: 4,
              borderRadius: 8,
              border: '1px solid ' + HAIRLINE,
              // SOLID: a menu has to be read, and this one opens on top of a node's own text.
              background: SURFACE_SOLID,
              boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
              fontSize: 11.5,
            },
          },
            [
              ...(branches.descendants.get(nodeMenu.id) > 0 ? [[
                folded.has(nodeMenu.id) ? '展开子树' : '折叠子树',
                '仅改变画布显示，不影响知识读取或注入',
                () => { const id = nodeMenu.id; setNodeMenu(null); toggleCollapse(id); },
              ]] : []),
              ...[['跟随知识库', 'inherit'], ['全文注入', 'full'], ['按需读取', 'index']].map(([label, mode]) => [
                ((nodeInjection?.[nodeMenu.id] || 'inherit') === mode ? '✓ ' : '') + label,
                '仅设置这个节点，不影响子节点；同工作区共享',
                () => { const id = nodeMenu.id; setNodeMenu(null); onInjection(id, mode); },
              ]),
              ['新建子节点', '在这个节点下面建一个，并立刻开始编辑', () => {
                const id = nodeMenu.id;
                setNodeMenu(null);
                onCreateChild(id).then((created) => {
                  if (!created) return;
                  if (folded.has(id)) onCollapse({ node: id, collapsed: false });
                  // Placed by hand, not left to the automatic layout: an unplaced node is laid out from the whole
                  // tree's shape, which after any dragging is somewhere else entirely.
                  const spot = freeSpotNear(id);
                  if (spot) onMove(created, Math.round(spot.x), Math.round(spot.y));
                  setEditingId(created);
                });
              }],
              ['看修改历史', '这个节点被改过几次、每次改了什么', () => {
                const target = nodeMenu;
                setNodeMenu(null);
                openHistoryCard(target.id, { x: target.x, y: target.y });
              }],
              ['撤销节点改动', '只撤回这个节点【还没点过 ✓】的改动：新增的删掉、改过的回到上一版、标记移除的恢复。没有未看过的改动时不会有任何变化 —— 它不是删除。', () => {
                const target = nodeMenu;
                setNodeMenu(null);
                post('revert', { base: target.base || nodeMenu.base, node: target.id }).catch(() => {});
              }],
            ].map(([label, hint, run]) => h('button', {
              key: label,
              type: 'button',
              title: hint,
              onClick: run,
              style: {
                display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px',
                border: 'none', borderRadius: 6, background: 'transparent', color: 'inherit',
                font: 'inherit', cursor: 'pointer',
              },
            }, label)),
          ) : null,
          canvasMenu ? h('div', {
            'data-kb-canvas-menu': 'true',
            style: {
              position: 'absolute',
              left: Math.max(0, canvasMenu.sx),
              top: Math.max(0, canvasMenu.sy),
              zIndex: 5,
              minWidth: 132,
              padding: 4,
              borderRadius: 8,
              border: '1px solid ' + HAIRLINE,
              // SOLID for the same reason as the node menu: on an empty canvas there is nothing behind it, but
              // right-clicking just beside a node put that node's text through the item labels.
              background: SURFACE_SOLID,
              boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
              fontSize: 11.5,
            },
          }, h('button', {
            type: 'button',
            onClick: () => {
              const spot = { x: canvasMenu.x, y: canvasMenu.y };
              setCanvasMenu(null);
              // The node has to exist before it can be placed or edited, so both wait on its id.
              onCreateNode(null).then((id) => {
                if (!id) return;
                onMove(id, Math.round(spot.x), Math.round(spot.y));
                setEditingId(id);
              });
            },
            style: {
              display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px',
              border: 'none', borderRadius: 6, background: 'transparent', color: 'inherit',
              font: 'inherit', cursor: 'pointer',
            },
          }, '新建父节点')) : null,
          h('div', {
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              width,
              height,
              // CSS zoom lays out/hints text at its display size instead of scaling a painted layer.
              // Translation is inside zoom, so divide it to preserve the existing screen-space camera.
              zoom: view.k,
              transform: 'translate(' + (view.x / view.k) + 'px, ' + (view.y / view.k) + 'px)',
              transformOrigin: '0 0',
            },
          },
        h('svg', {
          width, height, 'aria-hidden': true,
          style: { position: 'absolute', inset: 0, overflow: 'visible' },
        },
          parentEdges.map((edge, index) => {
            // Same anchor search as a cross-link: the parent-child pair is the only pair excluded
            // from the obstacles, so a node between them still pushes the edge aside.
            const route = edge.route;
            const away = edgeFades(spotlight, edge.fromId, edge.toId);
            return h('path', {
              key: 'p' + index,
              d: 'M' + route.start.x.toFixed(1) + ' ' + route.start.y.toFixed(1)
                + ' Q' + route.control.x.toFixed(1) + ' ' + route.control.y.toFixed(1)
                + ' ' + route.end.x.toFixed(1) + ' ' + route.end.y.toFixed(1),
              fill: 'none',
              stroke: edgeStroke(view.k),
              strokeWidth: 1.1,
              // Screen pixels, not canvas units. Without this the stroke is scaled with everything else and a
              // zoomed-out canvas draws hairline edges — see edgeStroke.
              vectorEffect: 'non-scaling-stroke',
              'data-kb-edge': 'true',
              'data-dim': away ? 'true' : undefined,
            });
          }),
          linkPaths.map((path, index) => h('path', {
            key: 'l' + index,
            d: path.d,
            fill: 'none',
            // The links keep their own colour — they are the reader's own associations, not the tree — but they
            // need the same screen-pixel weight, or at 31% the dashed amber is a dotted ghost.
            stroke: '#c9761b',
            strokeWidth: 1.4,
            vectorEffect: 'non-scaling-stroke',
            strokeDasharray: path.pending ? '7 4' : '4 3',
            strokeLinejoin: 'round',
            'data-kb-edge': 'true',
            'data-dim': edgeFades(spotlight, path.from, path.to) ? 'true' : undefined,
          })),
          // A fat invisible copy of every link, so there is something to click.
          //
          // The visible line is 1.4px and now drawn in screen pixels, which is right for looking at and
          // hopeless for pointing at. Clicking one opens its note — the model has to write a note when it links
          // two nodes, and the user should be able to say the same thing about a line they drew themselves,
          // without being made to.
          linkPaths.map((path, index) => h('path', {
            key: 'h' + index,
            d: path.d,
            fill: 'none',
            stroke: 'transparent',
            strokeWidth: 14,
            vectorEffect: 'non-scaling-stroke',
            style: { pointerEvents: 'stroke', cursor: 'pointer' },
            onPointerDown: (event) => {
              event.stopPropagation();
              const spot = localPoint(event);
              setNoteFor({ from: path.from, to: path.to, note: path.note || '', x: spot.x, y: spot.y });
            },
            'data-kb-link-hit': 'true',
          })),
          band ? h('path', {
            d: band,
            fill: 'none',
            // Grey for structure, orange for association — the same distinction the finished edges make. The
            // in-flight line has to say which one you are about to create, because the release does two very
            // different things and there is no undo step between them.
            stroke: drag && drag.kind === 'parent' ? 'rgba(128,128,128,0.9)' : '#c9761b',
            strokeWidth: 1.6,
            vectorEffect: 'non-scaling-stroke',
            strokeDasharray: '3 3',
            'data-kb-band': drag && drag.kind === 'parent' ? 'parent' : 'link',
          }) : null,
        ),
        visibleOrdered.map((entry) => {
          const spot = placed[entry.node.id];
          if (editingId === entry.node.id) {
            return h(NodeEditor, {
              key: entry.node.id,
              node: entry.node,
              x: spot.x,
              y: spot.y,
              onSave: (id, patch) => {
                onEdit(id, patch);
                setEditingId(null);
              },
              onClose: () => setEditingId(null),
              color: (colors || {})[entry.node.id] || null,
              onColor,
              injectionMode: nodeInjection?.[entry.node.id], defaultInjection, onInjection,
              onRemove: onRemoveNode,
              onPurge: onPurgeNode,
              onRevert: onRevertNode,
        onAttachPicture: onAttachPicture,
              boxWidth: widthOf(widths, nodeWidths, base.id, entry.node.id, entry.node),
            });
          }
          // An edited node shows what the user typed, merged over what is on disk.
          const shown = edits && edits[entry.node.id]
            ? { node: Object.assign({}, entry.node, edits[entry.node.id]), depth: entry.depth }
            : entry;
          return h(NodeBox, {
            key: entry.node.id,
            entry: shown,
            injectionMode: nodeInjection?.[entry.node.id],
            x: spot.x,
            y: spot.y,
            onPressStart,
            onActivate,
            // Passed straight through. The implementation lives in Body, because that is where
            // `post` and the loaded bases are — referring to them from here compiles fine and
            // throws only when the button is pressed, which is how this shipped broken once.
            onReview,
            onSpotlight: setSpotlight,
            isFocus: focusId === entry.node.id,
            color: (colors || {})[entry.node.id] || null,
            isSource: Boolean(drag && drag.from === entry.node.id),
            isTarget: hover === entry.node.id,
            isEdited: Boolean(edits && edits[entry.node.id]),
            isArmed: armed === entry.node.id,
            liveWidth: resizing && resizing.id === entry.node.id ? resizing.width : null,
            liveHeight: resizing && resizing.id === entry.node.id ? resizing.height : null,
            // The same function the geometry uses, so the box that is drawn and the box the edges attach to
            // cannot disagree. They did: below `DETAIL_ZOOM` the body is not drawn, and the height came from
            // here while the edges came from `rectOf` — so at 31% the lines ended in mid-air.
            boxHeight: sizeOf(entry.node.id).h,
            // Three answers. A session's own label, "你" when the panel wrote it and said so, and nothing
            // when the node predates the field — the absence is not worth a word on every old node, and
            // saying "你" for it would be a claim the panel cannot support.
            // The labels come from Body: they are assigned across every base, and Tree renders one.
            onRename: entry.node.by ? () => renameSession(entry.node.by) : null,
            detail: view.k >= DETAIL_ZOOM,
            descendantCount: branches.descendants.get(entry.node.id) || 0,
            collapsed: folded.has(entry.node.id),
            onToggleCollapse: toggleCollapse,
            // Right-click on a node opens a small menu: create a child, create a parent, or read the history.
            //
            // The canvas's own menu is for "make something here"; this one is for "make something relative to
            // this node", which is the only way to build structure without the model.
            onNodeMenu: (id, event) => {
              const holder = boxRef.current;
              if (!holder) return;
              const rect = holder.getBoundingClientRect();
              const spot = localPoint(event);
              setCanvasMenu(null);
              setNodeMenu({
                // Which base this node is in: the undo item needs it, and the menu is the only place that knows.
                base: base.id,
                // Screen coordinates too: the menu is positioned against the viewport, not against the zooming canvas.
                clientX: event.clientX,
                clientY: event.clientY,
                id,
                sx: event.clientX - rect.left,
                sy: event.clientY - rect.top,
                // Canvas coordinates are kept alongside the screen ones: the history card is a thing on the
                // canvas and takes the canvas transform, so it needs the point in that space.
                x: spot.x,
                y: spot.y,
              });
            },
            byline: entry.node.by
              ? (labels.get(entry.node.by) || { label: '', hue: 0 })
              : (('by' in entry.node) ? { label: '你', hue: 145 } : null),
            onResizeStart: (axis) => (event) => {
              const box = boxOf(widths, nodeWidths, base.id, entry.node.id);
              // No height yet means the box is exactly as tall as its text right now. Starting from that
              // keeps the edge under the pointer instead of jumping to a default.
              const measured = sizes[entry.node.id] ? sizes[entry.node.id].h : estimateBox(entry.node).h;
              const startHeight = Number.isFinite(box.h) ? box.h : measured;
              event.preventDefault();
              event.stopPropagation();
              setResizing({
                id: entry.node.id,
                axis,
                startX: event.clientX,
                startY: event.clientY,
                startWidth: box.w,
                startHeight,
                width: box.w,
                height: startHeight,
              });
            },
            boxWidth: widthOf(widths, nodeWidths, base.id, entry.node.id, entry.node),
          });
          }),
        ),

        // The edit history. It is drawn inside the zoomed layer, in canvas coordinates, which is what makes
        // it a thing on the canvas rather than a panel floating over it: the layer's transform carries it when
        // the view is panned or zoomed, and it is clipped at the canvas edge exactly as a node is.
        //
        // Every earlier version kept it outside and tried to imitate that — arithmetic through the view, then
        // a measured rectangle, then the same transform applied by hand. Each was a copy of behaviour the
        // layer already performs, and each was wrong in a different way. Inside, there is nothing to imitate:
        // `left` and `top` are canvas coordinates, and that is the whole of it.
        //
        // The placement matters as much as the code: this sits between the nodes' `}),` and the layer's `),`,
        // which is the only position that is actually inside. One bracket earlier and the layer has already
        // closed behind it.
        // The note editor for one link. Same overlay mechanics as the history card, including the layer's
        // transform applied by hand — the card is the layer's sibling, not its child, so pan and zoom have to
        // be reproduced here or the card stays put while the canvas moves (see o16).
        noteFor ? h('div', {
          'data-kb-link-note': noteFor.from + '>' + noteFor.to,
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            transform: 'translate(' + (view.x + noteFor.x * view.k) + 'px, '
              + (view.y + noteFor.y * view.k) + 'px) scale(' + view.k + ')',
            transformOrigin: '0 0',
            zIndex: 3,
            width: 280,
            padding: '9px 11px',
            borderRadius: 9,
            border: '1px solid #c9761b',
            background: 'Canvas',
            color: 'CanvasText',
            boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
            fontSize: 11.5,
            lineHeight: 1.5,
          },
          onPointerDown: (event) => event.stopPropagation(),
        },
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 } },
            h('div', { style: { fontWeight: 600, fontSize: 12.5 } }, '这条关联的注释'),
            h('button', {
              type: 'button',
              onClick: () => setNoteFor(null),
              style: {
                marginLeft: 'auto', padding: '0 6px', border: '1px solid ' + HAIRLINE, borderRadius: 6,
                background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 11, cursor: 'pointer',
              },
            }, '关闭'),
          ),
          h('div', { style: { opacity: 0.55, marginBottom: 5 } },
            noteFor.from + ' <-> ' + noteFor.to),
          h('textarea', {
            autoFocus: true,
            defaultValue: noteFor.note,
            'data-kb-note-input': 'true',
            placeholder: '什么时候该顺着这条线走？',
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setNoteFor(null);
              }
              // Enter saves, Shift+Enter is a newline. The note is one line by convention, not by force.
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.blur();
                onSetLinkNote(noteFor.from, noteFor.to, event.currentTarget.value);
              }
            },
            onBlur: (event) => onSetLinkNote(noteFor.from, noteFor.to, event.target.value),
            style: {
              width: '100%', boxSizing: 'border-box', minHeight: 52, resize: 'vertical',
              border: '1px solid ' + HAIRLINE, borderRadius: 6, padding: '5px 7px',
              background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 11.5, lineHeight: 1.5,
            },
          }),
          h('div', { style: { opacity: 0.5, marginTop: 4 } },
            '回车保存 · Esc 关闭 · 留空即删除注释'),
        ) : null,
        historyFor ? (() => {
          const item = ordered.find((entry) => entry.node.id === historyFor.id);
          // A silent `return null` here is the worst outcome: nothing appears, and the reason is invisible.
          // Both failure modes now say what they are, so the next look at the screen is the diagnosis.
          if (!item) {
            return h('div', {
              'data-kb-history': 'missing',
              style: {
                position: 'absolute', left: historyFor.x, top: historyFor.y, zIndex: 3,
                padding: '6px 9px', borderRadius: 8, border: '1px solid #c0392b',
                background: 'Canvas', color: '#c0392b', fontSize: 11.5,
              },
            }, '历史：找不到节点 ' + historyFor.id);
          }
          const entries = Array.isArray(item.node.history) ? item.node.history.slice().reverse() : [];
          // Computed once here rather than per row, and by a function a check can reach — see `historyMarks`.
          const marks = historyMarks(entries, item.node.body);
          return h('div', {
            'data-kb-history': historyFor.id,
            // The canvas leaves the wheel alone over this card.
            //
            // The card scrolls (`maxHeight` below) and the wheel is bound to zoom, so without this the reader
            // cannot scroll the history at all — they zoom instead, which is what "展开全文以后滚不动" was.
            //
            // It went unnoticed because the card used to hold a few lines of times and session names and never
            // reached its own height limit; nothing about it scrolled, so nothing about it needed the wheel.
            // Bodies made it long enough to scroll for the first time.
            //
            // The same mark the node boxes use, and it carries the same trade: while the pointer is over a card
            // that happens to have nothing to scroll, the wheel does nothing rather than zooming. That is the
            // behaviour already established for a fixed-height node, and moving the pointer off restores
            // zooming — which is a smaller surprise than a scroll gesture that zooms.
            'data-kb-scroll': 'true',
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              // The layer's own transform, applied by hand because the card is its sibling rather than its
              // child. `historyFor.x/y` are canvas coordinates, so this maps them the same way the layer maps
              // its children: pan and zoom now carry the card exactly as they carry a node.
              //
              // Without it the card sat at a canvas coordinate inside a box that is not transformed — so it
              // never moved when the canvas was panned, which is what "钉死" was: a fixed card in a moving
              // scene, whose right-hand end could be pushed off the canvas with no way to reach it.
              transform: 'translate(' + (view.x + historyFor.x * view.k) + 'px, '
                + (view.y + historyFor.y * view.k) + 'px) scale(' + view.k + ')',
              transformOrigin: '0 0',
              zIndex: 3,
              width: 300,
              maxHeight: 360,
              overflowY: 'auto',
              padding: '9px 11px',
              borderRadius: 9,
              border: '1px solid ' + HAIRLINE,
              // An opaque colour from the system palette. The translucent surface used elsewhere is right
              // for an overlay meant to be seen through; this one has to be read.
              background: 'Canvas',
              color: 'CanvasText',
              boxShadow: '0 6px 18px rgba(0,0,0,0.22)',
              fontSize: 11.5,
              lineHeight: 1.5,
            },
          },
            h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 } },
              h('div', { style: { fontWeight: 600, fontSize: 12.5 } }, '修改历史'),
              h('div', { style: { opacity: 0.5, fontSize: 11 } }, item.node.title || historyFor.id),
              // Two steps on purpose: the card is for a quick look where you are already looking, and this
              // hands the same history to the whole panel when the box is too small to read in. Ten versions of
              // a long body is exactly that case, and so is wanting to compare against the canvas while reading.
              h('button', {
                type: 'button',
                title: '在面板里展开（整块的宽和高）',
                onClick: () => {
                  setHistoryFor(null);
                  onShowHistory(item.node.id);
                },
                style: {
                  marginLeft: 'auto', padding: '0 6px', border: '1px solid ' + HAIRLINE, borderRadius: 6,
                  background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 11, cursor: 'pointer',
                },
              }, '展开 ⤢'),
              h('button', {
                type: 'button',
                onClick: () => setHistoryFor(null),
                style: {
                  padding: '0 6px', border: '1px solid ' + HAIRLINE, borderRadius: 6,
                  background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 11, cursor: 'pointer',
                },
              }, '关闭'),
            ),
            // The version on disk, then every version kept. The card used to list times and sessions only,
            // because that was all the store kept — a local git with commit dates and no contents. It keeps
            // the contents now, so this shows them, and shows what changed between them.
            //
            // Each side carries one half of the change: the current version marks what it added relative to the
            // one before it, and each older version marks what was deleted after it. Together the two halves
            // are the whole edit, and neither has to display both kinds at once — which on a reworded paragraph
            // would be a page of confetti.
            (() => {
              const after = entries.length ? (entries[0].body || '') : ''
              const lines = entries.length ? diffLines(after, item.node.body || '').next : null
              return h('div', {
                style: { paddingBottom: 7, marginBottom: 7, borderBottom: '1px solid ' + HAIRLINE },
              },
                h('div', { style: { display: 'flex', gap: 7, alignItems: 'baseline', marginBottom: 3 } },
                  h('span', { style: { fontWeight: 600, fontSize: 11.5 } }, '当前'),
                  h('span', { style: { opacity: 0.45, fontSize: 10.5 } }, shortWhen(item.node.at)),
                  entries.length ? h('span', { style: { opacity: 0.45, fontSize: 10.5 } },
                    lines && lines.some((line) => worthMarking(line))
                      ? '（绿色是相对上一版新增的，' + lines.filter((line) => worthMarking(line)).length + ' 处）'
                      : '（与上一版相同）') : null,
                ),
                h('div', { style: { fontWeight: 600, marginBottom: 2 } }, item.node.title || historyFor.id),
                h(VersionBody, { text: item.node.body, lines }),
              );
            })(),
            entries.length === 0
              ? h('div', { style: { opacity: 0.55 } }, '没有更早的版本（写在加历史之前）。')
              : entries.map((entry, index) => {
                // What this version lost, which is defined by what replaced it: the current node for the newest
                // kept version, and the entry above it for every older one. See `historyMarks` for what went
                // wrong when that rule was written inline as "the entry below it".
                const marked = marks[index] ? marks[index].lines : null;
                return h('div', {
                  key: index,
                  style: {
                    paddingTop: index ? 7 : 0,
                    marginTop: index ? 7 : 0,
                    borderTop: index ? '1px solid ' + HAIRLINE : undefined,
                    // Older versions fade rather than disappear: the newest kept version is the one being
                    // compared against the present, and it should not read as less real than the rest.
                    opacity: index === 0 ? 1 : 0.72,
                  },
                },
                  h('div', { style: { display: 'flex', gap: 7, alignItems: 'baseline', marginBottom: 3 } },
                    h('span', {
                      style: { fontVariantNumeric: 'tabular-nums', opacity: 0.7 },
                    }, shortWhen(entry.at)),
                    h('span', { style: { opacity: 0.7 } },
                      entry.by ? ((names && names[entry.by]) || '一个会话') : '你'),
                    index === 0 ? h('span', { style: { opacity: 0.45, fontSize: 10.5 } }, '上一个版本') : null,
                    marked && marked.some((line) => worthMarking(line))
                      ? h('span', { style: { opacity: 0.45, fontSize: 10.5 } },
                        '（红色是之后被删掉的，' + marked.filter((line) => worthMarking(line)).length + ' 处）')
                      : null,
                  ),
                  // Entries written before the store kept contents have neither field. Saying so is the honest
                  // option; showing an empty body would read as "it was blank", which is a different fact.
                  entry.title === undefined && entry.body === undefined
                    ? h('div', { style: { opacity: 0.5, fontStyle: 'italic' } }, '这一版没有留下内容（写在存内容之前）。')
                    : h(React.Fragment, null,
                      entry.title ? h('div', { style: { fontWeight: 600, marginBottom: 2 } }, entry.title) : null,
                      h(VersionBody, { text: entry.body, lines: marked }),
                    ),
                );
              }),
          );
        })() : null,
        ),
      );
    }

    /**
     * One version's body inside the history card.
     *
     * `lines` is the diff-marked form from `diffLines` when there is another version to compare against; absent
     * means the version stands alone and is printed as it was written.
     *
     * Folded rather than truncated. `HISTORY_LIMIT` is ten, and ten full bodies printed flat would make the
     * card unreadable and its scroll useless — but the reason to keep the bodies at all is to read them, so
     * the rest is one click away rather than cut off. The fold is by line count, and when the folded-away part
     * contains changes the button says how many, because a fold that hides the one line you opened the card to
     * see is worse than no fold.
     */
    function VersionBody({ text, lines }) {
      const [open, setOpen] = React.useState(false);
      const body = typeof text === 'string' ? text : '';
      if (!body.trim()) {
        return h('div', { style: { opacity: 0.45, fontStyle: 'italic' } }, '（这一版没有正文）');
      }
      const marked = Array.isArray(lines) ? lines : null;
      const count = marked ? marked.length : body.split('\n').length;
      const hiddenChanges = marked && !open
        ? marked.slice(FOLD_LINES).filter((line) => worthMarking(line)).length
        : 0;
      const folded = !open && (count > FOLD_LINES || body.length > 320);
      const shown = marked ? (open ? marked : marked.slice(0, FOLD_LINES)) : null;
      return h('div', null,
        h('div', {
          style: {
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            maxHeight: folded && !marked ? 74 : undefined, overflow: 'hidden',
            // Fades at the cut rather than ending mid-glyph, so "there is more" reads as a fact of the layout
            // and not as a rendering accident. Only when the cut is by height; a marked body is cut by line.
            maskImage: folded && !marked ? 'linear-gradient(to bottom, #000 62%, transparent)' : undefined,
            WebkitMaskImage: folded && !marked ? 'linear-gradient(to bottom, #000 62%, transparent)' : undefined,
          },
        },
          shown
            ? shown.map((line, index) => h('div', {
              key: index,
              style: {
                // The two marks the whole diff exists for. Tinted rather than coloured text: these bodies
                // contain their own emphasis, and recolouring the words would fight it. A blank line gets
                // neither, however real its difference — see `worthMarking`.
                background: line.kind === 'added' && worthMarking(line) ? 'rgba(46,160,67,0.16)'
                  : line.kind === 'removed' && worthMarking(line) ? 'rgba(196,60,60,0.14)' : undefined,
                borderLeft: line.kind === 'added' && worthMarking(line) ? '2px solid rgba(46,160,67,0.7)'
                  : line.kind === 'removed' && worthMarking(line) ? '2px solid rgba(196,60,60,0.7)'
                    : '2px solid transparent',
                paddingLeft: 5,
                // A deleted line is not in this version any more, so it should not read as current text.
                opacity: line.kind === 'removed' ? 0.75 : 1,
              },
            }, line.text === '' ? '\u00a0' : line.text))
            : body,
        ),
        folded ? h('button', {
          type: 'button',
          onClick: () => setOpen(true),
          style: {
            marginTop: 2, padding: 0, border: 0, background: 'transparent', color: 'inherit',
            font: 'inherit', fontSize: 10.5, opacity: 0.6, cursor: 'pointer', textDecoration: 'underline',
          },
        }, '展开全文（' + count + ' 行'
          + (hiddenChanges ? '，其中 ' + hiddenChanges + ' 处改动' : '') + '）') : null,
        open && (count > FOLD_LINES || body.length > 320) ? h('button', {
          type: 'button',
          onClick: () => setOpen(false),
          style: {
            marginTop: 2, padding: 0, border: 0, background: 'transparent', color: 'inherit',
            font: 'inherit', fontSize: 10.5, opacity: 0.6, cursor: 'pointer', textDecoration: 'underline',
          },
        }, '收起') : null,
      );
    }

    /**
     * One node's edit history, taking the whole panel.
     *
     * It used to be a 300×360 card floating inside the canvas, and that had three problems at once: a
     * 1,900-character body had to be scrolled inside a box that size, ten versions turned it into a long
     * crawl, and the card covered the canvas you had opened it to compare against. Here it gets the panel's
     * full width and height, the canvas keeps its scroll position while you are away, and the transform
     * gymnastics the card needed (`o16`) do not apply — this is not on the canvas at all.
     *
     * `node` is the node as the panel last read it, or null when the base or the node is gone. Both cases say
     * which one is missing rather than rendering nothing.
     */
    function HistoryView({ baseName, baseId, node, nodeId, names, onBack }) {
      const header = h('div', {
        style: {
          display: 'flex', alignItems: 'baseline', gap: 8,
          padding: '0 0 10px', borderBottom: '1px solid ' + HAIRLINE, marginBottom: 11,
        },
      },
        h('button', {
          type: 'button',
          onClick: onBack,
          style: {
            padding: '1px 8px', border: '1px solid ' + HAIRLINE, borderRadius: 6,
            background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 11.5, cursor: 'pointer',
          },
        }, '← 返回'),
        h('div', { style: { fontSize: 13, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          node ? (node.title || nodeId) : nodeId),
        h('div', { style: { opacity: 0.45, fontSize: 11, whiteSpace: 'nowrap' } },
          baseName ? baseName + ' · ' + nodeId : nodeId),
      );

      if (!node) {
        return h('div', {
          style: {
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 6,
            boxSizing: 'border-box', display: 'flex', flexDirection: 'column', padding: '14px 16px',
            background: 'Canvas', color: 'CanvasText', font: 'inherit',
          },
        },
          header,
          h('div', { style: { opacity: 0.7 } },
            '这个节点在 ' + baseId + ' 里已经找不到了 —— 它可能被彻底删除了。'),
        );
      }

      const entries = Array.isArray(node.history) ? node.history.slice().reverse() : [];
      // Computed once, by a function a check can reach — see `historyMarks`. Every kept version is compared
      // against the version that replaced it: the node itself for the newest, the entry above for the rest.
      const marks = historyMarks(entries, node.body);

      /** One block of the list: a header line, a title, and a body that may carry diff marks. */
      const version = ({ key, label, when, who, title, body, lines, hint }) => h('div', {
        key,
        style: {
          paddingTop: key === 'current' ? 0 : 11, marginTop: key === 'current' ? 0 : 11,
          borderTop: key === 'current' ? undefined : '1px solid ' + HAIRLINE,
        },
      },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4, flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600, fontSize: 11.5 } }, label),
          when ? h('span', { style: { opacity: 0.55, fontVariantNumeric: 'tabular-nums', fontSize: 11 } }, when) : null,
          who ? h('span', { style: { opacity: 0.55, fontSize: 11 } }, who) : null,
          hint ? h('span', { style: { opacity: 0.45, fontSize: 10.5 } }, hint) : null,
        ),
        title ? h('div', { style: { fontWeight: 600, marginBottom: 3 } }, title) : null,
        h(VersionBody, { text: body, lines }),
      );

      return h('div', {
        'data-kb-history': nodeId,
        style: {
          // A layer over the panel, not a replacement for it: the list underneath stays mounted so every
          // canvas keeps its pan and zoom. `top/left/right/bottom` rather than `inset` — the shorthand is
          // fine in a browser but this is written as a React style object, where the longhand is what every
          // other overlay in this file uses.
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 6,
          boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
          padding: '14px 16px 18px', font: 'inherit', color: 'inherit',
          // Opaque, so the panel underneath does not show through — it is still there, and still laid out.
          background: 'Canvas',
        },
      },
        header,
        h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 } },
          version({
            key: 'current',
            label: '当前',
            when: shortWhen(node.at),
            who: '你看到的这一版',
            title: entries.length ? null : undefined,
            body: node.body,
            lines: entries.length ? diffLines(entries[0].body || '', node.body || '').next : null,
            hint: entries.length && (marks[0].lines || []).some((row) => worthMarking(row))
              ? null
              : (entries.length ? '（与上一版相同）' : null),
          }),
          entries.length === 0
            ? h('div', { style: { opacity: 0.55, marginTop: 12, paddingTop: 11, borderTop: '1px solid ' + HAIRLINE } },
              '没有更早的版本。这一版之前的历史要么没写过，要么写在"存内容"这个功能之前。')
            : entries.map((entry, index) => {
              const marked = marks[index] ? marks[index].lines : null;
              const changed = marked ? marked.filter((row) => worthMarking(row)).length : 0;
              return version({
                key: 'v' + index,
                label: index === 0 ? '上一个版本' : '更早',
                when: shortWhen(entry.at),
                who: entry.by ? ((names && names[entry.by]) || '一个会话') : '你',
                title: entry.title === undefined && entry.body === undefined
                  ? '（这一版没有留下内容）' : entry.title,
                body: entry.body,
                lines: marked,
                hint: changed ? '（红色是之后被删掉的，' + changed + ' 处）' : null,
              });
            }),
        ),
      );
    }

    /**
     * One frame of the whale, as a square slice of the strip.
     *
     * `background-position` picks the frame: the sheet lies along one row, so moving it left by one frame width shows
     * the next. `imageRendering: pixelated` is not decoration — the art is drawn on a pixel grid, and the browser's
     * default smoothing turns it into a smudge at this size.
     */
    function Whale({ state, size }) {
      // No hooks. The only thing that varies with time is which loop is showing, and the clock already varies; the panel
      // re-renders on its poll, so a fifteen-second window flips on its own. A component with no hooks cannot mismatch
      // them between renders, which is the bug this file hit once when the random-expression path lived here.
      const active = Boolean(state) && state !== 'idle'
      const pick = active
        ? WHALE_WORK
        : WHALE_IDLE_LOOPS[Math.floor(Date.now() / 15000) % WHALE_IDLE_LOOPS.length]
      const style = {
        width: size,
        height: size,
        flex: '0 0 auto',
        backgroundImage: 'url("' + whaleSheet(pick.sheet) + '")',
        backgroundSize: pick.grid
          ? (size * WHALE_COLS) + 'px ' + (size * WHALE_ROWS) + 'px'
          : (size * pick.frames) + 'px ' + size + 'px',
        backgroundPosition: '0 0',
        backgroundRepeat: 'no-repeat',
        imageRendering: 'pixelated',
        animation: pick.anim + ' ' + pick.ms + 'ms steps(' + pick.frames + ') infinite',
      }
      return h('div', {
        'aria-hidden': 'true',
        'data-kb-whale': state || 'idle',
        'data-kb-whale-loop': pick.loop,
        style,
      })
    }

    function Note({ children }) {
      return h('div', { style: { marginTop: 10, fontSize: 11.5, opacity: 0.55, lineHeight: 1.65 } }, children);
    }

    // Presentation only: never rewrite the encrypted diary or its graph to make a book.
    function diaryPages(base) {
      const nodes = (base.nodes || []).filter((node) => node.change !== 'removed');
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const monthOf = (text) => {
        const match = /^(\d{4})\s*(?:年|[-/])\s*(\d{1,2})(?:\s*月|[-/]|$)/.exec(String(text || '').trim());
        return match && Number(match[2]) >= 1 && Number(match[2]) <= 12
          ? match[1] + '-' + match[2].padStart(2, '0') : null;
      };
      return nodes.filter((node) => !monthOf(node.title)
        && !(node.parent == null && /^(按月分组|日记目录|日记)$/.test(node.title || '')))
        .map((node, index) => {
          const dates = (node.history || []).map((entry) => entry.at).filter(Boolean).concat(node.at || []).sort();
          const writtenAt = String(dates[0] || '');
          let month = null;
          let ancestor = byId.get(node.parent);
          const visited = new Set([node.id]);
          while (ancestor && !visited.has(ancestor.id)) {
            visited.add(ancestor.id);
            month = monthOf(ancestor.title);
            if (month) break;
            ancestor = byId.get(ancestor.parent);
          }
          month = month || monthOf(writtenAt) || '未注明月份';
          const source = String(node.body || '');
          const hint = /(?:^|\n)\s*什么时候该想起它[：:]\s*([^]*)$/.exec(source);
          const body = hint ? source.slice(0, hint.index).trimEnd() : source;
          return { node, month, writtenAt, body, hint: hint ? hint[1].trim() : '', index };
        }).sort((a, b) => b.writtenAt.localeCompare(a.writtenAt) || b.index - a.index);
    }

    function DiaryReplies({ baseId, nodeId, onReplyAction, draftStore }) {
      const [replies, setReplies] = React.useState([]);
      const [draft, setDraft] = React.useState(draftStore.current[nodeId] || '');
      const [busy, setBusy] = React.useState(false);
      const [replyError, setReplyError] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const pendingReply = React.useRef(null);
      const busyReply = React.useRef(false);
      const mountedReply = React.useRef(true);
      const transport = React.useRef(onReplyAction);
      transport.current = onReplyAction;
      React.useEffect(() => {
        let cancelled = false;
        mountedReply.current = true;
        const read = async () => {
          if (document.visibilityState === 'hidden') return;
          try {
            const answer = await transport.current('diaryreplies', { base: baseId, node: nodeId });
            if (!cancelled) { setReplies(answer.replies || []); setLoading(false); }
          } catch (error) {
            if (!cancelled) { setReplyError('读取回复失败：' + (error && error.message ? error.message : error)); setLoading(false); }
          }
        };
        read();
        const timer = window.setInterval(read, 10000);
        return () => { cancelled = true; mountedReply.current = false; window.clearInterval(timer); };
      }, [baseId, nodeId]);
      const sendReply = async (existing) => {
        if (busyReply.current) return;
        const text = existing ? existing.text : draft.trim();
        if (!text) return;
        const held = pendingReply.current;
        const id = existing ? existing.id : (held && held.text === text ? held.id : crypto.randomUUID());
        pendingReply.current = { id, text };
        busyReply.current = true;
        setBusy(true);
        setReplyError('');
        try {
          const answer = await transport.current('diaryreply', { base: baseId, node: nodeId, id, text });
          if (!mountedReply.current) {
            if (answer.accepted && draftStore.current[nodeId] === text) delete draftStore.current[nodeId];
            return;
          }
          setReplies((current) => current.filter((entry) => entry.id !== id).concat(answer.reply).sort((a, b) => a.at.localeCompare(b.at)));
          if (answer.accepted) {
            if (!existing || draft.trim() === text) { setDraft(''); delete draftStore.current[nodeId]; }
            pendingReply.current = null;
          } else setReplyError(answer.reply.error || '还没有确认送达，可在下方重试。');
        } catch (error) {
          if (mountedReply.current) setReplyError('发送未确认，原文已保留。可重试同一条：' + (error && error.message ? error.message : error));
        } finally {
          busyReply.current = false;
          if (mountedReply.current) setBusy(false);
        }
      };
      const replyButton = {
        padding: '6px 11px', border: '1px solid var(--diary-rule)', borderRadius: 5,
        color: 'inherit', background: 'transparent', font: 'inherit', fontSize: 12, cursor: 'pointer',
      };
      return h('section', { 'data-kb-diary-replies': nodeId, 'aria-label': '日记回复', style: { marginTop: 30, paddingTop: 22, borderTop: '1px solid var(--diary-rule)' } },
        h('h3', { style: { fontSize: 16, fontWeight: 500, margin: '0 0 12px' } }, '这一页，想对 TA 说什么？'),
        loading ? h('p', { style: { fontSize: 12, color: 'var(--diary-muted)' } }, '正在翻看回复…') : null,
        replies.map((entry) => h('div', { key: entry.id, style: { marginBottom: 13, padding: '10px 12px', borderLeft: '2px solid var(--diary-rule)' } },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--diary-muted)', marginBottom: 5 } },
            h('span', null, '你'), h('time', { dateTime: entry.at }, new Date(entry.at).toLocaleString()),
            h('span', { role: 'status' }, entry.status === 'sent' ? '已送到当前会话' : '尚未确认送达'),
          ),
          h('p', { style: { fontSize: 14, lineHeight: 1.8, margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, entry.text),
          entry.status !== 'sent' ? h('button', { type: 'button', disabled: busy, style: { ...replyButton, marginTop: 7 }, onClick: () => sendReply(entry) }, '重试这条回复') : null,
        )),
        h('form', { onSubmit: (event) => { event.preventDefault(); sendReply(null); } },
          h('textarea', {
            'aria-label': '回复这篇日记', placeholder: '看到这里，想和 TA 说……', value: draft, maxLength: 4000, rows: 3, disabled: busy,
            onChange: (event) => { setDraft(event.currentTarget.value); draftStore.current[nodeId] = event.currentTarget.value; },
            style: { width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: 88, padding: '10px 12px', background: 'var(--diary-paper)', color: 'var(--diary-ink)', border: '1px solid var(--diary-rule)', borderRadius: 5, font: 'inherit', fontSize: 14, lineHeight: 1.8 },
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 8 } },
            h('button', { type: 'submit', disabled: busy || !draft.trim(), style: { ...replyButton, opacity: busy || !draft.trim() ? 0.5 : 1 } }, busy ? '正在送给 TA…' : '回复 TA'),
            h('span', { style: { fontSize: 11, color: 'var(--diary-muted)' } }, '会发送到当前会话，TA 会在那里回应。'),
          ),
        ),
        replyError ? h('p', { role: 'alert', style: { fontSize: 12, lineHeight: 1.7, color: '#b94444' } }, replyError) : null,
      );
    }


    function DiaryBook({ base, onReplyAction, onSendToChat, onShowHistory, onReview, onLocate, focusNode, onFocusShown, names, onCanvas }) {
      const pages = diaryPages(base);
      const replyDrafts = React.useRef({});
      const [selectedId, setSelectedId] = React.useState(null);
      const [month, setMonth] = React.useState('');
      const [sending, setSending] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [catalog, setCatalog] = React.useState(false);
      const paperRef = React.useRef(null);
      const frameRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const [dragLabel, setDragLabel] = React.useState(null);
      const months = [...new Set(pages.map((page) => page.month))].sort((a, b) => {
        if (a === '未注明月份') return 1;
        if (b === '未注明月份') return -1;
        return b.localeCompare(a);
      });
      const activeMonth = months.includes(month) ? month : (months[0] || '');
      const filtered = pages.filter((page) => page.month === activeMonth);
      const current = filtered.find((page) => page.node.id === selectedId) || filtered[0] || null;
      const currentIndex = current ? pages.indexOf(current) : -1;
      const choose = (page) => {
        setMonth(page.month);
        setSelectedId(page.node.id);
        setCatalog(false);
      };
      const send = (nodeId) => {
        if (sending) return;
        setSending(true);
        setNotice('');
        Promise.resolve().then(() => onSendToChat(nodeId)).catch((error) => {
          setNotice('送进对话失败：' + (error && error.message ? error.message : error));
        }).finally(() => setSending(false));
      };
      React.useEffect(() => {
        if (!focusNode) return;
        const page = pages.find((entry) => entry.node.id === focusNode.nodeId);
        if (page) choose(page);
        onFocusShown(page ? 'centred' : 'unknown-node', focusNode.nodeId);
      }, [focusNode]);
      React.useEffect(() => {
        if (paperRef.current) paperRef.current.scrollTop = 0;
        setNotice('');
      }, [current && current.node.id]);
      // Pointer drag follows the existing canvas convention: dropping outside the reader adds an attachment.
      React.useEffect(() => {
        const move = (event) => {
          const start = dragRef.current;
          if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) return;
          start.moved = true;
          setDragLabel({ x: event.clientX, y: event.clientY, title: start.title });
        };
        const release = (event) => {
          const start = dragRef.current;
          dragRef.current = null;
          setDragLabel(null);
          const box = frameRef.current && frameRef.current.getBoundingClientRect();
          if (start && start.moved && box && (event.clientX < box.left || event.clientX > box.right
            || event.clientY < box.top || event.clientY > box.bottom)) send(start.id);
        };
        const cancel = () => { dragRef.current = null; setDragLabel(null); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', release);
        window.addEventListener('pointercancel', cancel);
        return () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', release);
          window.removeEventListener('pointercancel', cancel);
        };
      }, [onSendToChat, sending]);
      const buttonStyle = {
        border: '1px solid ' + HAIRLINE, background: 'transparent', color: 'inherit',
        borderRadius: 5, padding: '5px 9px', font: 'inherit', fontSize: 12, cursor: 'pointer',
      };
      const navButton = (label, page) => h('button', {
        type: 'button', disabled: !page, style: { ...buttonStyle, opacity: page ? 1 : 0.4 },
        onClick: () => { if (page) choose(page); },
      }, label);
      const author = current && current.node.by ? '写于当前会话' : null;
      return h('section', { ref: frameRef, className: 'kb-diary-book', 'aria-label': '日记本', 'data-kb-diary-book': base.id },
        h('style', null, `
          .kb-diary-book{--diary-paper:#fffdf7;--diary-ink:#343d4b;--diary-muted:#6a7380;--diary-rule:#dedbd2;--diary-side:#f2f3f4;color:var(--diary-ink);border:1px solid var(--diary-rule);border-radius:6px;overflow:hidden;container-type:inline-size}
          .kb-diary-book button:focus-visible,.kb-diary-book select:focus-visible,.kb-diary-book textarea:focus-visible{outline:2px solid #527eab;outline-offset:2px}
          .kb-diary-layout{display:grid;grid-template-columns:170px minmax(0,1fr);min-height:420px;height:clamp(420px,65vh,800px)}
          .kb-diary-catalog{overflow-y:auto;min-width:0;background:var(--diary-side);border-right:1px solid var(--diary-rule);padding:12px 10px}
          .kb-diary-paper{overflow-y:auto;min-width:0;background:var(--diary-paper);padding:30px clamp(20px,5cqw,54px);overscroll-behavior:contain}
          .kb-diary-prose{font-family:'Microsoft YaHei','PingFang SC',sans-serif;font-size:15px;line-height:2;overflow-wrap:anywhere;max-width:38em;margin:0 auto}
          .kb-diary-prose>div{margin:0 0 1em!important}.kb-diary-title{font-family:'Noto Serif CJK SC','SimSun',serif;font-size:25px;line-height:1.55;font-weight:600;margin:12px 0 26px;overflow-wrap:anywhere}
          .kb-diary-compact{display:none}
          @media(prefers-color-scheme:dark){.kb-diary-book{--diary-paper:#26282c;--diary-ink:#e0e1e3;--diary-muted:#a9adb5;--diary-rule:#47494e;--diary-side:#202226}}
          @container(max-width:600px){.kb-diary-layout{grid-template-columns:minmax(0,1fr)}.kb-diary-catalog{display:none;border-right:0}.kb-diary-compact{display:inline-flex}.kb-diary-layout[data-catalog="shown"] .kb-diary-catalog{display:block}.kb-diary-layout[data-catalog="shown"] .kb-diary-paper{display:none}}
        `),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid var(--diary-rule)', background: 'var(--diary-paper)' } },
          h('span', { style: { fontWeight: 600, flex: 1 } }, base.name || '日记'),
          h('span', { style: { color: 'var(--diary-muted)', fontSize: 12 } }, pages.length + ' 篇'),
          h('button', { type: 'button', className: 'kb-diary-compact', 'aria-expanded': catalog, onClick: () => setCatalog(!catalog), style: buttonStyle }, catalog ? '回到书页' : '目录'),
        ),
        h('div', { className: 'kb-diary-layout', 'data-catalog': catalog ? 'shown' : 'closed' },
          h('nav', { className: 'kb-diary-catalog', 'aria-label': '日记目录' },
            h('label', { style: { display: 'block', fontSize: 12, marginBottom: 12 } }, '按月翻阅',
              h('select', {
                'aria-label': '日记月份', value: activeMonth, disabled: !months.length,
                onChange: (event) => { setMonth(event.currentTarget.value); setSelectedId(null); },
                style: { width: '100%', marginTop: 7, padding: 6, font: 'inherit', color: 'inherit', background: 'var(--diary-paper)', border: '1px solid var(--diary-rule)', borderRadius: 4 },
              }, months.map((value) => h('option', { key: value, value }, value))),
            ),
            filtered.map((page) => h('button', {
              key: page.node.id, type: 'button', 'aria-current': current && current.node.id === page.node.id ? 'page' : undefined,
              onClick: () => choose(page),
              style: { width: '100%', padding: '11px 8px', marginBottom: 5, textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer', border: '1px solid ' + (current && current.node.id === page.node.id ? 'var(--diary-rule)' : 'transparent'), borderRadius: 4, background: current && current.node.id === page.node.id ? 'var(--diary-paper)' : 'transparent' },
            },
              h('div', { style: { fontSize: 11, color: 'var(--diary-muted)', marginBottom: 4 } }, page.writtenAt.slice(0, 10) || '日期未记录'),
              h('div', { style: { fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' } }, page.node.title || '未命名日记'),
              h('div', { style: { fontSize: 11, lineHeight: 1.6, color: 'var(--diary-muted)', marginTop: 5, overflowWrap: 'anywhere' } }, page.body.replace(/\s+/g, ' ').slice(0, 45)),
            )),
          ),
          h('article', { ref: paperRef, className: 'kb-diary-paper', tabIndex: 0, 'aria-label': current ? current.node.title : '空白日记' },
            current ? h('div', { style: { maxWidth: '38em', margin: '0 auto' } },
              h('div', { style: { color: 'var(--diary-muted)', fontSize: 12 } }, current.writtenAt.slice(0, 10) || '日期未记录'),
              h('h2', { className: 'kb-diary-title' }, current.node.title || '未命名日记'),
              h('div', { className: 'kb-diary-prose' }, renderMarkdown(current.body, 'diary-' + current.node.id)),
              author ? h('p', { style: { textAlign: 'right', color: 'var(--diary-muted)', fontSize: 13, marginTop: 24 } }, author) : null,
              current.hint ? h('details', { key: current.node.id, style: { borderTop: '1px solid var(--diary-rule)', paddingTop: 14, marginTop: 28, fontSize: 12, color: 'var(--diary-muted)' } },
                h('summary', { style: { cursor: 'pointer' } }, '回想提示'),
                h('p', { style: { lineHeight: 1.8, whiteSpace: 'pre-wrap' } }, current.hint),
              ) : null,
              h('div', { style: { display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 24 } },
                h('button', { type: 'button', disabled: sending, style: buttonStyle, onClick: () => send(current.node.id) }, sending ? '正在加入…' : '送进对话'),
                h('button', { type: 'button', style: buttonStyle, onPointerDown: (event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  dragRef.current = { id: current.node.id, title: current.node.title, x: event.clientX, y: event.clientY, moved: false };
                }, title: '按住拖出日记本，作为附件加入当前对话' }, '拖入对话'),
                h('button', { type: 'button', style: buttonStyle, onClick: () => onShowHistory(current.node.id) }, '修改记录'),
                current.node.change ? h('button', { type: 'button', style: buttonStyle, onClick: () => onReview(current.node.id) }, '标为已读') : null,
                h('button', { type: 'button', style: buttonStyle, onClick: () => { onLocate(current.node.id); onCanvas(); } }, '在画布中编辑'),
              ),
              h(DiaryReplies, { key: base.id + ':' + current.node.id, baseId: base.id, nodeId: current.node.id, onReplyAction, draftStore: replyDrafts }),
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 28, paddingTop: 16, borderTop: '1px solid var(--diary-rule)' } },
                navButton('← 较早一篇', pages[currentIndex + 1]),
                navButton('较新一篇 →', pages[currentIndex - 1]),
              ),
            ) : h('div', { style: { padding: '50px 0', lineHeight: 1.9 } },
              h('h2', { className: 'kb-diary-title' }, '还没有写下的日记'),
              h('p', { style: { fontSize: 14, color: 'var(--diary-muted)' } }, '打开日记模式，继续和角色聊天。交流中有值得留下的片段时，模型会选择写入。'),
            ),
            notice ? h('p', { role: 'alert', style: { color: '#b94444', fontSize: 12 } }, notice) : null,
          ),
        ),
        dragLabel ? h('div', { style: { position: 'fixed', pointerEvents: 'none', zIndex: 9999, left: dragLabel.x + 12, top: dragLabel.y + 12, maxWidth: 240, padding: '8px 12px', border: '1px solid var(--diary-rule)', background: 'var(--diary-paper)', color: 'var(--diary-ink)', borderRadius: 5, fontSize: 12 } }, '送进对话：' + dragLabel.title) : null,
      );
    }

    function DiaryOrTree(props) {
      const [view, setView] = React.useState('book');
      if (!/^diary(?:-[a-z0-9]+)?$/.test(props.base.id)) return h(Tree, props);
      return h('div', null,
        h('div', { style: { display: 'flex', gap: 6, padding: '8px 0' }, role: 'group', 'aria-label': '日记视图' },
          [['book', '日记本'], ['canvas', '知识画布']].map(([id, label]) => h('button', {
            key: id, type: 'button', 'aria-pressed': view === id, onClick: () => setView(id),
            style: { font: 'inherit', fontSize: 12, padding: '4px 10px', border: '1px solid ' + HAIRLINE, borderRadius: 5, color: 'inherit', background: view === id ? 'rgba(128,128,128,0.16)' : 'transparent', cursor: 'pointer' },
          }, label)),
        ),
        h('div', { style: { display: view === 'book' ? 'block' : 'none' } },
          h(DiaryBook, { base: props.base, onReplyAction: props.onReplyAction, onSendToChat: props.onSendToChat, onShowHistory: props.onShowHistory,
            onReview: props.onReview, onLocate: props.onLocate, focusNode: view === 'book' ? props.focusNode : null,
            onFocusShown: props.onFocusShown, names: props.names, onCanvas: () => setView('canvas') }),
        ),
        // Keep the graph mounted so a trip to the book does not discard pan/zoom or an editor draft.
        h('div', { style: { display: view === 'canvas' ? 'block' : 'none' } }, h(Tree, { ...props, focusNode: view === 'canvas' ? props.focusNode : null })),
      );
    }


    function Body({ sessionId, fullscreen }) {
      const [state, setState] = React.useState({ status: 'loading' });
      const [enabled, setEnabled] = React.useState({});
      // Which list the switches edit: the workspace default, or this session alone.
      //
      // It starts at the default and is corrected once per session below. It used to stay there always, so
      // a session that had its own switches still opened on the workspace list: you had to notice, and then
      // switch tabs by hand, before you could see what that conversation actually had on. The panel was
      // showing the question "what do new sessions get" while the reader was asking "what does this one
      // have".
      const [scope, setScope] = React.useState('default');
      // The session whose answer we have already settled. A ref rather than state on purpose: this is a
      // one-shot decision per session, and it must not re-run when the user picks a tab by hand.
      const scopeSettledFor = React.useRef(null);

      // Settle the tab once per session: a session that has its own switches opens on them.
      //
      // A session that was never given its own switches has no file, and that is not a failure — it means
      // "no opinion", and the workspace default stands. So the absence is read as `null` and ignored.
      React.useEffect(() => {
        if (!sessionId || scopeSettledFor.current === sessionId) return undefined;
        scopeSettledFor.current = sessionId;
        let cancelled = false;
        REMOTE.workspaceFiles.read(
          sessionId, DIR + '/.sessions/' + sessionFileName(sessionId) + '.json', {})
          .then((result) => JSON.parse(unwrap(result).text))
          .then((own) => {
            if (!cancelled && own && Array.isArray(own.enabled)) setScope('session');
          })
          .catch(() => { /* no list of its own: stay on the default */ });
        return () => { cancelled = true; };
      }, [sessionId]);
      // The query, the matches, and the node the canvas should centre on once it has been drawn.
      const [query, setQuery] = React.useState('');
      // What the user calls each session. Presentation only: it lives in layout.json and never reaches the
      // prompt, which is why it is not in the base files.
      const [names, setNames] = React.useState({});

      const [focusNode, setFocusNode] = React.useState(null);
      /**
       * The node whose edit history is on screen: `{ baseId, nodeId }`, or null for the normal panel.
       *
       * Body owns it rather than the canvas, because the history takes the whole panel — see `HistoryView`.
       * Right-clicking a node sets it; the view's back button clears it.
       */
      const [historyFor, setHistoryFor] = React.useState(null);
      const panelRef = React.useRef(null);
      const historyScroll = React.useRef(0);
      const showHistory = (baseId, nodeId) => {
        if (panelRef.current) {
          historyScroll.current = panelRef.current.scrollTop;
          panelRef.current.scrollTop = 0;
        }
        setHistoryFor({ baseId, nodeId });
      };
      // The outcome of the last locate request, shown so a request that lands nowhere is not silent.
      const [lastFocus, setLastFocus] = React.useState(null);
      // Whether this session has a list of its own. Only used to say so; absence means inherit, which is
      // how it behaves either way.
      const [hasOwnSelection, setHasOwnSelection] = React.useState(false);
      const [openId, setOpenId] = React.useState(null);
      // Bumped to re-read the files: the tools write to disk, and this panel has no way to be
      // told about it, so the user asks for the re-read.
      const [tick, setTick] = React.useState(0);
  // One assignment, because the renderer is a plain function: see `assetSession` near parseMarkdown.
  assetSession = sessionId;
      // A destructive action that is one stray click away is a bug in the affordance: the first click only arms it.
      const [revertArmed, setRevertArmed] = React.useState(false);
      // Links drawn by hand. Held here, not in the file: the client has no write path.
      const [drafts, setDrafts] = React.useState({});
      // Node bodies the user retyped, same story: shown at once, saved nowhere yet.
      const [edits, setEdits] = React.useState({});
      // Where the user dragged a node. Positions are otherwise derived from the structure, so
      // only the ones actually moved are remembered — a new node from the model still lands
      // somewhere sensible instead of on top of something.
      const [positions, setPositions] = React.useState({});
      const [collapsed, setCollapsed] = React.useState({});
      const collapseWrites = React.useRef(null);
      if (!collapseWrites.current || collapseWrites.current.session !== sessionId) {
        collapseWrites.current = { session: sessionId, values: {}, confirmed: {}, versions: {}, pending: {}, queue: Promise.resolve() };
      }
      // Per-node colours the user chose, keyed by base then node.
      const [colors, setColors] = React.useState({});
      const [nodeInjection, setNodeInjection] = React.useState({});
      const [injectionDefaults, setInjectionDefaults] = React.useState({});
      // Which arrangement each base uses. Presentation, stored with the positions and the colours.
      const [shapes, setShapes] = React.useState({});
      // Box widths. The base's is the room every node in it gets; a node's own overrides it. Kept apart
      // because they answer different questions: "make this base wider" and "this node needs more room".
      const [widths, setWidths] = React.useState({});
      const [nodeWidths, setNodeWidths] = React.useState({});
      // null while idle, the string 'saving' in flight, or { error } when the host refused.
      const [saving, setSaving] = React.useState(null);
      // Row-level operations: which base's menu is open, which one is being renamed inline, and
      // which one is waiting for a delete confirmation. Kept here rather than in the row so only
      // one can ever be open.
      const [menuFor, setMenuFor] = React.useState(null);
      // A held row is being dragged to a new position. The order is written on drop, so a drag that
      // ends where it started costs nothing.
      const [dragging, setDragging] = React.useState(null);
      const holdTimer = React.useRef(null);
      // The drop handler closes over one render's data; the ref keeps it writing the arrangement as
      // it is at that moment rather than as it was when the drag began.
      const orderRef = React.useRef([]);
      orderRef.current = state.status === 'live' ? state.bases.map((base) => base.id) : orderRef.current;
      const [renamingId, setRenamingId] = React.useState(null);
      const [confirmingId, setConfirmingId] = React.useState(null);

      /**
       * Send one change to the host.
       *
       * A failed save is shown rather than swallowed: the panel shows what is really in the
       * file, so pretending a write succeeded would make the whole thing untrustworthy.
       */
      const post = React.useCallback(async (action, body, quiet) => {
        if (!quiet) setSaving('saving');
        try {
          const response = await fetch(PREFIX + '/' + action, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId, ...body }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload.ok) {
            throw new Error(payload.error || ('HTTP ' + response.status));
          }
          if (!quiet) setSaving(null);
          return payload;
        } catch (error) {
          // Which session this was, and what the host said: without the id a failed write names nothing.
      const which = typeof sessionId === 'string' && sessionId ? sessionId.slice(0, 12) : '(none)';
      if (!quiet) setSaving({ error: String((error && error.message) || error) + ' ｜ 会话 ' + which });
          throw error;
        }
      }, [sessionId]);

      /** Ask the user for a name, and take the host's answer as the truth. */
      const changeCollapsed = (base, operation) => {
        const held = collapseWrites.current;
        const id = base.id;
        const version = (held.versions[id] || 0) + 1;
        held.versions[id] = version;
        held.pending[id] = (held.pending[id] || 0) + 1;
        const next = applyCollapse(subtreeIndex(base.nodes || []), held.values[id], operation);
        held.values = { ...held.values, [id]: next };
        setCollapsed(held.values);
        held.queue = held.queue.catch(() => {}).then(() => post('collapse', { base: id, ...operation })).then((result) => {
          held.pending[id] -= 1;
          held.confirmed[id] = result.collapsed;
          if (collapseWrites.current === held && held.versions[id] === version) {
            held.values = { ...held.values, [id]: result.collapsed };
            setCollapsed(held.values);
          }
        }, () => {
          held.pending[id] -= 1;
          if (collapseWrites.current === held && held.versions[id] === version) {
            held.values = { ...held.values, [id]: held.confirmed[id] || [] };
            setCollapsed(held.values);
          }
        });
      };

      const renameSession = React.useCallback((sessionId) => {
        const current = names[sessionId] || '';
        const wanted = window.prompt('给这个会话起个名字（留空就是不起名）', current);
        if (wanted === null) return;
        post('name', { session: sessionId, target: sessionId, name: wanted }).then((result) => {
          setNames(result.names || {});
        }).catch(() => {
          // The note in the header shows the refusal; nothing else to do.
        });
      }, [names, post]);

      /**
       * Mirror one node's new state into the loaded copy.
       *
       * Used instead of refetching after a save, so the tree does not jump while the user is
       * working in it. `change: undefined` is how a cleared review marker is represented: the
       * panel treats a missing `change` as no marker, which is what the file will hold too.
       */
      const patchNodeLocally = React.useCallback((baseId, nodeId, patch) => {
        setState((current) => {
          if (!current.bases) return current;
          return {
            ...current,
            bases: current.bases.map((entry) => (entry.id !== baseId ? entry : {
              ...entry,
              nodes: (entry.nodes || []).map((node) => (
                node.id !== nodeId ? node : { ...node, ...patch }
              )),
            })),
          };
        });
      }, []);

      const pending = drafts[openId] || [];

      /** Undo the last hand-drawn link. It is already in the file, so this deletes it there. */
      const undoLast = React.useCallback(() => {
        const list = drafts[openId] || [];
        if (!list.length) return;
        const last = list[list.length - 1];
        setDrafts((current) => ({ ...current, [openId]: (list || []).slice(0, -1) }));
        post('changes', {
          base: openId,
          removeLinks: [{ from: last.from, to: last.to }],
        }).catch(() => {
          // Put it back, so the panel keeps matching the file when the delete was refused.
          setDrafts((current) => ({ ...current, [openId]: (current[openId] || []).concat([last]) }));
        });
      }, [drafts, openId, post]);

      /** Flip one base's switch and persist it; the switch must never show a state the host refused. */
      /** Every node matching the query, searched in memory. */
      const matches = React.useMemo(() => searchBases(state.bases, query), [state.bases, query]);

      /** One label and colour per session, assigned across every base. */
      const labels = React.useMemo(() => sessionLabels(state.bases, names), [state.bases, names]);

      const toggleBase = React.useCallback((baseId, next) => {
        const updated = { ...enabled, [baseId]: next };
        setEnabled(updated);
        const wanted = (state.bases || []).filter((base) => updated[base.id]).map((base) => base.id);
        // Both always: the session id is how the host resolves the workspace, and the scope decides which
        // list to write. Withholding the id in default scope broke every switch — the request failed and
        // the optimistic update was rolled back, so nothing appeared to happen.
        post('selection', {
          enabled: wanted,
          session: sessionId,
          scope: scope === 'session' ? 'session' : 'workspace',
        }).catch(() => {
          setEnabled((current) => ({ ...current, [baseId]: !next }));
        });
      }, [enabled, state.bases, post, scope, sessionId]);

      /** Update one base's own fields in the loaded copy, rather than refetching. */
      const patchBaseLocally = React.useCallback((baseId, patch) => {
        setState((current) => {
          if (!current.bases) return current;
          return {
            ...current,
            bases: current.bases.map((entry) => (entry.id === baseId ? { ...entry, ...patch } : entry)),
          };
        });
      }, []);

      /** Save a new display name. An empty or unchanged value just closes the editor. */
      /** The nodes the model touched that the user has not acknowledged yet. */
      const unreviewedIn = (base) => (base.nodes || [])
        .filter((node) => node.change)
        .map((node) => node.id);

      // Where the unread walk has got to: a flat list of (base, node) in reading order, plus a
      // position. Flat rather than nested because the walk crosses bases, which is the whole point —
      // the user should not have to know which base holds the next unreviewed node.
      // True while the unread walk is running. No position is stored: the trail is rebuilt and the
      // next node derived on every press, so there is nothing to keep in step.
      const [walk, setWalk] = React.useState(false);
      const [focus, setFocus] = React.useState(null);

      /** Every unreviewed node, in the order the panel shows them. */
      const unreadTrail = () => {
        if (state.status !== 'live') return [];
        const trail = [];
        state.bases.forEach((base) => {
          (base.nodes || []).forEach((node) => {
            if (node.change) trail.push({ base: base.id, node: node.id });
          });
        });
        return trail;
      };

      /**
       * Move to the next unreviewed node.
       *
       * The list is rebuilt on every press rather than remembered, because the walk and the model can
       * both change it underneath: accepting a node removes it, and the model can add more while the
       * user is still walking. Rebuilding means the trail is always what is actually left.
       */
      const stepUnread = () => {
        const trail = unreadTrail();
        const current = focus ? focus.node : null;
        const target = nextUnread(trail, current);
        if (!target) {
          setWalk(null);
          setFocus(null);
          return;
        }
        setWalk(true);
        setOpenId(target.base);
        setFocus({ base: target.base, node: target.node });
        // Looking at a node is acknowledging it — the same thing the tick in its corner does.
        patchNodeLocally(target.base, target.node, { change: undefined });
        post('changes', { base: target.base, review: [target.node] }).catch(() => {});
      };

      /** Stop walking without changing anything that was already acknowledged. */
      const stopWalking = () => {
        setWalk(null);
        setFocus(null);
      };

      /** Accept a whole base at once. One button instead of one tick per node. */
      const reviewBase = (base) => {
        const ids = unreviewedIn(base);
        if (ids.length === 0) return;
        ids.forEach((id) => patchNodeLocally(base.id, id, { change: undefined }));
        post('changes', { base: base.id, review: ids }).catch(() => {});
      };

      /** Accept every base that has anything waiting. */
      const reviewEverything = () => {
        if (state.status !== 'live') return;
        state.bases.forEach((base) => reviewBase(base));
      };

      const totalUnreviewed = () => (state.status === 'live'
        ? state.bases.reduce((sum, base) => sum + unreviewedIn(base).length, 0)
        : 0);

      /**
       * Forget where this base's nodes were dragged to, so the layout arranges them again.
       *
       * A remembered position beats the layout, which is right while the user is arranging things
       * by hand and wrong once they have made a mess of it. Clearing is the only way back: the
       * layout cannot tell a deliberate position from a leftover one.
       */
      const resetArrangement = (base) => {
        if (Object.keys(positions[base.id] || {}).length === 0) return;
        setPositions((current) => Object.assign({}, current, { [base.id]: {} }));
        post('layout', { base: base.id, positions: {} }).catch(() => {});
      };

      /**
       * Switch a base's arrangement.
       *
       * The dragged positions are cleared as part of this, and the button says so. A template that
       * leaves every node where the user dragged it is indistinguishable from a broken button, and
       * the point of choosing one is to stop arranging by hand.
       */
      const chooseShape = (base, shape) => {
        setShapes((current) => Object.assign({}, current, { [base.id]: shape }));
        setPositions((current) => Object.assign({}, current, { [base.id]: {} }));
        post('shape', { base: base.id, shape }).catch(() => {});
        post('layout', { base: base.id, positions: {} }).catch(() => {});
      };

      const commitRename = React.useCallback((base, value) => {
        setRenamingId(null);
        const name = String(value == null ? '' : value).trim();
        if (!name || name === base.name) return;
        patchBaseLocally(base.id, { name });
        post('rename', { base: base.id, name }).catch(() => {
          // Put the old name back, so the row never shows a name the file does not have.
          patchBaseLocally(base.id, { name: base.name });
        });
      }, [post, patchBaseLocally]);

      /** Remove a base. The file is parked rather than deleted, so no modal is needed. */
      const confirmRemove = React.useCallback((base) => {
        setConfirmingId(null);
        post('remove', { base: base.id }).then(() => {
          setState((current) => {
            if (!current.bases) return current;
            return { ...current, bases: current.bases.filter((entry) => entry.id !== base.id) };
          });
          setEnabled((current) => ({ ...current, [base.id]: false }));
          setOpenId((current) => (current === base.id ? null : current));
        }).catch(() => {});
      }, [post]);

      // While a row is held, reorder live — but always from the order the drag started with.
      //
      // The target comes from rectangles captured at the hold, so it does not depend on where the rows
      // happen to be this frame. The new order is then rebuilt from those same captured ids rather than
      // from the current list, which makes it the same answer every time the pointer reports the same
      // position. Deriving it from the live list instead is what made the row flicker between two slots.
      React.useEffect(() => {
        if (!dragging) return undefined;
        const move = (event) => {
          const y = event.clientY;
          const rows = dragging.rows;
          if (rows.length === 0) return;
          let at = rows.length;
          for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index];
            if (y < row.top + (row.bottom - row.top) / 2) {
              at = index;
              break;
            }
          }
          const origin = rows.map((row) => row.id);
          const next = origin.filter((id) => id !== dragging.id);
          next.splice(at, 0, dragging.id);
          // Lift the held row out of its slot so it sits under the pointer instead of staying put.
          // The transform is cleared before the position is read: the row is reordered as the pointer
          // moves, so its layout top changes, and measuring through the previous transform would fold
          // that difference into a drift. `grabOffset` is where inside the row the press landed, which
          // is what keeps the row from snapping so the pointer sits at its top edge.
          const card = dragging.group
            ? dragging.group.querySelector('[data-kb-card="' + dragging.id + '"]')
            : null;
          if (card) {
            card.style.transition = 'none';
            card.style.position = 'relative';
            card.style.zIndex = '30';
            card.style.boxShadow = '0 8px 24px rgba(0,0,0,0.22)';
            card.style.transform = '';
            const wantTop = event.clientY - dragging.grabOffset;
            const layoutTop = card.getBoundingClientRect().top;
            card.style.transform = 'translateY(' + Math.round(wantTop - layoutTop) + 'px)';
          }
          setState((current) => {
            if (current.status !== 'live') return current;
            if (current.bases.map((base) => base.id).join() === next.join()) return current;
            const byId = new Map(current.bases.map((base) => [base.id, base]));
            return { ...current, bases: next.map((id) => byId.get(id)).filter(Boolean) };
          });
        };
        const drop = () => {
          // Settle the row into its final slot instead of snapping: the same element that was floating
          // becomes an ordinary row again, and the transition covers the difference.
          if (dragging.group) {
            const card = dragging.group.querySelector('[data-kb-card="' + dragging.id + '"]');
            if (card) {
              card.style.transition = 'transform 180ms cubic-bezier(.22,1,.36,1), box-shadow 180ms';
              card.style.transform = '';
              card.style.boxShadow = '';
              card.style.zIndex = '';
              window.setTimeout(() => {
                card.style.transition = '';
                card.style.position = '';
              }, 200);
            }
          }
          setDragging(null);
          if (orderRef.current.length > 1) post('order', { order: orderRef.current }).catch(() => {});
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', drop);
        window.addEventListener('pointercancel', drop);
        return () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', drop);
          window.removeEventListener('pointercancel', drop);
        };
      }, [dragging]);

      // FLIP: after the list reorders, put each moved row back where it was with a transform and let it
      // travel. The rectangles from the hold are the "before", so nothing has to be measured twice.
      React.useLayoutEffect(() => {
        if (!dragging) return;
        const group = dragging.group;
        if (!group) return;
        const before = new Map(dragging.rows.map((row) => [row.id, row.top]));
        group.querySelectorAll('[data-kb-card]').forEach((card) => {
          const id = card.getAttribute('data-kb-card');
          const was = before.get(id);
          if (was === undefined || id === dragging.id) return;
          const now = card.getBoundingClientRect().top;
          const delta = was - now;
          if (Math.abs(delta) < 1) return;
          card.style.transition = 'none';
          card.style.transform = 'translateY(' + delta + 'px)';
          // Next frame, release it: the transition carries it to zero, which is its new slot.
          requestAnimationFrame(() => {
            card.style.transition = 'transform 180ms cubic-bezier(.22,1,.36,1)';
            card.style.transform = '';
          });
        });
      });



      // Close the row menu on an outside press or Escape. The press is ignored when it lands
      // inside the menu itself — closing on pointerdown would unmount the item before its click
      // could fire, and the menu would look like it does nothing.
      React.useEffect(() => {
        if (!menuFor) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (target && target.closest && target.closest('[data-kb-menu]')) return;
          setMenuFor(null);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setMenuFor(null);
        };
        window.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('keydown', onKey);
        return () => {
          window.removeEventListener('pointerdown', onPointerDown);
          window.removeEventListener('keydown', onKey);
        };
      }, [menuFor]);

      // Ctrl+Z, but only while there is something of ours to undo and the focus is not in a
      // text field — otherwise this would steal the composer's own undo.
      React.useEffect(() => {
        if (!pending.length) return undefined;
        const onKey = (event) => {
          if (!(event.ctrlKey || event.metaKey) || String(event.key).toLowerCase() !== 'z') return;
          const active = document.activeElement;
          if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA'
            || active.isContentEditable)) return;
          event.preventDefault();
          undoLast();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [pending.length, undoLast]);

      // Auto-refresh. The model writes the files, and the whole point of the panel is seeing
      // what it wrote — needing to click 刷新 for that would leave the feature half working.
      // The events are coalesced because one model turn can touch several files.
      React.useEffect(() => {
        if (!REMOTE || !sessionId || !REMOTE.workspaceFiles.changes) return undefined;
        const controller = new AbortController();
        let timer = null;
        let lastVersion = null;
        (async () => {
          try {
            const frames = REMOTE.workspaceFiles.changes(sessionId, DIR, controller.signal);
            for await (const frame of frames) {
              if (!frame || frame.kind !== 'changed') continue;
              if (frame.version !== undefined && frame.version === lastVersion) continue;
              lastVersion = frame.version === undefined ? null : frame.version;
              clearTimeout(timer);
              timer = setTimeout(() => setTick((value) => value + 1), 250);
            }
          } catch {
            // The feed ends when the panel unmounts, and a broken feed must not break the
            // panel: the manual 刷新 button still works.
          }
        })();
        return () => {
          clearTimeout(timer);
          controller.abort();
        };
      }, [sessionId]);

      // A ref, not state: the list effect below needs the diary flag, `activity` is declared further down, and an
      // effect's dependency has to be declared above it. The poll updates this and bumps `tick` when it changes, so the
      // list rebuilds exactly once per flip.
      const activityRef = React.useRef(null)

      React.useEffect(() => {
        if (!REMOTE || !sessionId) {
          setState({ status: 'failed', message: '未拿到 remote 或 sessionId' });
          return undefined;
        }
        const controller = new AbortController();
        (async () => {
          try {
            const listing = unwrap(await REMOTE.workspaceFiles.list(sessionId, DIR, controller.signal));
            // The diary belongs to the conversation keeping it. This list is built from the files on disk, so the rule has to
            // be applied here — the host-side filter in readPanelState is not on this path at all.
            // Which diary is this conversation's own: the name comes back with the activity poll, because the panel builds
          // this list from the files on disk and has no other way to know it.
          const keepDiaryBase = activityRef.current && activityRef.current.diary ? activityRef.current.diaryBase : null
            const names = (listing.entries || [])
              .filter((entry) => entry.type === 'file' && entry.name.endsWith('.json'))
              .map((entry) => entry.name);
            const bases = [];
            let selection = { enabled: [] };
            let ownsSelection = false;
            let layout = {};
            for (const name of names) {
              const file = unwrap(await REMOTE.workspaceFiles.read(
                sessionId, DIR + '/' + name, {}, controller.signal));
              const parsed = JSON.parse(file.text);
              if (name === 'selection.json') selection = parsed;
              else if (name === 'layout.json') layout = parsed;
              else if (parsed && parsed.sealed) {
                // A sealed file has no nodes to draw. Only this conversation's own diary is worth asking the host for; the others
                // stay unreadable here, which is the point of sealing them.
                if (parsed.baseId && parsed.baseId === keepDiaryBase) {
                  const answer = await post('diary-get', { id: parsed.baseId }).catch(() => null);
                  if (answer && answer.base) bases.push(answer.base);
                }
              }
              // The diary belongs to the conversation keeping it, so it is filtered here — the panel builds this list from the
              // files on disk, which means the host-side filter in readPanelState never ran on this path.
              else if (!parsed.id.startsWith('diary-') || parsed.id === keepDiaryBase) bases.push(parsed);
            }
            // The user's arrangement wins over the default id order, so dragging the most important
            // base to the top is a real change. Anything they have not placed keeps its id order,
            // and the id comparison breaks ties so the default stays stable.
            const savedOrder = Array.isArray(selection.order) ? selection.order : [];
            const rank = new Map(savedOrder.map((id, index) => [id, index]));
            const place = (base) => (rank.has(base.id) ? rank.get(base.id) : Number.MAX_SAFE_INTEGER);
            bases.sort((a, b) => {
              const left = place(a);
              const right = place(b);
              if (left !== right) return left - right;
              return String(a.id).localeCompare(String(b.id));
            });
            const policyResponse = await fetch(PREFIX + '/state?session=' + encodeURIComponent(sessionId), { signal: controller.signal });
            const policy = await policyResponse.json();
            if (!policyResponse.ok || !policy.ok) throw new Error(policy.error || '读取注入设置失败');
            setNodeInjection(policy.nodeInject || {});
            setInjectionDefaults(policy.inject || {});
            setState({ status: 'live', bases, count: names.length });
            // The session's own list, when it has one. Most sessions do not: a session that has never been
            // given its own switches has no file, and that is not a failure — it means "no opinion", and the
            // workspace default stands.
            //
            // `.then(onOk, onErr)` does not say that. Its second argument catches a rejection from *before*
            // it, not a throw from inside onOk — and a missing file throws inside onOk, because `unwrap`
            // raises on the error result. So the absence escaped to the outer catch and the panel announced
            // "读不到知识库" for a file it was never entitled to.
            if (scope === 'session' && sessionId) {
              const own = await REMOTE.workspaceFiles.read(
                sessionId, DIR + '/.sessions/' + sessionFileName(sessionId) + '.json', {}, controller.signal)
                .then((result) => JSON.parse(unwrap(result).text))
                .catch(() => null);
              if (own && Array.isArray(own.enabled)) {
                selection = own;
                ownsSelection = true;
              }
            }
            const on = {};
            bases.forEach((base) => { on[base.id] = (selection.enabled || []).includes(base.id); });
            setEnabled(on);
            setHasOwnSelection(ownsSelection);
            setPositions((layout && layout.positions) || {});
            const held = collapseWrites.current;
            const restored = { ...((layout && layout.collapsed) || {}) };
            const confirmed = { ...restored };
            for (const [id, pending] of Object.entries(held.pending)) {
              if (pending > 0) { restored[id] = held.values[id]; confirmed[id] = held.confirmed[id] || []; }
            }
            held.values = restored; held.confirmed = confirmed;
            setCollapsed(restored);
            setColors((layout && layout.colors) || {});
            setShapes((layout && layout.shapes) || {});
            setWidths((layout && layout.widths) || {});
            setNodeWidths((layout && layout.sizes) || {});
            setNames((layout && layout.names) || {});
            // Nothing is opened here on purpose. The line that used to be here kept whichever base was
            // already open — which is right, a refresh after a save must not yank the reader elsewhere —
            // and then, when none was open, opened the first enabled one. That second half meant every new
            // session began with a base chosen by me, and closing it was the first thing to do.
            //
            // `openId` keeps its value across a reload on its own: it is component state, and a save
            // re-renders rather than remounting. So there is nothing to restore.
          } catch (error) {
            setState({ status: 'failed', message: String((error && error.message) || error) });
          }
        })();
        return () => controller.abort();
      }, [sessionId, tick, scope]);

      // What the model has been doing in this workspace, for the header line.
      //
      // Polled rather than pushed because the host has no channel to the panel for this: the tools write a file and the
      // panel reads it back. One and a half seconds is set against the cost of that file read, not against how fast the
      // panel could redraw.
      const [activity, setActivity] = React.useState(null);
      React.useEffect(() => {
        if (!sessionId) return undefined;
        let cancelled = false;
        const tick = () => {
          post('activity', { session: sessionId, limit: 1 }, true).then((result) => {
            if (cancelled || !result) return;
            const diaryNow = result.diary === true;
            if (Boolean(activityRef.current && activityRef.current.diary) !== diaryNow) setTick((current) => current + 1);
            activityRef.current = { live: result.live === true, diary: diaryNow, diaryBase: result.diaryBase || null };
            setActivity({ live: result.live === true, diary: diaryNow, entry: (result.entries || [])[0] || null });
          }, () => { /* a panel that cannot read the log shows no line, rather than an error */ });
        };
        tick();
        const timer = setInterval(tick, 1500);
        return () => { cancelled = true; clearInterval(timer); };
      }, [sessionId]);

      if (state.status === 'loading') {
        return h('div', { style: { padding: '14px 16px', fontSize: 12, opacity: 0.6 } }, '读取中…');
      }
      if (state.status === 'failed') {
        return h('div', { style: { padding: '14px 16px', font: 'inherit', color: 'inherit' } },
          h('div', { style: { fontSize: 13, fontWeight: 600, color: '#c0392b' } }, '读不到知识库'),
          h('div', { style: { marginTop: 6, fontSize: 11.5, opacity: 0.75, lineHeight: 1.6, wordBreak: 'break-word' } },
            state.message),
          h(Note, null, '期望位置：' + DIR + '/ 下的 *.json（相对会话工作区）'),
        );
      }


      const bases = state.bases;
      // The header line, and the frame that goes with it. Nothing at all when the switch is off: a permanently
      // cheerful whale over a workspace that never asked for one is furniture, and the user turned this on to watch
      // the model work.
      const activityLine = !activity || !activity.live ? null : (() => {
        const entry = activity.entry;
        if (!entry) return { state: 'idle', text: '模型还没用过这个工作区的知识库' };
        const what = entry.what || '';
        if (entry.took === 'running') {
          return { state: 'working', text: '正在 ' + entry.tool + (what ? ' · ' + what : ''), title: entry.at };
        }
        if (/FAILED/.test(entry.took)) {
          return { state: 'failed', text: '刚才失败了一次' + (what ? ' · ' + what : ''), title: entry.took };
        }
        const reading = entry.tool === 'knowledge_read';
        // Five minutes, not eight seconds. The line is an indicator, not a notification: it should keep saying what
        // the model last did until it does something else, and shortening it to a moment the reader has to catch
        // defeats the point of having it at all. Only a long gap — long enough that "last did" would be stale —
        // returns it to idling.
        const at = Date.parse(String(entry.at || '').replace(' ', 'T'));
        const fresh = Number.isFinite(at) && Date.now() - at < 5 * 60 * 1000;
        if (!fresh) return { state: 'idle', text: '闲着', title: entry.at + ' · ' + entry.tool };
        return {
          state: reading ? 'thinking' : 'happy',
          text: (reading ? '刚读了 ' : '刚写了 ') + (what || '一个库'),
          title: entry.at + ' · ' + entry.tool,
        };
      })();

      const open = bases.find((base) => base.id === openId);

      /**
       * The history, when it is open, as a layer over the panel rather than a replacement for it.
       *
       * It was an early `return` first, and that quietly destroyed the canvas: unmounting the list unmounts every
       * `Tree`, and each `Tree` holds its own pan and zoom. Coming back therefore landed on the default view —
       * the position the canvas has when it is first opened — which is what "位置直接重置" was. Nothing about the
       * history needs the canvas gone; it only needs to be on top of it.
       *
       * Keeping the list mounted also keeps the accordion's open state and each canvas's scroll, and it leaves
       * the node measurements valid: hiding a subtree with `display: none` would make every box measure zero, and
       * the sizes feed the layout and the edge routing.
       *
       * It also means no wheel conflict to reason about. The canvas binds `wheel` to its own element, and this
       * layer is its sibling, so a wheel here never reaches that listener.
       */
      const historyLayer = (() => {
        if (!historyFor) return null;
        const owner = bases.find((base) => base.id === historyFor.baseId) || null;
        const target = owner
          ? (owner.nodes || []).find((item) => item.id === historyFor.nodeId) || null
          : null;
        return h(HistoryView, {
          baseId: historyFor.baseId,
          baseName: owner ? owner.name : null,
          node: target,
          nodeId: historyFor.nodeId,
          names,
          onBack: () => {
            setHistoryFor(null);
            requestAnimationFrame(() => {
              if (panelRef.current) panelRef.current.scrollTop = historyScroll.current;
            });
          },
        });
      })();

      return h('div', {
        ref: panelRef,
        style: {
          height: '100%',
          boxSizing: 'border-box',
          // A positioning context for the history layer, which covers the panel rather than replacing it.
          position: 'relative',
          // A column so the canvas can take the leftover height instead of a fixed box floating
          // in empty space.
          display: 'flex',
          flexDirection: 'column',
          overflow: historyFor ? 'hidden' : 'auto',
          padding: '14px 16px 22px',
          font: 'inherit',
          color: 'inherit',
        },
      },
        h('div', {
          // center, not aseline: a 48 px whale sharing a baseline with 13.5 px text sits above the text instead of beside it.
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
        },
          activityLine ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
            // The keyframes are defined once, here, next to the only element that uses them.
            h('style', { key: 'kb-whale' }, WHALE_CSS),
            h(Whale, { state: activityLine.state, size: 72 }),
          ) : null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '1 1 auto' } },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: { fontSize: 13.5, fontWeight: 600, letterSpacing: 0.2 } }, '知识库'),
              // Wraps rather than truncates: a write record names the node it touched, and that name is the
              // informative half.
              activityLine ? h('div', {
                title: activityLine.title,
                style: { fontSize: 10.5, opacity: 0.6, lineHeight: 1.35, overflow: 'hidden', maxWidth: 208 },
              }, activityLine.text) : null,
            ),
          ),
          totalUnreviewed() > 0 ? h('button', {
            type: 'button',
            title: '把所有知识库里模型改过的节点全部标为已读',
            onClick: reviewEverything,
            style: {
              padding: '1px 7px',
              border: '1px solid ' + HAIRLINE,
              borderRadius: 6,
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer',
            },
          }, '全部已读 ' + totalUnreviewed()) : null,
          totalUnreviewed() > 0 ? h('button', {
            type: 'button',
            title: '跳到下一个还没读的节点（会展开它所在的库并把它移到画面中间）',
            onClick: stepUnread,
            style: {
              padding: '1px 7px',
              border: '1px solid ' + HAIRLINE,
              borderRadius: 6,
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer',
            },
          }, walk ? '下一个 ›  还剩 ' + totalUnreviewed() : '看未读 ' + totalUnreviewed()) : null,
          // Last, and two-step. It undoes every unreviewed change in the workspace — the blunt tool — so it does not sit
          // between the two read buttons, and it does not fire on the first click.
          totalUnreviewed() > 0 ? h('button', {
            type: 'button',
            'data-kb-revert': revertArmed ? 'armed' : 'idle',
            onClick: () => {
              if (!revertArmed) {
                setRevertArmed(true);
                window.setTimeout(() => setRevertArmed(false), 4000);
                return;
              }
              setRevertArmed(false);
              post('revert', {}).then(() => setTick((current) => current + 1)).catch(() => {});
            },
            title: revertArmed ? '再点一次就真的撤回了' : '把还没看过的改动全部撤回：新增的删掉、改过的回到上一版、标记移除的恢复',
            style: {
              padding: '2px 8px',
              border: '1px solid ' + (revertArmed ? '#c0392b' : HAIRLINE),
              borderRadius: 7,
              background: revertArmed ? 'rgba(192,57,43,0.10)' : 'transparent',
              color: revertArmed ? '#c0392b' : 'inherit',
              font: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer',
            },
          }, (revertArmed ? '确定撤回 ' : '撤销改动 ') + totalUnreviewed()) : null,
          // Only while walking: a way out that is always there would be a control with nothing to do.
          walk ? h('button', {
            type: 'button',
            title: '退出未读模式，已经标为已读的保持已读',
            onClick: stopWalking,
            style: {
              padding: '1px 7px',
              border: '1px solid ' + HAIRLINE,
              borderRadius: 6,
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer',
            },
          }, '退出') : null,
          h('button', {
            type: 'button',
            onClick: () => setTick((value) => value + 1),
            title: '重新读取文件',
            style: {
              padding: '1px 8px',
              border: '1px solid ' + HAIRLINE,
              borderRadius: 7,
              background: 'transparent',
              color: 'inherit',
              font: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer',
              opacity: 0.8,
            },
          }, '刷新'),
        ),
        h('div', { style: { marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' } },
          h('input', {
            type: 'search',
            value: query,
            'aria-label': '搜索所有知识库',
            placeholder: '搜索标题和正文…',
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') { event.preventDefault(); setQuery(''); }
            },
            style: Object.assign({}, INPUT_STYLE, { flex: 1, minWidth: 0 }),
          }),
          query ? h('button', {
            type: 'button',
            title: '清空搜索',
            onClick: () => setQuery(''),
            style: {
              padding: '2px 8px', border: '1px solid ' + HAIRLINE, borderRadius: 6,
              background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 11.5,
              cursor: 'pointer', opacity: 0.7,
            },
          }, '清空') : null,
        ),
        lastFocus ? h('div', { style: { marginTop: 4, fontSize: 11, opacity: 0.6 } },
          '定位：' + lastFocus) : null,

        // While there is a query the list is the results. Showing both would put the answer somewhere
        // below the thing it answers about.
        query.trim()
          ? h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 } },
            h('div', { style: { fontSize: 11.5, opacity: 0.55 } },
              matches.length === 0 ? '没有匹配的节点。' : matches.length + ' 个匹配的节点'),
            matches.map((hit) => h('button', {
              key: hit.baseId + '/' + hit.nodeId,
              type: 'button',
              onClick: () => {
                setOpenId(hit.baseId);
                setFocusNode({ nodeId: hit.nodeId, at: Date.now() });
              },
              style: {
                textAlign: 'left', padding: '7px 9px', borderRadius: 8, font: 'inherit',
                border: '1px solid ' + HAIRLINE, background: SURFACE, color: 'inherit',
                cursor: 'pointer', display: 'block', width: '100%',
              },
            },
              h('div', { style: { fontSize: 12.5, fontWeight: 600, marginBottom: 2 } }, hit.title || hit.nodeId),
              h('div', { style: { fontSize: 11, opacity: 0.55 } },
                hit.baseName + (hit.inTitle ? ' · 标题命中' : '')),
              hit.snippet
                ? h('div', {
                  style: {
                    marginTop: 3, fontSize: 11, opacity: 0.7, lineHeight: 1.45,
                    overflowWrap: 'anywhere', wordBreak: 'break-word',
                  },
                }, hit.snippet)
                : null,
            )),
          )
          : null,

        h('div', { style: { marginTop: 2, fontSize: 11.5, opacity: 0.5 } },
          bases.length + ' 份，读自 ' + DIR + '/ · 文件和模型改动会自动出现'),

        // Whose list the switches below are editing. Without this the switches would silently write the
        // session's list and never the default, which is a change nobody could see.
        // The diary, on its own line and labelled with who it applies to. It is written per conversation, so it
        // cannot sit inside a row whose selector is about base lists — that read as "开关作用于 写日记".
        // 日记模式。A track-and-knob rather than a text button: the label names the feature and the switch says
        // whether it is on, which is what the previous version failed to convey — it repeated "写日记" twice, in the
        // muted palette, and looked like part of the description.
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 } },
          h('span', { style: { fontSize: 12 } }, '日记模式'),
          h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': Boolean(activity && activity.diary),
            'data-kb-diary': activity && activity.diary ? 'on' : 'off',
            title: (activity && activity.diary)
              ? '这个会话正在写日记。点一下关掉。'
              : '让这个会话在交流告一段落时写一篇日记（只对这个会话生效）',
            onClick: () => {
              const next = !(activity && activity.diary);
              post('diary', { session: sessionId, on: next }).then(
                (result) => setActivity((current) => ({
                  live: Boolean(current && current.live),
                  diary: Boolean(result && result.diary),
                  entry: current ? current.entry : null,
                })),
                () => { /* a refused switch stays as it was */ },
              );
            },
            style: {
              position: 'relative', width: 34, height: 18, padding: 0, borderRadius: 999,
              border: '1px solid ' + HAIRLINE, cursor: 'pointer',
              background: activity && activity.diary ? 'rgba(201,118,27,0.85)' : 'rgba(128,128,128,0.28)',
              transition: 'background 120ms ease',
            },
          }, h('span', {
            style: {
              position: 'absolute', top: 2, left: activity && activity.diary ? 18 : 2,
              width: 12, height: 12, borderRadius: 999, background: 'Canvas',
              transition: 'left 120ms ease',
            },
          })),
          h('span', { style: { fontSize: 10.5, opacity: 0.5 } }, '只对本会话'),
        ),
        // What the switch actually does, in one line. A switch says whether; it cannot say what.
        h('div', {
          style: { fontSize: 10.5, opacity: 0.5, marginTop: 3, lineHeight: 1.55, maxWidth: 300 },
        }, '开了之后，这个会话在聊到一个段落时会自己写一篇日记 —— 写到名为「日记」的库（没有就建一个）。不按天，也不会在别的会话里写。'),
        h('div', {
          role: 'group',
          'aria-label': '开关作用于哪一份名单',
          'data-kb-scope': scope,
          style: { display: 'flex', gap: 4, marginTop: 8, alignItems: 'center', fontSize: 11.5 },
        },
          h('span', { style: { opacity: 0.55 } }, '开关作用于'),
          ...[
            ['default', '默认（新会话都用它）'],
            ['session', '仅本会话'],
          ].map(([id, label]) => h('button', {
            key: id,
            type: 'button',
            'aria-pressed': scope === id,
            title: id === 'default'
              ? '所有新会话都用这份名单'
              : '只影响当前这个会话，新会话仍然用默认那份',
            onClick: () => setScope(id),
            style: {
              padding: '1px 8px', borderRadius: 6, font: 'inherit', fontSize: 11.5, cursor: 'pointer',
              border: '1px solid ' + (scope === id ? 'rgba(128,128,128,0.6)' : HAIRLINE),
              background: scope === id ? 'rgba(128,128,128,0.14)' : 'transparent',
              color: 'inherit', opacity: scope === id ? 1 : 0.7,
            },
          }, label)),
          scope === 'session' && !hasOwnSelection
            ? h('span', { style: { opacity: 0.5 } }, '（本会话还没有自己的名单，改一下就会建立）')
            : null,
        ),

        h('div', {
          role: 'group',
          'aria-label': '知识库',
          'data-kb-group': 'true',
          style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 },
        }, bases.map((base) => {
          const isOpen = base.id === openId;
          const isRenaming = renamingId === base.id;
          return h('div', {
            key: base.id,
            'data-kb-card': base.id,
            'data-lifted': dragging && dragging.id === base.id ? 'true' : undefined,
            style: {
              border: '1px solid ' + (isOpen ? 'rgba(128,128,128,0.55)' : HAIRLINE),
              borderRadius: 9,
              background: SURFACE,
              // No `overflow: hidden`: the row menu hangs below the header and would be clipped.
              // Lifted while it is being dragged, so the row under the pointer is obvious.
              ...(dragging && dragging.id === base.id
                ? { boxShadow: ELEVATION, opacity: 0.75, position: 'relative', zIndex: 5 }
                : {}),
            },
          },
            h('div', {
              style: {
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 11px',
              },
            },
              isRenaming
                ? h('input', {
                    autoFocus: true,
                    defaultValue: base.name,
                    'aria-label': '重命名知识库',
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitRename(base, event.currentTarget.value);
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        setRenamingId(null);
                      }
                    },
                    onBlur: (event) => commitRename(base, event.currentTarget.value),
                    style: {
                      flex: '1 1 auto',
                      minWidth: 0,
                      boxSizing: 'border-box',
                      padding: '3px 6px',
                      border: '1px solid ' + HAIRLINE,
                      borderRadius: 6,
                      background: SURFACE_SOLID,
                      color: 'inherit',
                      font: 'inherit',
                      fontSize: 12.5,
                    },
                  })
                : h('button', {
                    type: 'button',
                    onClick: () => setOpenId(isOpen ? null : base.id),
                    onContextMenu: (event) => {
                      event.preventDefault();
                      setMenuFor(base.id);
                    },
                    onPointerDown: (event) => {
                      if (event.button !== 0) return;
                      // Read the group now: by the time the timer fires the event has been recycled
                      // and currentTarget is gone.
                      const group = event.currentTarget.closest('[data-kb-group]');
                      clearTimeout(holdTimer.current);
                      holdTimer.current = setTimeout(() => {
                        const rows = [];
                        if (group) {
                          group.querySelectorAll('[data-kb-card]').forEach((card) => {
                            const box = card.getBoundingClientRect();
                            rows.push({
                              id: card.getAttribute('data-kb-card'),
                              top: box.top,
                              bottom: box.bottom,
                            });
                          });
                        }
                        if (rows.length > 1) {
          const row = rows.find((entry) => entry.id === base.id);
          setDragging({
            id: base.id,
            rows,
            group,
            // How far down the row the pointer was. Without it the row snaps so the pointer sits at its
            // How far down the row the press landed. A constant for the whole drag: without it the row
            // snaps so the pointer sits at its top edge, which reads as the row jumping out from under
            // the cursor.
            grabOffset: row ? event.clientY - row.top : 0,
          });
        }
                      }, 300);
                    },
                    onPointerUp: () => clearTimeout(holdTimer.current),
                    onPointerLeave: () => clearTimeout(holdTimer.current),
                    'aria-expanded': isOpen,
                    title: isOpen
                      ? '收起节点图（长按可上下拖动排序）'
                      : '展开节点图（长按拖动排序；右键或 ⋯ 有更多操作）',
                    style: {
                      flex: '1 1 auto',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      textAlign: 'left',
                      padding: 0,
                      border: 'none',
                      background: 'none',
                      color: 'inherit',
                      font: 'inherit',
                      fontSize: 12.5,
                      fontWeight: isOpen ? 600 : 500,
                      cursor: 'pointer',
                    },
                  },
                    // The chevron is the affordance this row was missing. Nothing said the name
                    // could be clicked, because the switch beside it took all the visual weight —
                    // which is how a base someone had just written to became impossible to find.
                    h('span', {
                      style: { width: 9, opacity: 0.55, fontSize: 10 },
                    }, isOpen ? '▾' : '▸'),
                    base.name,
                  ),
              // Only when there is something to accept: a permanent button would be noise on every
              // row, and the count is what makes a bulk accept an informed one.
              unreviewedIn(base).length > 0 ? h('button', {
                type: 'button',
                title: '把这份知识库里模型改过的节点全部标为已读',
                onClick: (event) => {
                  event.stopPropagation();
                  reviewBase(base);
                },
                style: {
                  flex: '0 0 auto',
                  padding: '1px 7px',
                  border: '1px solid ' + HAIRLINE,
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                  fontSize: 11,
                  cursor: 'pointer',
                },
              }, '已读 ' + unreviewedIn(base).length) : null,
              h(Switch, {
                checked: Boolean(enabled[base.id]),
                label: base.name + (enabled[base.id] ? '：已开启' : '：已关闭'),
                onChange: (next) => toggleBase(base.id, next),
              }),
              // A visible way in. A right-click menu is invisible on its own, and the last time
              // something here was clickable with no hint, a base became impossible to find.
              h('button', {
                type: 'button',
                onClick: () => setMenuFor(menuFor === base.id ? null : base.id),
                'aria-haspopup': 'menu',
                'aria-expanded': menuFor === base.id,
                'aria-label': base.name + '：更多操作',
                title: '更多操作（也可以右键库名）',
                style: {
                  width: 22,
                  height: 22,
                  boxSizing: 'border-box',
                  padding: 0,
                  lineHeight: '18px',
                  border: '1px solid ' + HAIRLINE,
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                  fontSize: 13,
                  cursor: 'pointer',
                  opacity: 0.75,
                },
              }, '⋯'),
              menuFor === base.id ? h('div', {
                'data-kb-menu': 'true',
                role: 'menu',
                style: MENU_STYLE,
              },
                h('button', {
                  type: 'button',
                  role: 'menuitem',
                  onClick: () => {
                    setMenuFor(null);
                    setRenamingId(base.id);
                  },
                  style: MENU_ITEM_STYLE,
                }, '重命名'),
                h('button', {
                  type: 'button',
                  role: 'menuitem',
                  onClick: () => {
                    setMenuFor(null);
                    setConfirmingId(base.id);
                  },
                  style: MENU_ITEM_STYLE,
                }, '删除'),
              ) : null,
            ),
            confirmingId === base.id ? h('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                padding: '0 11px 10px',
                fontSize: 11.5,
                lineHeight: 1.5,
              },
            },
              h('span', null,
                '删除「' + base.name + '」？文件会移到 .dsh-knowledge/.removed/，可以手动恢复。'),
              h('button', {
                type: 'button',
                onClick: () => confirmRemove(base),
                style: {
                  padding: '2px 9px',
                  border: '1px solid rgba(192,57,43,0.5)',
                  borderRadius: 7,
                  background: 'transparent',
                  color: '#c0392b',
                  font: 'inherit',
                  fontSize: 11.5,
                  cursor: 'pointer',
                },
              }, '确定删除'),
              h('button', {
                type: 'button',
                onClick: () => setConfirmingId(null),
                style: {
                  padding: '2px 9px',
                  border: '1px solid transparent',
                  borderRadius: 7,
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                  fontSize: 11.5,
                  cursor: 'pointer',
                  opacity: 0.7,
                },
              }, '取消'),
            ) : null,
            // Kept mounted while collapsed, so the height can be measured before it opens.
            h(Collapsible, { open: isOpen },
              h('div', { style: { padding: '0 11px 12px' } },
              // Inside the map the base is `base`; `open` is the same object whenever this
              // branch renders, and the callbacks below are written against it.
              base.nodes && base.nodes.length ? null : h(Note, null, '这份库里还没有节点。'),
              h(DiaryOrTree, {
                nodeInjection: nodeInjection[base.id] || {},
                defaultInjection: injectionDefaults[base.id] || 'index',
                onInjection: (nodeId, mode) => post('nodeInject', { base: base.id, node: nodeId, mode })
                  .then((result) => setNodeInjection(result.nodeInject || {})).catch(() => {}),
                onReplyAction: (action, payload) => post(action, payload, true),
            // Only the base whose canvas is actually on screen may take the request.
            //
            // `Tree` is mounted for every base, not just the open one, and each copy received the same
            // `focusNode`. The first one in the list consumed it — and cleared it — so the canvas you were
            // looking at never saw it. That is why a request appeared to do nothing at all: it had already
            // been spent somewhere off screen. Search escaped this by opening the target base in the same
            // batch, which is a coincidence of how it was written, not a property of the mechanism.
            focusNode: isOpen && focusNode
              && (base.nodes || []).some((item) => item.id === focusNode.nodeId)
              ? focusNode : null,
            // The result of a locate request, shown under the search box. Three outcomes, and each one says
            // which half is broken: `centred` means the canvas moved; `unknown-node` means the request
            // arrived but this canvas does not draw that node; nothing shown means it never arrived at all.
            onFocusShown: (result, nodeId) => {
              setFocusNode(null);
              if (result) setLastFocus(result + ' · ' + nodeId);
            },
            // `at` is what makes a second pick of the same node pan again: the effect keys on the object, and
            // focusing a node you are already centred on should still be a no-op-looking but real re-centre.
            onLocate: (nodeId) => setFocusNode({ nodeId, at: Date.now() }),
            labels,
            names,
                onResetLayout: resetArrangement,
                shape: shapes[base.id] || 'layers',
                widths,
                nodeWidths: nodeWidths[base.id] || {},
                onSetWidth: (nodeId, value) => {
                  // Optimistic, then written. A width is presentation; the box redraws immediately and
                  // the file catches up.
                  if (nodeId) {
                    setNodeWidths((current) => Object.assign({}, current, {
                      [base.id]: Object.assign({}, current[base.id], { [nodeId]: value }),
                    }));
                  } else {
                    setWidths((current) => Object.assign({}, current, { [base.id]: value }));
                  }
                  post('width', {
                    base: base.id,
                    node: nodeId || undefined,
                    width: value && typeof value === 'object' ? value.w : value,
                    height: value && typeof value === 'object' ? value.h : undefined,
                  }).then((result) => {
                    // The host range-checks; a refused width would otherwise sit on screen looking
                    // applied while the file disagreed.
                    if (result && result.widths) setWidths(result.widths);
                    if (result && result.sizes) setNodeWidths(result.sizes);
                  }, (error) => {
                    setSaving({ error: '设置宽度失败：' + (error && error.message ? error.message : error) });
                  });
                },
                // Built in this scope: `base` and `post` both live here, and reaching for either
                // from Tree compiles fine and throws on click. The scope check caught exactly that.
                onSendToChat: (nodeId) => {
                  const node = (base.nodes || []).find((entry) => entry.id === nodeId);
                  if (!node) return;
                  // Attachment first: a node with a page of text in the composer makes the composer
                  // unreadable, and the file is what the model can read in full anyway.
                  return attachNode(node, base.name, sessionId).then(({ ok, problem }) => {
                    if (ok) {
                      setSaving({ note: '已作为附件送进会话：' + node.title });
                      return;
                    }
                    // The fallback is the inline insert, and it announces itself. A silent fallback
                    // would hide the fact that the attachment path is broken.
                    const quoted = '《' + base.name + ' · ' + node.title + '》'
                      + (node.body ? '\n' + node.body : '');
                    const textProblem = insertText(quoted, sessionId);
                    setSaving(textProblem
                      ? { error: '送进会话失败：附件方式——' + problem + '；文字方式——' + textProblem }
                      : { note: '已作为文字送进会话（附件方式没成功：' + problem + '）' });
                  });
                },
                // Upload a picture the user pasted or dropped, and hand back the path to put in the body.
                onAttachPicture: (file) => new Promise((resolve) => {
                  // Any file, not just pictures. The host decides what it accepts (see extOfAny); refusing here as well meant a .md
                  // or a .docx never reached it, and the user got "附件没有上传成功" with no reason.
                  if (!file) {
                    resolve(null);
                    return;
                  }
                  const fromName = (/\.([A-Za-z0-9]+)$/.exec(String(file.name || '')) || [])[1];
                  const fromType = String(file.type || '').split('/')[1];
                  const ext = String(fromName || fromType || 'png').toLowerCase().replace('jpeg', 'jpg');
                  const reader = new FileReader()
                  reader.onerror = () => resolve({ error: '读取这个文件失败' })
                  reader.onload = () => {
                    // FileReader gives a data URL; the host wants only the base64 part.
                    const base64 = String(reader.result || '').split(',')[1] || ''
                    post('putAsset', { ext, base64 })
                      .then((answer) => resolve(answer && answer.rel ? { rel: answer.rel, name: String(file.name || '') } : { error: '宿主没有返回路径' }))
                      .catch((error) => resolve({ error: (error && (error.error || error.message)) || '上传失败' }))
                  }
                  reader.readAsDataURL(file)
                }),
                onRevertNode: (nodeId) => {
                  // One node at a time: the same route the right-click menu uses, so the two cannot drift.
                  post('revert', { base: base.id, node: nodeId }).then(() => setTick((current) => current + 1)).catch(() => {});
                },
                onPurgeNode: (nodeId) => {
                  patchNodeLocally(base.id, nodeId, { change: 'removed' });
                  post('purgeNode', { base: base.id, node: nodeId }).then(() => {
                    // Re-read rather than patching locally: a purged node is gone from the file, and the
                    // panel's copy has to stop containing it.
                    setTick((current) => current + 1);
                  }, (error) => {
                    setSaving({ error: '彻底删除失败：' + (error && error.message ? error.message : error) });
                  });
                },
                onCreateNode: (parent) => post('createNode', {
                  base: base.id,
                  title: '新节点',
                  body: '',
                  parent: parent == null ? undefined : parent,
                }).then((result) => {
                  // Re-read the files: the new node has to be in the tree before anything points at it.
                  setTick((current) => current + 1);
                  return result.node;
                }, (error) => {
                  setSaving({ error: '新建节点失败：' + (error && error.message ? error.message : error) });
                  return null;
                }),
                /**
                 * Create a node beneath an existing one.
                 *
                 * Only downward. A parent is born as a top-level node from the canvas menu, never inserted above
                 * something that is already in the tree: doing that would either give the target two parents — which
                 * the single `parent` field cannot hold — or silently reroute it out of its branch. Where a node
                 * sits in the tree is changed deliberately, with Alt+drag, not as a side effect of creating one.
                 */
                onCreateChild: (nodeId) => post('createNode', {
                  base: base.id,
                  title: '新节点',
                  body: '',
                  parent: nodeId,
                }).then((result) => {
                  setTick((current) => current + 1);
                  return result.node;
                }, (error) => {
                  setSaving({ error: '新建节点失败：' + (error && error.message ? error.message : error) });
                  return null;
                }),
                onRemoveNode: (nodeId) => {
                  patchNodeLocally(base.id, nodeId, { change: 'removed' });
                  post('removeNode', { base: base.id, node: nodeId }).catch(() => {});
                },
                onSetShape: (next) => chooseShape(base, next),
                focusId: focus && focus.base === base.id ? focus.node : null,
                colors: colors[base.id] || {},
                onColor: (nodeId, hex) => {
                  // Optimistic: the stripe changes on the press, and the write follows. A failure
                  // leaves the panel showing a colour the file does not have, which the next load
                  // corrects — the alternative is a visible lag on every swatch press.
                  setColors((current) => {
                    const forBase = Object.assign({}, current[base.id] || {});
                    if (hex) forBase[nodeId] = hex;
                    else delete forBase[nodeId];
                    return Object.assign({}, current, { [base.id]: forBase });
                  });
                  post('color', { base: base.id, node: nodeId, color: hex }).catch(() => {});
                },
                base,
            fullscreen,
            // Body owns which view is on screen, so the canvas only asks.
            onShowHistory: (nodeId) => showHistory(base.id, nodeId),
            positions: positions[base.id] || {},
            collapsedNodes: collapsed[base.id],
            onCollapse: (operation) => changeCollapsed(base, operation),
            onArrange: (updated) => {
              setPositions((current) => ({ ...current, [base.id]: updated }));
              post('layout', { base: base.id, positions: updated }).catch(() => {});
            },
            onMove: (nodeId, x, y) => {
              const updated = {
                ...(positions[base.id] || {}),
                [nodeId]: { x: Math.round(x), y: Math.round(y) },
              };
              setPositions((current) => ({ ...current, [base.id]: updated }));
              // The whole map for this base, so the request is idempotent and a lost one
              // cannot leave half the boxes behind.
              post('layout', { base: base.id, positions: updated }).catch(() => {});
            },
            extraLinks: drafts[base.id] || [],
            edits: edits[base.id] || {},
            onEdit: (nodeId, patch) => {
              setEdits((current) => ({
                ...current,
                [base.id]: {
                  ...(current[base.id] || {}),
                  [nodeId]: { ...((current[base.id] || {})[nodeId] || {}), ...patch },
                },
              }));
              post('changes', { base: base.id, edits: [{ node: nodeId, ...patch }] })
                .then(() => {
                  // Saved, so the draft is no longer a draft — it is what is on disk, and the
                  // "not saved" mark has to go with it. It never did, which is why the warning dot
                  // appeared after every successful save.
                  //
                  // Compared rather than cleared outright: another edit can land while this request
                  // is in flight, and that one is still unsaved and must keep its mark.
                  setEdits((current) => {
                    const forBase = { ...(current[base.id] || {}) };
                    const pending = forBase[nodeId];
                    if (pending && !Object.keys(patch).every((key) => pending[key] === patch[key])) {
                      return current;
                    }
                    delete forBase[nodeId];
                    return { ...current, [base.id]: forBase };
                  });
                  // The host cleared this node's review marker, because editing it is the act
                  // of looking at it.
                  patchNodeLocally(base.id, nodeId, { ...patch, change: undefined });
                })
                .catch(() => {});
            },
            onReview: (nodeId) => {
              post('changes', { base: base.id, review: [nodeId] })
                .then(() => patchNodeLocally(base.id, nodeId, { change: undefined }))
                .catch(() => {});
            },
            onLink: (from, to) => {
              const existing = (base.links || []).concat(drafts[base.id] || []);
              if (existing.some((link) => link.from === from && link.to === to)) return;
              setDrafts((current) => ({
                ...current,
                [base.id]: (current[base.id] || []).concat([{ from, to }]),
              }));
              post('changes', { base: base.id, links: [{ from, to }] }).catch(() => {});
            },
            /**
             * Make one node the parent of another — the panel's only structural gesture.
             *
             * Reloads rather than patching in place, for the same reason the note write does: the store decides
             * what a refused move means (a loop, a node that is not there), and a local patch would show the tree
             * as the panel guessed it rather than as the file has it.
             */
            onParent: (nodeId, parentId) => {
              post('parent', { base: base.id, node: nodeId, parent: parentId })
                .then(() => setTick((current) => current + 1))
                .catch((error) => setSaving({
                  error: '改父子关系失败：' + (error && error.message ? error.message : error),
                }));
            },
            /**
             * Write one link's note.
             *
             * Reloads afterwards rather than patching in place: an empty note is a deletion, not a blank
             * string, and that decision belongs to the store — so the host's answer is the truth and the panel
             * re-reads it. Patching optimistically would have the two sides disagree about what "no note"
             * looks like, which is exactly the kind of quiet divergence this codebase keeps paying for.
             */
            onSetLinkNote: (from, to, note) => {
              post('linkNote', { base: base.id, from, to, note })
                .then(() => load())
                .catch(() => {});
            },
          }),
          // The condition must include `note`, not only the text below. It did not, so every note this
          // panel produced was written and never rendered — including the one explaining why a node
          // arrived as text instead of an attachment.
          saving === 'saving' || (saving && (saving.error || saving.note))
            ? h('div', {
                style: {
                  marginTop: 8, fontSize: 11.5,
                  color: saving.error ? '#c0392b' : 'inherit',
                  // A note is as important as an error here: it is the only thing that says which path
                  // ran. Dimming it is how it went unread.
                  opacity: 1,
                },
              }, saving.error ? '保存失败：' + saving.error
                : saving.note ? saving.note : '保存中…')
            : null,
          drafts[base.id] && drafts[base.id].length
            ? h('div', {
                style: {
                  marginTop: 8, display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 11.5, opacity: 0.65, flexWrap: 'wrap',
                },
              },
                h('span', null, '这次连的 ' + drafts[base.id].length + ' 条关联'),
                h('button', {
                  type: 'button',
                  onClick: undoLast,
                  style: {
                    padding: '2px 9px',
                    border: '1px solid ' + HAIRLINE,
                    borderRadius: 7,
                    background: 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    fontSize: 11.5,
                    cursor: 'pointer',
                  },
                }, '撤销最后一条'),
                h('span', null, '（或 Ctrl+Z；已经写进文件的连线要从文件里删）'),
              )
            : null,
              ),
            )
          );
        })),
        open ? h(Note, null,
          '键盘：Tab 走到节点，回车编辑，Shift+回车开始连线，再到目标节点回车完成。',
          h('br'),
          '按下后没等到长按就松手的那一下不移动也不编辑 —— 免得误触改到位置。',
          h('br'),
          '＋ 新增 · ~ 修改 · − 已废弃（保留但灰掉）· 橙色虚线是关联，不是父子关系。',
          h('br'),
          '带标记的节点右下角有个 ✓：点它表示看过了，会清掉标记（改内容也会清）。',
          h('br'),
          '编辑、连线、挪位置、开关都会立刻写进 .dsh-knowledge/，不需要保存按钮。')
          : null,
        // Last child, so it paints over everything above it. The panel underneath stays mounted — see
        // `historyLayer` for why that matters.
        historyLayer,
      );
    }

    function ChipTitle() {
      return h('span', { style: { fontSize: 12 } }, '知识库');
    }

    function definition() {
      return {
        id: PACKAGE_ID,
        kind: TAB_KIND,
        keepMounted: true,
        title: () => '知识库',
        guide: [{
          id: TAB_KIND,
          order: 60,
          title: () => '知识库',
          description: () => '树状知识库：按会话启用，节点改动带 [新增/修改/已废弃] 标记',
          icon: Glyph,
        }],
      };
    }

    /**
     * Show a render failure in the panel instead of a blank one.
     *
     * Without this, a throw inside Body unmounts the subtree and leaves an empty pane — which is
     * the hardest possible starting point for a diagnosis, and the second time this panel has
     * been blank in front of the user. The message and the top of the stack are shown, so the
     * next occurrence is a copy-paste rather than a guess.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        const { error } = this.state;
        if (!error) return this.props.children;
        const stack = String((error && error.stack) || '').split('\n').slice(1, 5).join('\n');
        return h('div', {
          style: { padding: '14px 16px', font: 'inherit', color: 'inherit', fontSize: 12 },
        },
          h('div', { style: { fontWeight: 600, color: '#c0392b' } }, '知识库面板渲染出错'),
          h('div', {
            style: { marginTop: 6, lineHeight: 1.6, wordBreak: 'break-word' },
          }, String((error && error.message) || error)),
          h('pre', {
            style: {
              marginTop: 8, padding: 8, fontSize: 10.5, lineHeight: 1.5,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.7,
              border: '1px solid ' + HAIRLINE, borderRadius: 6,
            },
          }, stack),
        );
      }
    }

    /**
     * The Knowledge base section of the app's Settings.
     *
     * One row per workspace, each with a pill per base. A pill writes the workspace default — what every
     * session in that workspace inherits — rather than one session's own list, because a settings page is
     * the wrong place to decide something about a session that is not open.
     *
     * The section reads the host's workspace list rather than any path: the browser picks from that list
     * and the host resolves the pick, which is how this plugin has named workspaces since its first route.
     */
    function KnowledgeSettings() {
      const [status, setStatus] = React.useState('loading');
      const [problem, setProblem] = React.useState(null);
      const [workspaces, setWorkspaces] = React.useState([]);
      const [busy, setBusy] = React.useState(null);

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(PREFIX + '/workspaces');
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + response.status));
          setWorkspaces(Array.isArray(payload.workspaces) ? payload.workspaces : []);
          setStatus('ready');
        } catch (error) {
          setProblem(String((error && error.message) || error));
          setStatus('failed');
        }
      }, []);

      React.useEffect(() => { void load(); }, [load]);

      const setAttachmentMode = React.useCallback(async (workspace, mode) => {
        setBusy(workspace.cwd + '/attachments');
        setProblem(null);
        try {
          const response = await fetch(PREFIX + '/attachmentMode', {
            method: 'PUT', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspace: workspace.cwd, session: workspace.sessionId, mode }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + response.status));
          setWorkspaces((current) => current.map((entry) => entry.cwd === workspace.cwd
            ? { ...entry, attachmentMode: payload.attachmentMode } : entry));
        } catch (error) {
          setProblem(String((error && error.message) || error));
        } finally {
          setBusy(null);
        }
      }, []);

      /** Flip one base in one workspace, then take the host's answer as the truth. */
      const toggle = React.useCallback(async (workspace, baseId) => {
        // null means the workspace has no selection file, which every reader treats as "all of them".
        const on = workspace.enabled === null
          ? workspace.bases.map((base) => base.id)
          : workspace.enabled.slice();
        const next = on.includes(baseId) ? on.filter((id) => id !== baseId) : on.concat([baseId]);
        setBusy(workspace.cwd + '/' + baseId);
        setProblem(null);
        try {
          const response = await fetch(PREFIX + '/selection', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: workspace.sessionId, scope: 'workspace', enabled: next }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + response.status));
          setWorkspaces((current) => current.map((entry) =>
            (entry.cwd === workspace.cwd ? { ...entry, enabled: payload.enabled } : entry)));
        } catch (error) {
          setProblem(String((error && error.message) || error));
        } finally {
          setBusy(null);
        }
      }, []);

      /** Set one base's injection mode, then take the host's answer as the truth. */
      const setInjection = React.useCallback(async (workspace, baseId, mode) => {
        const key = workspace.cwd + '/' + baseId;
        setBusy(key);
        setProblem(null);
        try {
          const response = await fetch(PREFIX + '/inject', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // The Session is what resolves the workspace, so it is always sent.
            body: JSON.stringify({ session: workspace.sessionId, base: baseId, mode: mode }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + response.status));
          const inject = payload.inject || {};
          setWorkspaces((list) => list.map((entry) => (entry.cwd !== workspace.cwd ? entry : Object.assign({}, entry, {
            bases: entry.bases.map((item) => (item.id === baseId
              ? Object.assign({}, item, { mode: inject[baseId] || 'index' })
              : item)),
          }))));
        } catch (error) {
          setProblem(String((error && error.message) || error));
        } finally {
          setBusy(null);
        }
      }, []);

      /** The switch the panel already uses, rather than a second control that means the same thing. */
      const pill = (workspace, base) => {
        const on = workspace.enabled === null || workspace.enabled.includes(base.id);
        const key = workspace.cwd + '/' + base.id;
        return h('span', { key: base.id, style: { display: 'inline-flex', opacity: busy === key ? 0.5 : 1 } },
          h(Switch, {
            checked: on,
            label: (base.name || base.id) + (on ? '：模型会读它' : '：模型不读它'),
            onChange: () => toggle(workspace, base.id),
          }));
      };

      /**
       * How much of this base reaches the model, as a choice between two.
       *
       * A single button whose label was the *other* state — "按需索引" while it was on full — left the
       * reader to work out which one was selected. Two segments with the chosen one lit says it without a
       * legend.
       *
       * Offered only while the switch is on, which is what makes "a base that is off has no mode" true by
       * construction: there is no guard to forget, because the control is not built.
       */
      const injectionButton = (workspace, base) => {
        const on = workspace.enabled === null || workspace.enabled.includes(base.id);
        if (!on) return null;
        const full = base.mode === 'full';
        const key = workspace.cwd + '/' + base.id;
        const segment = (label, value, chosen, edge) => h('button', {
          type: 'button',
          disabled: busy === key,
          'aria-pressed': chosen,
          title: value === 'full'
            ? '正文直接写进提示词，模型不用去取。适合不大、但你希望它每次都知道的库。'
            : '只给标题和触发条件，正文由模型按需取。适合大库。',
          // Clicking the chosen side does nothing rather than making a round trip to be told so.
          onClick: chosen ? undefined : () => setInjection(workspace, base.id, value),
          style: {
            padding: '2px 8px', font: 'inherit', fontSize: 11.5,
            cursor: chosen ? 'default' : 'pointer',
            border: '1px solid ' + (chosen ? 'rgba(201,118,27,0.65)' : HAIRLINE),
            borderRadius: edge === 'first' ? '999px 0 0 999px' : edge === 'last' ? '0 999px 999px 0' : 0,
            marginLeft: edge === 'first' ? 0 : -1,
            background: chosen ? 'rgba(201,118,27,0.18)' : 'transparent',
            color: 'inherit',
            opacity: busy === key ? 0.5 : chosen ? 1 : 0.5,
          },
        }, label);
        return h('span', { style: { display: 'inline-flex', flex: '0 0 auto' } },
          segment('默认按需', 'index', !full, 'first'),
          segment('默认全文', 'full', full, 'last'));
      };

      return h('div', { style: { font: 'inherit', color: 'inherit' } },
        h('div', { style: { fontSize: 13, opacity: 0.7, marginBottom: 10, lineHeight: 1.5 } },
          '每个工作区读哪些知识库。这里改的是默认值 —— 那个工作区的新会话都用它；'
          + '某一次会话可以单独例外，在侧栏的知识库面板里设。注入方式是库的默认值；在画布中编辑或右键节点，可单独选全文或按需，同工作区共享。'),
        problem ? h('div', {
          style: {
            marginBottom: 10, padding: '6px 9px', borderRadius: 7, fontSize: 12,
            border: '1px solid rgba(192,57,43,0.5)', background: 'rgba(192,57,43,0.08)', color: '#c0392b',
          },
        }, problem) : null,
        status === 'loading' ? h('div', { style: { fontSize: 12.5, opacity: 0.6 } }, '读取工作区…') : null,
        status === 'failed'
          ? h('button', {
            type: 'button',
            onClick: () => { setStatus('loading'); void load(); },
            style: {
              padding: '3px 10px', border: '1px solid ' + HAIRLINE, borderRadius: 7,
              background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, cursor: 'pointer',
            },
          }, '重试')
          : null,
        status === 'ready' && workspaces.length === 0
          ? h('div', { style: { fontSize: 12.5, opacity: 0.6 } }, '这个宿主没有列出任何工作区。')
          : null,
        workspaces.map((workspace) => h('div', {
          key: workspace.cwd,
          style: {
            marginBottom: 12, padding: '9px 11px', border: '1px solid ' + HAIRLINE,
            borderRadius: 9, background: SURFACE,
          },
        },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 2 } }, workspace.name),
          h('div', {
            title: workspace.cwd,
            style: {
              fontSize: 11, opacity: 0.45, marginBottom: 7,
              overflowWrap: 'anywhere', wordBreak: 'break-word',
            },
          }, workspace.cwd),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5, fontSize: 12 } },
            '附件读取方式',
            h('select', {
              value: workspace.attachmentMode || 'on-demand',
              disabled: busy !== null,
              onChange: (event) => setAttachmentMode(workspace, event.target.value),
              style: { font: 'inherit', color: 'inherit', background: SURFACE, border: '1px solid ' + HAIRLINE, borderRadius: 5, padding: '3px 6px' },
            },
              h('option', { value: 'on-demand' }, '按需读取（默认）'),
              h('option', { value: 'required' }, '必须读取'),
            )),
          h('div', { style: { fontSize: 11.5, opacity: 0.65, lineHeight: 1.5, marginBottom: 9 } },
            workspace.attachmentMode === 'required'
              ? '读取节点时自动附上可解析文本和图片，会增加 token 消耗。每个文本附件最多 8,000 字符、每次最多 6 张图片，其余按需续读；不支持解析的格式仅列路径。'
              : '读取节点时只列附件清单，模型需要时再读取指定文件或图片。文本支持分段读取，减少无关内容占用上下文。',
            ' 此设置作用于本工作区的知识库读取工具；手动拖入对话的附件仍作为会话附件发送。'),
          // The recorder. A setting, not a control on the panel it decorates: it decides what the host writes.
          // A pill, like the diary switch in the panel: one function, one control shape. The checkbox also had a bug
          // worth remembering — its state came from the PUT's answer, and the answer did not include the flag, so it
          // could be turned on and never off.
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 } },
            h('span', { style: { fontSize: 11.5, opacity: 0.8 } }, '记录调用过程'),
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': workspace.live === true,
              'data-kb-live': workspace.live === true ? 'on' : 'off',
              title: '打开后，宿主会在每次工具调用开始时也写一行 activity.log，面板才能显示"正在做什么"。代价是日志大约翻倍。',
              disabled: busy === workspace.cwd + '/live',
              onClick: () => {
                const next = !(workspace.live === true);
                setBusy(workspace.cwd + '/live');
                setProblem(null);
                fetch(PREFIX + '/selection', {
                  method: 'PUT',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    // The cwd as well as the session: this page edits workspaces the user is not sitting in, and those have no
                    // session in this process. Without it the host answered "a Session id is required" for every other workspace.
                    workspace: workspace.cwd,
                    session: workspace.sessionId,
                    scope: 'workspace',
                    enabled: workspace.enabled === null
                      ? workspace.bases.map((base) => base.id)
                      : workspace.enabled,
                    live: next,
                  }),
                })
                  .then((response) => response.json().catch(() => ({})).then((payload) => {
                    if (!response.ok || !payload.ok) throw new Error(payload.error || ('HTTP ' + response.status));
                    return payload;
                  }))
                  .then((payload) => {
                    setWorkspaces((current) => current.map((entry) =>
                      (entry.cwd === workspace.cwd ? { ...entry, live: Boolean(payload.live) } : entry)));
                  })
                  .catch((error) => setProblem(String((error && error.message) || error)))
                  .then(() => setBusy(null));
              },
              style: {
                position: 'relative', width: 34, height: 18, padding: 0, borderRadius: 999,
                border: '1px solid ' + HAIRLINE, cursor: 'pointer',
                background: workspace.live === true ? 'rgba(201,118,27,0.85)' : 'rgba(128,128,128,0.28)',
                opacity: busy === workspace.cwd + '/live' ? 0.5 : 1,
                transition: 'background 120ms ease',
              },
            }, h('span', {
              style: {
                position: 'absolute', top: 2, left: workspace.live === true ? 18 : 2,
                width: 12, height: 12, borderRadius: 999, background: 'Canvas',
                transition: 'left 120ms ease',
              },
            })),
          ),
          workspace.bases.length === 0
            ? h('div', { style: { fontSize: 12, opacity: 0.55 } }, '这个工作区还没有知识库。')
            // One row per base: the name is the subject and reads as text, the two controls are the options
            // and sit together on the right. Before this they were three identical pills wrapped in one
            // flow, so a base's name, its on/off state and its injection mode were indistinguishable —
            // and a switched-off base looked exactly like a mode button.
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              workspace.bases.map((base) => h('div', {
                key: base.id,
                style: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 },
              },
                h('span', {
                  title: base.id,
                  style: {
                    flex: 1, minWidth: 0, fontSize: 12.5,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    // A base that is off is dimmed rather than restyled: the name keeps its shape so the
                    // column still reads as a list of names, and only the controls say what is on.
                    opacity: (workspace.enabled === null || workspace.enabled.includes(base.id)) ? 1 : 0.45,
                  },
                }, base.name || base.id),
                // The switch is the last column, so it lines up down the list whether or not a base has a
                // mode to show. With the switch in the middle, every base with a mode pushed it left and the
                // column wandered.
                injectionButton(workspace, base),
                pill(workspace, base)))),
          workspace.enabled === null && workspace.bases.length > 0
            ? h('div', { style: { fontSize: 11, opacity: 0.5, marginTop: 6 } },
              '还没有单独的设置，所以默认全部打开。点一下就会为它建立一份名单。')
            : null,
        )),
      );
    }

    /** Body behind the boundary, so a throw anywhere inside it stays visible. */
    function GuardedBody(props) {
      return h(PanelBoundary, null, h(Body, props));
    }

    return {
      // cordis guards service access by name: reading ctx.remote.workspaceFiles needs that
      // exact key declared, not just the `remote` root it hangs off.
      inject: ['slots', 'sidebarRightTabs', 'remote', 'remote.workspaceFiles'],
      // Pure geometry, exposed so the load check can assert on it. Whether a line clears a box is
      // the one part of this panel that cannot be judged from a screenshot, and getting it wrong
      // shows up as a line that looks slightly off rather than as a failure.
      // Pure decisions the panel makes, exposed for the same reason the geometry is: a button cannot
      // be pressed by a check script, but the question the button answers can be asked directly.
      __logic: { diaryPages, DiaryBook, DiaryOrTree, DiaryReplies, Tree, NodeBox, subtreeIndex, foldedNodes, applyCollapse,
        nextUnread, parseMarkdown, inlineSpans, estimateBox, searchBases, diffLines, worthMarking, historyMarks,
      },
      __geometry: {
        oneLineBox,
        segmentHitsBox,
        curveHitsBox,
        linkControlPoint,
        routeLink,
        anchorsOf,
        bestLink,
        edgeFades,
        edgeStroke,
        centreOf,
        edgePoint,
        routeKeyOf,
        BOX_W,
        BOX_H,
      },
      apply(ctx) {
        REMOTE = ctx.remote;
        CTX = ctx;
        ctx.effect(() => ctx.sidebarRightTabs.register(definition()),
          'knowledge-tree: tab type');
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: PACKAGE_ID,
        }, GuardedBody)), 'knowledge-tree: tab body');
        // The app's Settings page, so a workspace can be configured without opening one of its sessions.
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: PACKAGE_ID,
          order: 60,
          label: () => '知识库',
          inject: () => ({}),
        }, KnowledgeSettings)), 'knowledge-tree: settings section');
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: PACKAGE_ID,
        }, ChipTitle)), 'knowledge-tree: chip title');
      },
    };
  },
});
