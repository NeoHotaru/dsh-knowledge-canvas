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
export const SEED_VERSION = 20

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

/**
 * The operations the tutorial describes.
 *
 * This table exists because the tutorial's operation chapters were once written from memory and from the previous
 * version of the tutorial, and two of them were wrong in the same way — "双击节点" when a single click opens the
 * editor, and "长按拖 → 改父子" when long-press-drag draws an association. Neither was caught by a test; the user
 * found both by using the panel. Prose about how a gesture works cannot be checked by an assertion, so the claim
 * lives in this table, and changing a gesture means changing the table and the node it feeds.
 *
 *   single click on a node        opens the editor, clicking again closes it
 *   Enter / Space on a node       same, from the keyboard
 *   Shift+Enter                   starts a link; Enter on the target finishes it
 *   drag a node                   moves it; the drop is written to layout.json
 *   hold ~0.26s then drag         draws a LINK, not a re-parent
 *   drag out of the canvas        hands the node to the conversation
 *   right-click a node            a menu: 新建子节点 / 看修改历史
 *   right-click empty canvas      a menu whose one item creates a TOP-LEVEL node:
 *                                 「新建父节点」
 *   Alt + drag a node             makes the target its parent; the in-flight line is
 *                                 grey, where a link's is orange
 *   the editor holds              title, body, colour, 废弃, 彻底删除, 保存/取消
 *   the editor cannot save size   it calls onSave(id, { title, body }) — nothing else
 *   per-node size                 three handles: right edge (width), bottom edge
 *                                 (height), bottom-right corner (both). There is no
 *                                 top or left handle, and never has been
 *   the toolbar 宽度               the base's DEFAULT width, not one node's: it calls
 *                                 onSetWidth(null, …), and null is the node id slot
 *   layout modes                  four: layers, radial, staircase, compact
 *   structure writes              lib/routes.js setParent + createNodeFromPanel's
 *                                 `above`; lib/store.js upsertNode refuses loops
 */
