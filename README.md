# dsh-knowledge-tree

DeepSeek Harness 的树状知识库插件，支持会话选择、大纲注入、节点编辑与修改记录。

## 修改文件时的知识提醒

模型调用 `write` / `edit` 修改 `lib/` 或 `index.js` 时，插件通过 `tools/post-execute` 的 `additionalContexts` 发送 o4、o10；修改 `client.js` 时发送 o4、o19。

**已验证送达：**使用已安装桌面版 0.2.0-rc.2 的真实 AgentLoop 和 `edit` 工具，为本插件 `lib/inject.js` 添加一行注释后，下一次模型请求包含“这个文件属于「改的是宿主那一半」——先看这两条”。提醒作为紧跟工具结果的独立补充消息送达，不拼接进工具结果正文；不能只靠工具卡片是否显示该文字判断成功。

验证使用本地确定性模型探针，没有调用付费模型 API。它证明消息送达，不证明模型一定遵守；对不知情新会话的行为盲测尚未进行。见 [验证证据](verification/action-time-delivery.json)。

## 检查与重载

```powershell
cd D:\DeepSeekHarness\dsh-knowledge-tree
npm run check:all
```

修改 `index.js` / `lib/*` 后必须重启 Harness；修改 `client.js` 后刷新页面。
