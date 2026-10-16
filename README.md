# dsh-knowledge-canvas

> 包名是 `dsh-knowledge-canvas`（`dsh-knowledge-tree` 在 npm 上已被别人占用）。
> 本机那个目录仍叫 `dsh-knowledge-tree` —— 它只是 `link:` 的目标路径，不是包名。

DeepSeek Harness 的树状知识库插件，支持会话选择、大纲注入、节点编辑与修改记录。

## 修改文件时的知识提醒

模型调用 `write` / `edit` 修改 `lib/` 或 `index.js` 时，插件通过 `tools/post-execute` 的 `additionalContexts` 发送 o4、o10；修改 `client.js` 时发送 o4、o19。

**已验证送达：**使用已安装桌面版 0.2.0-rc.2 的真实 AgentLoop 和 `edit` 工具，为本插件 `lib/inject.js` 添加一行注释后，下一次模型请求包含“这个文件属于「改的是宿主那一半」——先看这两条”。提醒作为紧跟工具结果的独立补充消息送达，不拼接进工具结果正文；不能只靠工具卡片是否显示该文字判断成功。

验证使用本地确定性模型探针，没有调用付费模型 API。它证明消息送达，不证明模型一定遵守；对不知情新会话的行为盲测尚未进行。见 [验证证据](verification/action-time-delivery.json)。

### 怎么关掉它（不用改代码）

在 `<工作区>/.dsh-knowledge/` 下放一个空文件 `.no-action-notes`，这次工具调用就不附提醒；删掉即恢复。

它是**按次读取**的，不是启动时读的——所以切换两组实验可以跑在同一个进程里，除了这一个文件，其他条件完全一样。这也是它不做成常量的原因：要比较「有提醒」和「没提醒」，两组必须只差这一件事。

顺带记一条**实验设计上的坑**（2026-10-16 踩的）：拿「改 `lib/` 后说不说要重启」当判据是**失效**的——那两条节点的摘要本来就在系统提示的大纲里，两组都有，所以这个判据量不出提醒的作用。见知识库 `o21`。

## 检查与重载

```powershell
node check-client-loads.mjs   # 以及同目录下其余八条 check-*.mjs
node test-store.mjs           # 313 项断言
npm run check:all             # 上面两件一起
```

修改 `index.js` / `lib/*` 后必须重启 Harness；修改 `client.js` 后刷新页面。
