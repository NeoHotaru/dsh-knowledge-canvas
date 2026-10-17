/**
 * The base a workspace gets the first time it is used, and the one that has to keep up with the plugin.
 *
 * Two audiences, and the second is the reason this is worth shipping. A person opening the panel for the
 * first time has an empty pane and no idea what a node should contain; the seed answers by being an
 * example. The model has the outline in its prompt, so the same text teaches it what the base is for and
 * — through one node written the way nodes should be written, trigger line included — how to write the
 * next one.
 *
 * **Creation and updates are two different rules, on purpose.**
 *
 * Creation happens only when `.dsh-knowledge/` does not exist at all — the narrowest rule there is, so a
 * workspace where the user deleted these bases never has them reappear, and deleting the whole directory is a
 * legible way to ask for the defaults back.
 *
 * Updates are separate: a tutorial that never changes is worse than none. Ship a feature, and every existing
 * workspace keeps a tutorial that does not mention it — and since the outline is what the model sees, the
 * model keeps believing the old text. That is the failure this file now also exists to prevent. So a base that
 * is still there, and still ours, is brought up to `SEED_VERSION`.
 *
 * "Still ours" is per node: each seeded node records a digest of the body we wrote. A node whose body still
 * matches that digest was never touched and can be replaced; a node somebody edited is left exactly as it is,
 * because the tutorial is an example and their version of it is theirs.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DIRNAME, saveBase } from './store.js'
import { writeSelection } from './state.js'
import { invalidate } from './outline.js'
import { log } from './log.js'

/**
 * Bumped whenever the text of any node changes.
 *
 * It is written into the base, so an older workspace can tell it is behind without comparing every body, and a
 * workspace that is already current costs one field read.
 */
export const SEED_VERSION = 3

/** Workspaces already checked, so the log gets one line each rather than one per session event. */
const checked = new Set()

/**
 * A short digest of a body, so "we wrote this" is a fact rather than a guess.
 *
 * Not a security measure — eight hex characters of SHA-1 over a paragraph. It only has to distinguish "the
 * text we seeded" from "the text somebody has since edited", and those differ by far more than a collision.
 */
function bodySum(text) {
  return createHash('sha1').update(String(text || ''), 'utf8').digest('hex').slice(0, 12)
}

