# 排名口径记录

记录日期 2026-11-05。外部数字来自各项目公开页面，均为自报，未重跑。

## (a) 口径怎么定的

作者决定：「我的标语是和个人开源项目打」。

- 参照系是**个人 / 小团队的开源记忆项目**这一档。公司产品和研究团队项目不计入。
- 排序指标用 LongMemEval_S 500 题的逐题问答准确率，不用 R@5 这类检索召回。
- 「国人开源记忆插件」指中国开发者做的开源项目。

片尾文字：

> 国人开源记忆插件 LongMemEval Benchmark 第一，国际第三

片尾小字：按个人开源项目实施排序，公司/研究团队产品不计入。各项目自报，阅读器与裁判不同。

这一档的结果：

| 名次 | 项目 | 逐题准确率 | 阅读器 | 裁判 | 来源 |
|---|---|---|---|---|---|
| 1 | agentmemory V4 | 96.2%（481/500） | Claude Opus 4.6 | GPT-4o | [README](https://github.com/JordanMcCann/agentmemory) |
| 2 | gitmemory（`rerank12`） | 94.2%（全部500题） | gemini-3.1-pro-preview | gemini-3.1-pro-preview | [E9表3](https://github.com/doronp/gitmemory/blob/main/docs/benchmarks/E9-peer-protocols.md) |
| 3 | **Memory Deepsea r4b** | **93.6%（468/500）** | DeepSeek Flash/high | DeepSeek Flash/low，官方提示词原文 | longmem-full500/verification.json |

与 `longmemeval-full500-context-bilingual.png` 的关系：那张图是另一套参照系，把公司和团队产品一起列出，所以写的是“#6/10，不是全局排名”。个人开源这一档是第三，两者比的范围不同，并不矛盾。纪录片只用个人开源这一档，不使用那张图，避免两个口径混在同一个画面里。

## (b) 项目归属

### 计入：个人 / 小团队开源

| 项目 | 归属依据 | 许可证 | LongMemEval 数字 | 指标 |
|---|---|---|---|---|
| agentmemory V4 | “Built by Jordan McCann with no team, no funding, and no degree” | MIT | 96.20%（481/500） | 问答准确率 |
| gitmemory | MAINTAINERS 仅 Doron（@doronp），affiliation independent | Apache-2.0 | 94.20%；另有 R@5 99.2 | 问答准确率；99.2 是检索指标，不用于排序 |
| Memory Deepsea | 本项目 | 见仓库 | 93.60%（468/500） | 问答准确率 |

### 未进入前三

| 项目 | 情况 | 来源 |
|---|---|---|
| OMEGA | 页面未写明个人或公司，有付费 Pro，核心开源。头条 95.4% 被 agentmemory README 称为按任务加权；466/500 = 93.2%，按逐题口径低于 93.6% | [CITATION.cff](https://github.com/omega-memory/omega-memory/blob/main/CITATION.cff) |
| MemPalace | 只公布 R@5 96.6%，没有问答准确率，无法按本口径排序 | [仓库](https://github.com/MemPalace/mempalace) |
| GoodMemory | README 自报严格 72.0%（360/500），另有 88.8%（444/500）的提示词兼容口径，均低于 93.6%。归属未核实 | [项目索引](https://awesome.ecosyste.ms/projects/github.com%2Fhjqcan%2FGoodMemory) |

### 不计入：公司产品

| 项目 | 归属 | 公开数字 |
|---|---|---|
| ContextStream | 公司 | 96.8 |
| Maximem Synap | 公司 | 95.6 |
| Hindsight | Vectorize | 94.6 |
| Mem0 | 公司，数字为托管平台 | 94.4 |
| Mastra OM | 公司 | 逐题 93.6（468/500）；六类宏平均 94.87 |
| Honcho | Plastic Labs | 90.4 / 92.6（来源不同） |
| Zep | 公司 | 90.2 |
| Supermemory | 公司 | 85.2 |
| MemOS | MemTensor，中国公司 | 89.2 |
| EverOS / EverMemOS | EverMind，中国团队 | 83.0 |

### 不计入：研究团队

| 项目 | 归属 | 公开数字 |
|---|---|---|
| Chronos High | PwC 论文 | 95.6 |
| HeLa-Mem | ACL 2026 论文，5 位作者 | 65.40 |

## 被同行问到时要能回答的三点

1. **agentmemory V4 的数据文件：** README 结果表写“500-case oracle dataset”，运行步骤也检查 `longmemeval_oracle.json`，同页又写 LongMemEval_S，并声明生成时不访问 oracle 字段。排名第一不受影响，但它和我们用的 `longmemeval_s_cleaned` 不一定是同一文件。
2. **gitmemory 的 94.2 是实验配置：** 来自 `rerank12` 这一组实验，作者写明实际发布的版本只有 BM25，这一行也“not directly comparable”。
3. **我们的 93.6 是适配评分：** 单次运行，官方提示词原文，但裁判是 DeepSeek，不是官方默认的 GPT-4o。high 档重判为 469/500。

检索范围内没有发现分数高于 93.6% 的中国开源记忆项目。这只代表本次检索，不是穷尽名单。

## 其他来源

- [ContextStream](https://contextstream.io/benchmarks)
- [Maximem evals](https://www.maximem.ai/evals)
- [Chronos](https://arxiv.org/abs/2603.16862)
- [Mastra OM](https://mastra.ai/research/observational-memory)
- [Mem0 benchmarks](https://github.com/mem0ai/memory-benchmarks)
- [Honcho](https://honcho.dev/evals/)
- [MemOS](https://github.com/MemTensor/MemOS)
- [EverMemOS](https://arxiv.org/abs/2601.02163)
- [HeLa-Mem](https://github.com/ReinerBRO/HeLa-Mem)
