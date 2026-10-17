/**
 * The base a workspace gets the first time it is used.
 *
 * Two audiences, and the second is the reason this is worth shipping. A person opening the panel for the
 * first time has an empty pane and no idea what a node should contain; the seed answers by being an
 * example. The model has the outline in its prompt, so the same text teaches it what the base is for and
 * — through one node written the way nodes should be written, trigger line included — how to write the
 * next one.
 *
 * Created only when `.dsh-knowledge/` does not exist at all. That is deliberately the narrowest rule:
 * a workspace where the user deleted these bases must not have them reappear, and deleting the whole
 * directory is a legible way to ask for the defaults back.
 */

import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DIRNAME, saveBase } from './store.js'
import { writeSelection } from './state.js'
import { log } from './log.js'

/** Workspaces already checked, so the log gets one line each rather than one per session event. */
const checked = new Set()

const NODES = [
  {
    id: 'n1',
    parent: null,
    title: '这个知识库是什么',
    body: `**一个跟着工作区走的笔记本，模型和你都能读写。**

它不是聊天记录，也不在云端。它在 \`.dsh-knowledge/\` 下，是几个普通的 JSON 文件 ——
你可以用记事本打开、可以提交进 git、可以整个拷走。

**什么时候该想起它**：你想让"这件事我们已经知道过"变成模型下次真的知道的时候。`,
  },
  {
    id: 'n2',
    parent: 'n1',
    title: '怎么读它',
    body: `右侧面板列出所有库。点开一个，看到的是节点树。

**每个节点有一个标题和一段正文。** 正文支持加粗、行内代码和代码块。

**模型看到的是大纲加一句要点**，看不到正文 —— 正文要它主动用 \`knowledge_read\` 去取。
取的时候可以整库取，**也可以只取一个节点**：那样它拿到这篇正文，
外加父、子、每条关联各一行摘要 —— 于是"顺着一条关联走过去"是一小步，而不是读整个库。
所以标题要能一眼看懂，要点要不看正文也知道在说什么。

**每条关联线都该带一行注释**，说明什么时候该顺着它走 —— 那一行在大纲里就能看见。

**什么时候该想起它**：你发现模型答得不对，先看它有没有读到这个库。`,
  },
  {
    id: 'n3',
    parent: 'n1',
    title: '怎么改它',
    body: `- 双击节点 → 编辑
- 拖节点 → 换位置；长按拖 → 挪到别的父节点下
- 右键空白处 → 新建节点
- 拖动两个节点之间 → 连一条关联虚线；**点那条线 → 给它写一行注释**
- 节点右上角的小圆点 → 标记颜色
- 拖右下角 → 改宽高；正文太长时框内滚动
- **右键节点 → 看它的修改历史**：每个节点留最近十版，**每一版的正文都在**，
  并且标出这一版相对上一版新增了什么（绿）、上一版之后被删掉了什么（红）。
  卡片太小就点它的「展开 ⤢」，同一份历史会铺满整个面板，返回还在原处
- 顶上那个"定位到…" → 按 id 找到节点，对话里提到 \`n3\` 时能直接跳到它

**你改的每一条都会被标记**（新增 / 修改），模型改的也是 —— 那是给你审的，不是给我看的。

**什么时候该想起它**：模型写了一条你觉得不对的，直接改掉，别只在对话里纠正它。`,
  },
  {
    id: 'n4',
    parent: 'n1',
    title: '模型该往里写什么',
    body: `**写"下次还会用到"的东西**，不要写这次的流水账。

值得写：踩过的坑和它的成因、这个项目特有的约定、一个反复要查的路径或命令。

不值得写：这次做了什么、你要它做什么、还没定的事。

**一条正文的最后一行，用「什么时候该想起它」开头，后面跟一个冒号。**
那一行会被单独取出来放进提示词，成为模型在正确时刻能看见的触发器。

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
    await saveBase(join(dir, 'welcome.json'), {
      version: 1,
      id: 'welcome',
      name: '怎么用这个知识库',
      nodes: NODES.map((node) => Object.assign({}, node, { change: 'added', at })),
      links: LINKS,
    })
    // On, so the model sees it — the point is that both audiences read it.
    await writeSelection(cwd, ['welcome'])
    log('seeded the welcome base for ' + cwd)
    return 'welcome'
  } catch (error) {
    log('FAIL seeding ' + cwd + ': ' + ((error && error.message) || error))
    return null
  }
}

/** The ids the seed creates, for tests and for anything that wants to tell them apart. */
export const SEED_BASE_ID = 'welcome'
export const SEED_NODE_IDS = NODES.map((node) => node.id)