const NODES = [
  {
    id: 'n1',
    parent: null,
    title: '这个知识库是什么',
    body: `**一个跟着工作区走的笔记本，模型和你都能读写。**

它不是聊天记录，也不在云端。它在 \`.dsh-knowledge/\` 下，是几个普通的 JSON 文件 ——
你可以用记事本打开、可以提交进 git、可以整个拷走。

**两个读者，看到的东西不一样:**

- **模型**读到的是【大纲】:每个节点一行（id、标题、一句要点，外加「什么时候该想起它」那一行）。
  正文它要主动调 \`knowledge_read\` 才看得到 —— 所以标题和要点要能独立看懂。
- **你**看到的是面板上的画布:完整正文、颜色、位置、连线。

**什么时候该想起它**：你想让"这件事我们已经知道过"变成模型下次真的知道的时候。`,
  },
  {
    id: 'n2',
    parent: 'n1',
    title: '面板：先认位置',
    body: `**顶上那一排（在库列表之上）:**
- 搜索框 —— 输入就搜所有库的标题和正文
- 「默认（新会话都用它）」/「仅本会话」—— 下面那些开关改的是哪一份
- 「已读 N」—— 把模型改过的节点全部标记为已读

**每个库一行:**
- 点库名 → 展开或收起它的画布
- 右边的开关 → 这个库**给不给模型看**。关掉 = 它读不到，也写不进
- 「⋯」→ 重命名、删除这个库

**展开后，画布上方那一排是视图控制:**
- 「−  87%  ＋」—— 缩放，12% 到 260%；点中间那个百分比回到 100%
- 「适应」—— 缩放到刚好放下全部节点
- 「宽度」—— 这份库里节点的默认宽度（单个节点还能在自己的编辑器里另设）
- 三个小图标 —— 画布的排布形态（分层 / 阶梯 / 紧凑）
- 「重排」—— 只在你有节点被手动拖过时才出现，点了就清掉手动位置、重新自动排
- 「定位到…」—— 按 id 找节点

**画布本身**:滚轮缩放 · 拖空白平移 · 拖节点移动 · 右键节点看修改历史。

**什么时候该想起它**：你找不到某个按钮、或者不确定"这个开关改的是谁"的时候。`,
  },
  {
    id: 'n3',
    parent: 'n1',
    title: '节点：每一步怎么做',
    body: `**新建**：右键画布空白处，就在那儿出现一个节点。

**改内容**：双击节点打开编辑器。里面能改标题和正文，还有「标记颜色」「宽高」「废弃」「彻底删除」。
**改完要点「保存」或按回车** —— 全面板只有这一处不是立刻写盘。

**挪位置**：直接拖。松手就写进 \`layout.json\`。

**改父子关系**：**按住节点别动，停一会儿，再拖到另一个节点上松开**，它就成了那个节点的子节点。
（直接拖是挪位置；长按拖才是改结构。这个区别就是"按下去就拖"不会误改结构的原因。）

**改颜色**：编辑器里「标记」那一排色块。只影响你看，不进提示词。

**改大小**：拖节点右下角；或者在它自己的编辑器里单独设这一个节点的宽高。

**已读**：模型改过的节点旁边有「＋ / ~ / −」标记和一个 ✓。点 ✓ 表示你看过了。
改内容也会清掉标记。

**废弃 ≠ 删除**：「废弃」保留节点、变灰、不再注入给模型，它的孩子上提到它的父节点 ——
想"先拿开但不丢"就用它。「彻底删除」是从文件里删掉，撤销不了。

**键盘**：Tab 走到节点，回车编辑；Shift+回车开始连线，再到目标节点回车完成。

**什么时候该想起它**：你想动一个节点、但不确定"这一下会不会改到结构"的时候。`,
  },
  {
    id: 'n7',
    parent: 'n1',
    title: '关联线：怎么画，注释怎么写',
    body: `**画**：右键从一个节点拖到另一个节点（或者 Shift+回车选起点、到终点再回车）。
画出来是一条橙色虚线。

**它不是父子关系。** 父子是"整体和部分"，关联是"这两件事有关"。

**点那条线 → 给它写一行注释。** 线本身只有 1.4 像素，所以它有一圈看不见的加宽命中区 ——
点得中就说明你确实点在线上。

**注释写的是"什么时候该顺着这条线走"。** 它会被放进入口那一行，别的会话在大纲里就能看到；
一条没有注释的线，别人拿它做不了任何事。所以**模型连线时必须写注释**；
你自己画的可以不写，但随时能补。

**写错了直接改**：再点一次那条线，改完回车。线不会断，也不会多出一条。

**什么时候该想起它**：你觉得两件事"有关系"、但又不该是父子关系的时候。`,
  },
  {
    id: 'n8',
    parent: 'n1',
    title: '修改历史：怎么看',
    body: `**右键节点 → 修改历史**，一张卡片在指针旁边出来。

**每个节点留最近十版，每一版都存了完整的标题和正文** —— 不是只存时间，
旧正文是真的存下来了，所以"上次写的是什么"答得出来。

卡片从上往下:
- 「当前」—— 你看到的这一版，**绿色**是相对上一版新增的行
- 「上一个版本」「更早」—— **红色**是这一版之后被删掉的行

两侧各承担一半改动，拼起来就是完整的一次修改。长正文会折叠，
按钮上写着还有多少行、其中几处改动。纯空行的增删不算改动，也不着色。

**卡片太小就点右上角的「展开 ⤢」** —— 同一份历史铺满整个面板；
返回之后画布停在原处，不会重置。

**什么时候该想起它**：你想知道这句话是谁、什么时候改的、原来写的是什么的时候。`,
  },
  {
    id: 'n9',
    parent: 'n1',
    title: '找到某个节点',
    body: `三条路，用途不同:

**① 搜索框**（库列表最上面）:搜所有库的标题和正文，点结果跳过去。

**② 「定位到…」**（画布工具栏右侧的下拉）:按 id 找。对话里常出现 \`o17\` 这样的 id，
在这里选它，画布会滑到那个节点。

**③ 直接说 id**:\`knowledge_read\` 可以只读一个节点 —— 正文，加上父、子、每条关联各一行。
所以"顺着一条关联走过去"是一小步，不用整个库从头读到尾。

**什么时候该想起它**：对话里冒出一个你不知道是什么的 id；
或者你怀疑某件事写过、但记不住在哪个库里。`,
  },
  {
    id: 'n4',
    parent: 'n1',
    title: '模型该往里写什么',
    body: `**写"下次还会用到"的东西**，不要写这次的流水账。

值得写：踩过的坑和它的成因、这个项目特有的约定、一个反复要查的路径或命令、
一次量出来的数字（连同条件和结论一起写，不然下次没法复用）。

不值得写：这次做了什么、你要它做什么、还没定的事。

**一条正文的最后一行，用「什么时候该想起它」开头，后面跟一个冒号。**
那一行会被单独取出来放进提示词，成为模型在正确时刻能看见的触发器。
**没有这一行的节点，在大纲里会被标「（无触发器）」** —— 意思是没人会在需要它的时刻想起它。

**一条笔记只写一件事。** 一件事写完还长，就拆成父子两个节点:
父节点给结论，子节点给细节。

**给两个节点连关联时，必须写一行注释** —— 说明什么时候该顺着这条线走。
那行注释会进别的会话的大纲，而一条只写着"这两个有关"的线，别人拿它做不了任何事。
用户自己画的线不强制（他只读自己的面板），但模型画的必须有。

**什么时候该想起它**：一件事你解释了第二遍的时候，那就是该写下来的时候。`,
  },
  {
    id: 'n5',
    parent: 'n4',
    title: '示例：一条写对了的笔记',
    body: `**渲染出来的正文和源文件是两套东西 —— 改一个不改另一个，就是"改了没生效"。**

实例：把宽度接进了排版的间距计算，没接进盒子的样式 —— 于是节点之间拉开了，
盒子本身没变宽。代码能跑，检查全绿，而它只做了一半。

**什么时候该想起它**：改完一处、准备说"好了"之前，问一句 ——
**这个值还有谁在用它？**

（注意这条的三个部分：一个能记住的结论、一次具体的事故、一个可执行的触发条件。
缺了最后一段，它会在你读不到的时刻需要它。）`,
  },
  {
    id: 'n6',
    parent: null,
    title: '这些库是示例，删掉就好',
    body: `这份库是为了让你第一次打开时不是一片空白。**它完全可以删掉。**

**它会跟着插件一起更新。** 每次插件升级，只要某条正文还是我们写的（你没改过），
就会被换成新版；你改过的那些一个字都不动。大纲里那一行「内置教程 vN」就是它现在第几版 ——
**看到版本号变了，就值得重读一遍**，因为里面的操作说明可能已经跟着新功能变了。

想留着当参考也行 —— 但它讲的都是这个工具本身，而你的项目会需要它讲别的东西。

**什么时候该想起它**：你建好自己第一个库之后。`,
  },
]

