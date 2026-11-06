# LongMemEval_S r4b archive (2026-11-05)

Archived evaluation data for a v1 test prototype: Memory Deepsea / DSH adapter snapshot r4b. This folder is a test/run record. It is not a plugin release.

The official LongMemEval question file (`questions.json`) is not in this archive. `full500/dataset-manifest.json` records the cleaned dataset revision `98d7416c24c778c2fee6e6f3006e7a073259d48f` and a hash of that file.

## Headline result

LongMemEval_S cleaned, 500 questions: **468/500 = 93.6%**.

Recorded in `full500/scored.json` (`overall.correct` 468, `overall.total` 500, `overall.accuracy` 0.936). The run completed on 2026-11-05 at 10:35 Asia/Shanghai. `full500/pipeline-status.json` records `at` `2026-11-05T02:35:42.962598+00:00` (2026-11-05T02:35:42Z) and `phase` `complete`.

## Method snapshot

From `full500/scored.json` and `full500/FROZEN-PLAN.md`:

- Archive-only hybrid
- Offline e5-small
- `recallBudgetChars` 16000
- Real plugin archive, search, and read through the DSH model adapter (frozen r4b snapshot, including system-prompt hooks)
- Answer reader: DeepSeek Flash / high
- Judge: DeepSeek Flash / low, using the official `get_anscheck_prompt` verbatim

The official default judge is GPT-4o (`FROZEN-PLAN.md`: GPT-4o 2024-08-06). These numbers are not directly comparable to every public score. `scored.json` states the same limit: the reader and judge differ from GPT-4o-judged vendor reports, and published external comparisons remain reference-only.

## Verification

`full500/verification.json`: **27/27 checks passed** (`passed: true`, `partial: false`). The checks cover plan order, the 458/42 fresh/prior split, one answer and one judgment per question, zero answer and judge failures, the official scorer file hash, judge prompts equal to the official function output, and agreement with `scored.json` (468).

## Fresh and previously used

From `full500/scored.json`:

- Fresh: **430/458**
- Previously used: **38/42**

## Category breakdown

`byOriginalCategory` in `full500/scored.json`:

| Category | Correct / total |
| --- | --- |
| single-session-assistant (ssa) | 56/56 |
| temporal-reasoning | 128/133 |
| multi-session | 115/133 |
| single-session-preference | 26/30 |
| single-session-user (ssu) | 69/70 |
| knowledge-update | 74/78 |

## `full500/`

The full 500-question pass. Use this directory for the headline score.

| File | Role |
| --- | --- |
| `scored.json` | 468/500 = 93.6%, plus fresh/prior and category splits |
| `verification.json` | 27/27 checks passed |
| `pipeline-status.json` | Completed 2026-11-05T02:35:42Z |
| `FROZEN-PLAN.md` | Frozen plan for this pass |
| `dataset-manifest.json` | Dataset revision, order, and 458/42 split |
| `judgments.jsonl` | Per-question judge labels |
| `hypotheses.jsonl` | Per-question hypotheses |
| `answer-status.jsonl` | Answer-pass status |
| `gold-reach-r4b.json` | Gold-reach record for this snapshot |
| `plan.json` | Run plan (`recallBudgetChars` 16000) |
| `stream-status.json` | Stream completion (500 indexed, answered, and judged) |
| `stream-current-plan.json` | Stream plan snapshot |
| `official-scorer-source.json` | Pinned official scorer source |

## `evolution/`

Exploratory smaller runs. These samples must not be presented as the final score. The LongMemEval **20/21** figure was superseded by the full 500.

| File | What it records |
| --- | --- |
| `r3-scored.json` | LoCoMo heldout, hybrid-r3, 14/16 |
| `r4-main-scored.json` | heldout30, full arm, 25/30 |
| `temporal-r4b-scored.json` | 36/36 synthetic temporal. The file scope says this is not a benchmark score. |
| `r5-scored.json` | hybrid-r4b LoCoMo two-run 48/60 = 80%. LongMemEval pilot 20/21 (`earlierR4bAllQuestions`), superseded by the full 500. That pilot entry is an adapted single-judge rubric, not the official LongMemEval evaluator. |
| `r6-scored.json` | Fresh LoCoMo, hybrid-r4b graded 96/120 = 80% |
| `FROZEN-PLAN-R5.md` | Round-5 plan written before that run |

## `evidence/`

`ranking-check.md` and `public-score-sources.md` are self-reported public comparisons. Judges and readers differ. External numbers come from public pages and were not re-run for this archive.

`ranking-check.md` (recorded 2026-11-05) says:

> 外部数字来自各项目公开页面，均为自报，未重跑。

> 我们的 93.6 是适配评分：单次运行，官方提示词原文，但裁判是 DeepSeek，不是官方默认的 GPT-4o。high 档重判为 469/500。

Any comparison table in that note stays there. This README does not add a ranking slogan. The headline result of this archive remains 468/500.

`public-score-sources.md` describes an earlier chart that placed a 21-question sample (20/21) among listed public configurations. That sample is not the full-500 result above.

## 中文

本目录保存 v1 测试原型（Memory Deepsea / DSH 适配器快照 r4b）的评测记录，不是插件发布。官方题目文件 `questions.json` 未收录。

正式结果：LongMemEval_S cleaned 500 题，**468/500 = 93.6%**。完成于 2026-11-05 10:35（Asia/Shanghai）。`full500/pipeline-status.json` 的时间为 2026-11-05T02:35:42Z，阶段为 `complete`。

方法快照：archive-only hybrid，离线 e5-small，`recallBudgetChars` 16000，经 DSH 模型适配器调用真实插件的 archive / search / read。作答为 DeepSeek Flash / high。裁判为 DeepSeek Flash / low，使用官方 `get_anscheck_prompt` 原文。官方默认裁判是 GPT-4o，因此该数字不能与每一项公开成绩直接对比。

校验：`full500/verification.json` 27/27 通过。新题 430/458，先前用过的题 38/42。

原始类别：ssa 56/56，temporal 128/133，multi-session 115/133，preference 26/30，ssu 69/70，knowledge-update 74/78。

`evolution/` 是探索性小样本，不能当作最终分数。其中 LongMemEval 20/21 已被全量 500 题取代。`evidence/` 中的对照来自各项目公开页面，均为自报，阅读器与裁判不同，本存档未重跑。