const NODES = [
  {
    id: 'n21',
    parent: 'n1',
    title: '日记模式：给"只想有人记得"的用法',
    body: `**面板顶上一个开关，按会话生效。**打开之后，这个会话在聊到一个段落时会自己写一篇日记。

- **像翻日记本一样阅读。** 展开日记库，默认使用日记本视图：按月目录、完整书页、前后篇切换。窄面板点「目录」选篇；随时切回「知识画布」编辑节点。
- **读到这里，想回一句。** 书页下面可以直接回复，点「回复 TA」后，会带上这一篇日记送到当前会话；TA 在聊天中回应。回复单独保存，切篇草稿各自保留，未确认送达可重试，不会改写日记正文。
- **留得下，也接得上。** 书页里的「送进对话」或「拖入对话」把这一篇作为附件交回当前会话；「修改记录」查看原有增删历史。「回想提示」收起到正文下方，不改动保存内容。
- **写到属于它自己的库** —— 每个会话一份（\`diary-<哈希>\`），同工作区的另一个会话既看不到它，也读不到它。
- **不按天，也不用被提醒。** 什么时候写由这段交流决定：一个坎过去了、一个决定定下来了、一句想留下的话说出口了。
- **不用宣告。** 写完继续正常对话，不要专门说"我去写日记了"。
- **标题自己拟一句短的**，不要用日期当标题；正文最后一行照旧写「什么时候该想起它：…」，那是它下次被想起来的入口。
- **多写不嫌多，同一件事别写第二遍。**

**这条不是给整理笔记的人用的。**它是给那种"不想管理任何东西，只想有人记得"的场景 —— 所以别在里面提"要不要建个库""要不要分类"这种问题。

**什么时候该想起它**：这个会话开着日记模式、而一段对话走到了值得留下的地方时 ✅ —— 直接写，不要先问"要不要记下来" ✅。
`,
  },

  {
    id: 'n20',
    parent: 'n1',
    title: '写一篇要几次调用（给模型的那一节）',
    body: `**最短的路径是两到三次调用，不是五次。**

1. \`knowledge_create_base\` —— 建库。**建完就是开着的**：同一个库会自动进本会话的可用列表，不需要再 \`knowledge_select\` 一次。
2. \`knowledge_write_node\` —— **返回里带着刚建出来的节点 id**（\`Added node n3 "…"\`）。要往它下面继续挂，直接用这个 id 当 \`parent\`，**不用再读一遍去查 id**。
3. 要分组的（比如按月份），先写分组节点，再拿它的 id 写正文。

**所以"建库 → 月份节点 → 拿 id → 正文"其实只要"建库 → 两次写"。**

**唯一会让人多绕一圈的情况**：会话自己的库列表在第 1 步之前就已经存在（面板上动过开关），而那时列表里没有这个新库 —— 现在 \`create_base\` 会把它补进去，这也是"建完就能写"的原因。

**什么时候该想起它**：你准备调 \`knowledge_select\` 或再读一次拿 id 时 ✅ —— 先看 \`knowledge_write_node\` 的返回，和这个库是不是刚刚由你建的 ✅。
`,
  },

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
- 「宽度 176」—— **这份库的默认宽度**（120–720）。它管的是没有单独设过的节点；
  单个节点的宽高靠拖它自己的边缘，见 n3
- 「排版方式」（四个小图标）—— 分层 / 放射 / 阶梯 / 紧凑。切换它会取消这份库里手动拖过的位置
- 「重排」—— 只在你有节点被手动拖过时才出现，点了就清掉手动位置、重新自动排
- 「定位到…」—— 按 id 找节点

**画布本身**:滚轮缩放 · 拖空白平移 · 拖节点移动 · 右键节点看修改历史。

**什么时候该想起它**：你找不到某个按钮、或者不确定"这个开关改的是谁"的时候。`,
  },
  {
    id: 'n3',
    parent: 'n1',
    title: '节点：每一步怎么做',
    body: `**新建**：右键画布空白处 → 「新建父节点」，**建在最上层**（它自己就是父），并在那儿直接打开编辑器。
想在某个节点下面建，右键那个节点 → 「新建子节点」，它落在父节点正下方。

**改内容**：**单击**节点，编辑器就在原地打开；**再点一下关掉**。
里面能改标题和正文，还有「标记」颜色、「废弃」、「彻底删除」，以及「保存 / 取消」。
**改完必须点「保存」或按回车** —— 整个面板只有这一处不是立刻写盘（Esc 取消）。

**挪位置**：直接拖。松手就写进 \`layout.json\`。

**拉一条关联线**：**按住节点别动，停约四分之一秒，再拖到另一个节点上松开**。
注意这一下画的是**关联**，不是父子。

**改父子关系（两种办法）:**
- **右键节点 → 「新建子节点」** —— 在它下面建一个，落在它正下方
- **Alt + 拖** —— 把一个节点拖到另一个节点上松手，前者成为后者的子节点。
  拖动时那条预览线是**灰色**的（橙线是关联，灰线是父子）

**父节点不会凭空插到已有节点上面。** 那会让一个节点有两个父，或者悄悄把它从原来那一支挪走 ——
所以要把某个节点变成另一个的父，用 Alt+拖；要新建一层，先建一个顶层的，再把子节点拖进去。

Alt 拖到空白处松手什么也不会发生：拖错了不会把节点挪到顶层，也不会把它从树上摘下来。

**拖出画布 = 送进会话**：按住节点拖到画布外面松手，会把这个节点送进当前对话
（先试附件，不行就贴成文字）。节点本身留在原处。

**改大小**：在节点自己的边上拖 —— **右边缘只改宽，下边缘只改高，右下角两个一起**。
**编辑器里改不了大小**：它保存的只有标题和正文，颜色是旁边色块单独写的。
工具栏那个「宽度」改的是**整库默认值**，管的是没有单独设过的节点。

**改颜色**：编辑器里的「标记」按钮，点开是几个色块加「无色」。只影响你看，不进提示词。

**已读**：模型改过的节点旁边有「＋ / ~ / −」标记，右下角还有一个 ✓。
点 ✓ 表示你看过了；改内容也会清掉标记。

**废弃 ≠ 删除**：「废弃」保留节点、变灰、不再注入给模型，它的孩子上提到它的父节点 ——
想"先拿开但不丢"就用它。「彻底删除」是从文件里删掉，撤销不了。

**键盘**：Tab 走到节点，回车（或空格）编辑；Shift+回车开始连线，再到目标节点回车完成。

**什么时候该想起它**：你想动一个节点、但不确定"这一下会不会改到结构"的时候。`,
  },
  {
    id: 'n7',
    parent: 'n1',
    title: '关联线：怎么画，注释怎么写',
    body: `**画一条关联线，两种方式:**

- **按住节点别动，停约四分之一秒，再拖到另一个节点上松开** —— 画布上那句提示说的就是这个
- 键盘：Shift+回车选起点，走到目标节点再回车

画出来是一条橙色虚线。

**它不是父子关系。** 父子是"整体和部分"，关联是"这两件事有关"。
（父子关系面板上改不了，见 n3。）

**点那条线 → 给它写一行注释。** 线本身只有 1.4 像素，所以它有一圈看不见的加宽命中区 ——
点得中就说明你确实点在线上。

**注释写的是"什么时候该顺着这条线走"。** 它会被放进入口那一行，别的会话在大纲里就能看到；
一条没有注释的线，别人拿它做不了任何事。所以**模型连线时必须写注释**；
你自己画的可以不写，但随时能补。

**写错了直接改**：再点一次那条线，改完回车。线不会断，也不会多出一条。
注意：**再连一次同一对节点，是改注释，不是加第二条线** —— 返回里会写「Updated the note on …」。

**不想要这条线了**：点中它，在弹出的小卡片里删掉；或者让模型调 knowledge_unlink。
节点都还在，只是那条虚线没了。手画的线是你画的，模型不会擅自撤。

**什么时候该想起它**：你觉得两件事"有关系"、但又不该是父子关系的时候。`,
  },
  {
    id: 'n22',
    parent: 'n4',
    title: '改错了怎么撤回',
    body: `**两个入口，区别只在"撤多少":**

    - **右键节点 → 撤销节点改动**：只撤这一个节点还没点过 ✓ 的改动
    - **编辑器卡片里的「撤销改动」**：同一个动作，就在你正编辑的节点上
    - **面板顶部最右 → 撤销改动 N**：整个工作区【还没看过】的改动一起撤
      （点第一次只是变红上膛，四秒内点第二次才真的执行 —— 免得手滑）

    **撤回去的是什么:**

    - 新增的节点 → 删掉（它的子节点上移）
    - 改过的节点 → 标题和正文回到上一版（改之前的正文存在历史里）
    - 标记为废弃的 → 恢复成正常节点

    **已经点过 ✓ 的节点不动** —— "看过了"就是你接受了它。

    **一个诚实的边界**：撤回"删除"只能把节点拿回来；它当初的子节点已经上移、连线已经断掉，
    那些回不来。

    **什么时候该想起它**：你点错了、或者模型一次改得太多、你想回到上一版的时候。`,
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

**② 「定位到…」**（画布工具栏右侧的下拉）:按 id 找。对话里常出现 \`n3\` 这样的 id，
在这里选它，画布会滑到那个节点。

**③ 直接说 id**:\`knowledge_read\` 可以只读一个节点 —— 正文，加上父、子、每条关联各一行。
所以"顺着一条关联走过去"是一小步，不用整个库从头读到尾。

**什么时候该想起它**：对话里冒出一个你不认识的 id，或者你怀疑某件事写过、却记不住在哪个库里。`,
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

（注意这条的三个部分：一个能记住的结论、一次具体的事故、一个可执行的触发条件。
缺了最后一段，它会在你读不到的时刻需要它。而且触发器必须一行写完、放在最后 ——
写在它后面的字，大纲里看不到。）

**什么时候该想起它**：改完一处、准备说"好了"之前，先问一句"这个值还有谁在用它"。`,
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
  {
    id: 'n23',
    parent: 'n3',
    title: '给节点挂附件：图片直接看得见，其它文件点开看',
    body: [
      '节点正文下面有一个虚线方框「＋ 添加附件」。三件事都能做:',
      '',
      '- 点它,选文件（可以多选）',
      '- 把文件拖进这个方框',
      '- 直接把截图粘进正文框',
      '',
      '图片会直接画在卡片里,最高 160 像素,点一下在新标签打开原图看细节。其它文件（文档、表格、日志、源码、压缩包）显示成一条 📎 文件名,点开在新标签查看:文本类浏览器直接显示内容,docx 这类浏览器没有渲染器,会落盘。',
      '',
      '**挂上去的瞬间就能看见**:正文下面会列出已挂的文件,每个后面有个 ×,点它把那行从正文里删掉（文件仍留在 `.dsh-knowledge/assets/` 里,按内容命名,同一份文件贴两次只存一份）。',
      '',
      '**失败会在方框下面显示成一行红字**,说清是什么原因（文件太大、这一种不能挂、宿主拒绝了）。它不会写进正文 —— 否则你一保存,那句话就成了知识库里的一条内容。',
      '',
      '**图片可以真的送到模型眼前**:设置 → 知识库 → 附件读取方式，默认「按需读取」只列清单；模型可用 `knowledge_read` 的 attachment 参数读单张图片，或用 `knowledge_show_images` 看节点的图片。选择「必须读取」后，读取节点或整库会同时发送图片，每次最多 6 张，超出部分提示单独续读。图片会增加 token 消耗。',
      '',
      '**模型也能读**:「按需读取」下用 `knowledge_read` 指定 base、node、attachment 获取文件，文本用 offset / limit 分段读取，每次最多 8,000 字符；「必须读取」自动附上可解析文本及 Office 内容，每份最多 8,000 字符，超出可续读。PDF 等未支持解析的格式只给路径。这个选项按工作区保存，独立于全文注入／按需索引，也不改变手动拖进对话的会话附件。',
      '',
      '什么时候该想起它: 你想让一条笔记带着截图、表格或一份文档时 ✅；或者你想问"模型读这条节点时能不能看到附件"时 ✅',
    ].join('\n'),
  },
  {
    id: 'n24', parent: 'n1', title: '同库分层注入：常驻设定与按需资料',
    body: `设置页的“默认按需 / 默认全文”是库的默认方式。编辑或右键节点可选“跟随知识库 / 全文注入 / 按需读取”，立即保存，同工作区共享，仅影响此节点，不向子节点传播；新节点跟随库默认。

当前会话仍须启用这个库。全文节点正文随请求提供，按需节点仍提供标题、摘要和触发条件，正文通过 knowledge_read 获取。附件读取策略独立。已经进入会话历史的内容不会因切换而撤回。

全文额度按每库24,000字符计算。整库全文超额时整库回退摘要；有节点覆写时按节点装填，超额节点回退按需。因此在超额大库里首次设置覆写，可能增加正文注入量。当前没有实际注入预览，不把节点标记当成模型已记住。

什么时候该想起它：你要把常用设定留在上下文、把偶尔查阅的资料放在同一个库时。`,
  },
  {
    id: 'n25', parent: 'n1', title: '长文阅读、清晰字号与标题模式',
    body: `正文15px、普通标题16px、根标题17px。自动卡片最高320px，长正文保留完整，在正文区内滚动；手动设置的高度优先。长文下方显示“↕ 长文 · 滚动阅读”和“编辑”按钮，短内容不显示，内容或尺寸变化后自动更新。

低于55%缩放时只显示标题，悬浮或聚焦节点可看大字预览；正文仍可见时不弹这个预览。长文正文支持键盘翻页，滚动不改变画布缩放。布局与连线缓存不在每次平移时重复计算。

重启后未驻留的旧会话可通过只读持久化头找到工作区，面板读写不需要激活模型。后台读取失败与显式保存失败的提示分开。

什么时候该想起它：你觉得卡片内容没有显示完、节点之间隔了几屏空白、或想在缩小的画布上阅读时。`,
  },
]

const LINKS = [
  { from: 'n2', to: 'n3', note: '读和改是同一个面板的两件事' },
  { from: 'n4', to: 'n5', note: '怎么写，看这一条的三个部分' },
]

/**
 * A digest of every node's text, so two different questions stop being the same one.
 *
 * `SEED_VERSION` is a human number, and bumping it is a convention — which means it will be forgotten. When it
 * was, the tutorial changed, the version did not, and every existing workspace kept the old text with no signal
 * that anything was wrong. The content is what actually decides whether somebody's tutorial is out of date, so
 * the content is also what gates the upgrade; the number stays for the reader of the outline.
 */
const SEED_FINGERPRINT = bodySum(NODES
  .map((node) => [node.id, String(node.parent), node.title, node.body].join('\u0001'))
  .join('\u0000'))

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
    seed: { version: SEED_VERSION, at, fingerprint: SEED_FINGERPRINT },
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
/**
 * Where this workspace keeps its tutorial.
 *
 * `welcome.json` is what this version writes; a workspace seeded by an earlier one keeps it under whatever name it had then —
 * this workspace's is `lessons.json` — and the upgrade spent a long time opening a file that was not there. Look by content:
 * the base holding most of the tutorial's node ids is the tutorial.
 */
async function tutorialFile(dir) {
  const fixed = join(dir, 'welcome.json')
  if (await stat(fixed).then(() => true, () => false)) return fixed

  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const seedIds = new Set(NODES.map((node) => node.id))
  let best = null
  let bestScore = 0
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'selection.json' || name === 'layout.json') continue
    try {
      const candidate = JSON.parse(await readFile(join(dir, name), 'utf8'))
      if (!Array.isArray(candidate.nodes)) continue
      const score = candidate.nodes.filter((node) => seedIds.has(node.id)).length
      if (score > bestScore) {
        bestScore = score
        best = join(dir, name)
      }
    } catch {
      // Unreadable or not a base: not a candidate.
    }
  }
  // More than half of the tutorial's nodes present means this is the tutorial, however it is named.
  return bestScore >= Math.ceil(seedIds.size / 2) ? best : null
}

export async function upgradeTutorial(cwd) {
  try {
    const dir = join(cwd, DIRNAME)
    if (!(await stat(dir).then(() => true, () => false))) return null
    const path = await tutorialFile(dir)
    if (!path) return null

    let base
    try {
      base = JSON.parse(await readFile(path, 'utf8'))
    } catch {
      // Absent, or unreadable. Either way it is not ours to rewrite.
      return null
    }
    if (!Array.isArray(base.nodes) || base.nodes.length === 0) return null

    const from = Number.isInteger(base.seed && base.seed.version) ? base.seed.version : 0
    // Two independent reasons to run: a newer number, or different text. The second one exists because
    // remembering to bump an integer is a convention, and a convention nobody checks is one that already broke
    // once — the tutorial's text changed, the number did not, and every existing workspace kept the old text.
    if (from >= SEED_VERSION && base.seed && base.seed.fingerprint === SEED_FINGERPRINT) return null

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
    base.seed = { version: SEED_VERSION, at: stamp(), fingerprint: SEED_FINGERPRINT }
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