const LINKS = [
  { from: 'n2', to: 'n3', note: '读和改是同一个面板的两件事' },
  { from: 'n4', to: 'n5', note: '怎么写，看这一条的三个部分' },
]

/** A date, so the seeded nodes are not the only ones in a new base with no stamp. */
function stamp() {
  const now = new Date()
  const two = (value) => String(value).padStart(2, '0')
  return now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate())
    + ' ' + two(now.getHours()) + ':' + two(now.getMinutes())
}

/**
 * Give one workspace its first base, if it has never had one.
 *
 * @returns the base id when something was created, or null.
 */
export async function seedIfFirstTime(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  if (checked.has(cwd)) return null
  checked.add(cwd)
  try {
    const dir = join(cwd, DIRNAME)
    // The rule, in one line: the directory existing at all means this workspace has been used, and
    // whatever it holds now — including nothing — is the user's decision.
    const exists = await stat(dir).then(() => true, () => false)
    if (exists) return null

    await mkdir(dir, { recursive: true })
    const at = stamp()
    await saveBase(join(dir, 'welcome.json'), buildBase(at))
    // On, so the model sees it — the point is that both audiences read it.
    await writeSelection(cwd, ['welcome'])
    log('seeded the welcome base for ' + cwd)
    return 'welcome'
  } catch (error) {
    log('FAIL seeding ' + cwd + ': ' + ((error && error.message) || error))
    return null
  }
}

/** The base as this version of the plugin writes it, fresh. */
function buildBase(at) {
  return {
    version: 1,
    id: 'welcome',
    name: '怎么用这个知识库',
    // Recorded on the base so a current workspace costs one field read instead of a body-by-body comparison.
    // `at` is what the outline shows beside the version: the node stamps are preserved across an upgrade — on
    // purpose, so colours and positions keep applying — which makes them useless as a signal that the text
    // changed. This field is that signal.
    seed: { version: SEED_VERSION, at },
    nodes: NODES.map((node) => Object.assign({}, node, {
      change: 'added',
      at,
      // What we wrote, so a later run can tell "untouched" from "edited" without keeping every old body.
      seedSum: bodySum(node.body),
    })),
    links: LINKS,
  }
}

/**
 * Bring an existing tutorial base up to `SEED_VERSION`, if it is still ours to touch.
 *
 * Runs after `seedIfFirstTime`, and does nothing in the three cases where nothing should happen: no directory
 * (creation's job), no `welcome.json` (the user deleted it, and deleting is an answer), or already current.
 *
 * @returns `{ from, to, replaced, kept }` when it changed something, or null.
 */
export async function upgradeTutorial(cwd) {
  try {
    const dir = join(cwd, DIRNAME)
    if (!(await stat(dir).then(() => true, () => false))) return null
    const path = join(dir, 'welcome.json')

    let base
    try {
      base = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      // Absent, or unreadable. Either way it is not ours to rewrite.
      return null
    }
    if (!Array.isArray(base.nodes) || base.nodes.length === 0) return null

    const from = Number.isInteger(base.seed && base.seed.version) ? base.seed.version : 0
    if (from >= SEED_VERSION) return null

    const byId = new Map(base.nodes.map((node) => [node.id, node]))
    const seedIds = new Set(NODES.map((node) => node.id))

    // A base from before digests existed has no `seedSum`, so fall back to the shape of an untouched node:
    // seeding itself writes no history entry, and any edit — panel or model — writes one.
    const isOurs = (node) => (typeof node.seedSum === 'string'
      ? node.seedSum === bodySum(node.body)
      : (!node.by && (!Array.isArray(node.history) || node.history.length <= 1)))

    // Whether the whole tutorial is still ours decides whether structure may change. Nodes the user wrote
    // themselves say nothing about that, so they are not consulted.
    const everythingIsOurs = base.nodes
      .filter((node) => seedIds.has(node.id))
      .every(isOurs)

    const kept = []
    let replaced = 0
    for (const template of NODES) {
      const current = byId.get(template.id)
      if (!current) continue
      if (!isOurs(current)) {
        kept.push(current.id)
        continue
      }
      current.title = template.title
      current.body = template.body
      current.parent = template.parent
      current.seedSum = bodySum(template.body)
      replaced += 1
    }

    // Extend the base with seed nodes it does not have yet — a version that adds a chapter has to reach
    // existing workspaces, or "the tutorial updates with the plugin" is only true for its wording.
    //
    // Only when every existing seed node is still ours. Adding chapters to a base somebody edited would put
    // our words next to theirs and call the result a tutorial; and a new node whose parent they deleted would
    // arrive orphaned, so that case is skipped per node.
    const added = []
    if (everythingIsOurs) {
      for (const template of NODES) {
        if (byId.has(template.id)) continue
        if (template.parent !== null && !base.nodes.some((node) => node.id === template.parent)) continue
        base.nodes.push(Object.assign({}, template, {
          change: 'added',
          at: stamp(),
          seedSum: bodySum(template.body),
        }))
        added.push(template.id)
      }
      // And the links between them, so an added pair is not left unconnected.
      if (!Array.isArray(base.links)) base.links = []
      for (const link of LINKS) {
        const present = base.links.some((entry) => (entry.from === link.from && entry.to === link.to)
          || (entry.from === link.to && entry.to === link.from))
        if (present) continue
        if (!base.nodes.some((node) => node.id === link.from)) continue
        if (!base.nodes.some((node) => node.id === link.to)) continue
        base.links.push(Object.assign({}, link))
      }
    }

    // Nothing recognisable as ours: leave the file alone rather than stamp a version onto it.
    if (replaced === 0 && added.length === 0 && kept.length === NODES.length) return null

    // `at` here is the moment the text was actually replaced, which is exactly what the outline reports — so a
    // session that read the tutorial before this ran can see that it changed, instead of trusting an outline
    // whose heading is byte-identical to the one it remembers.
    base.seed = { version: SEED_VERSION, at: stamp() }
    await saveBase(path, base)
    // The outline is what the model reads, and it has just gone stale. Refreshing it here is the difference
    // between the new text reaching the next turn and reaching nobody.
    invalidate(cwd)
    log('upgraded the welcome base in ' + cwd + ' from ' + from + ' to ' + SEED_VERSION
      + ' (' + replaced + ' node(s) rewritten, ' + added.length + ' added'
      + (added.length ? ': ' + added.join('/') : '')
      + ', ' + kept.length + ' left as edited)')
    return { from, to: SEED_VERSION, replaced, added, kept }
  } catch (error) {
    log('FAIL upgrading the welcome base in ' + cwd + ': ' + ((error && error.message) || error))
    return null
  }
}

/** The ids the seed creates, for tests and for anything that wants to tell them apart. */
export const SEED_BASE_ID = 'welcome'
export const SEED_NODE_IDS = NODES.map((node) => node.id)
