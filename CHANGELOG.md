# Changelog

本项目的版本变更记录，格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## Unreleased

### ⚠️ Breaking Changes

- **`generate-scope-template` 必须显式指定审计范围，不再自动扫描仓库。** `args.contracts` 与 `args.docs` 均为必填（数组或逗号/换行分隔字符串，每项可以是文件或目录；`normalizeDocArgs` 更名为 `normalizePathArgs`）。「准备」阶段新增三道检查，任一不过即早退、不产出文档：① 纯函数 `checkScopeArgs` 检查入参，缺任何一项、整仓（`.`）、通配符、仓库外路径、在线链接、非 `.sol` 合约文件均返回 `{ error: '未指定审计范围', errors, usage }`，不启动任何 agent；② 新增路径核实 agent（只报告文件系统事实）+ 纯函数 `reconcileScopePaths` 对账，路径不存在、agent 漏报、目录内没有 `.sol` / 可读文档时返回 `{ error: '审计范围路径无效', errors }`，目录展开结果只保留确实位于该目录下的合法文件；③ 文档收集后由 `findUnreadableDocs` 检查，任何一份指定文档未读到正文即返回 `{ error: '业务文档无法读取', errors }`。所有分析提示词只针对核实过的合约清单；第 5 章「纳入审计」改由纯函数 `applyScopeBoundary` 按清单直接生成（模型只能从清单中标出排除项），不再由模型给建议。原有的自动查找文档、自动枚举 `contracts/` 分支全部移除。

- **`smart-contract-audit-pipeline` 新增硬前置：没有经人工签字的 `.audit/scope.md` 就无法启动。** 流水线在「准备」阶段、L1 之前执行门禁 `evaluateScopeGate(context)`（纯函数，不调大模型），三条硬性条件任一不满足即早退，返回 `{ error: '审计范围文档未就绪', scopeGate }`：① `.audit/scope.md` 存在且可读；② 第 3 章「信任假设」没有剩余的「⬜ 待人工确认」；③ 文末签字栏的确认人与确认日期都非空。**没有任何参数可以绕过**（不提供 `skipScopeCheck` 之类的开关），且为 fail-closed：上下文 agent 返回空值或结构异常时一律判为不通过。早退时的日志会逐条列出卡在哪几条未确认假设。

  **老用户升级后的迁移动作**（三步，缺一不可）：

  1. 跑 `/smart-contract-audit-toolkit:generate-scope-template`，指定要审计的合约与业务文档，生成 `.audit/scope.md`（无需任何外部工具）；
  2. 人工打开该文件，**逐条**核对第 3 章的信任假设，成立的把状态列从 `⬜ 待人工确认` 改成 `✅ 已确认`（必须是这两个完整字符串，变体不识别），并填写文末「人工签字」栏的确认人与确认日期；
  3. 再跑 `smart-contract-audit-pipeline`。

  升级后第一次跑一定会卡在第 2 步，这是设计意图：L2 语义审计判断"代码行为 ≠ 业务意图"的能力完全取决于它知不知道业务意图，没有经人工签字的信任假设，AI 只能报模式化漏洞，还会把设计上允许的管理员操作误报成漏洞。详见 `docs/generate-scope-guide.md`。

### Added

- 新增第五个 Dynamic Workflow `generate-scope-template`：分析合约的核心资产、角色与权限矩阵、信任假设、经济模型与资金流，生成 `.audit/scope.md`。可选参数 `args.contracts` 限定分析范围；纯 LLM 分析，**不需要任何外部工具**。四个阶段：准备 → 系统与角色分析 → 经济模型与资金流 → 文档生成与保存；内部两个分析 agent（均为 `effort: high`）+ 一个带围栏的归档 agent（防提示词注入，与其他 workflow 的归档一致）。返回 `{ system, economics, pendingAssumptionCount, archive }`，归档做两道纯代码校验（路径必须等于 `.audit/scope.md`；写入长度偏差超过 `max(64, 2%)` 判为疑似被概括或截断并标 `Failed`），写入失败只记录在 `archive` 里，不影响已算出的分析结果。
- 新增 `.audit/scope.md` 产物：五章（系统概述与核心资产 / 角色与权限矩阵 / 信任假设 / 经济模型与资金流 / 审计边界）+ 文末人工签字栏。第 3 章状态列只有 `⬜ 待人工确认` 与 `✅ 已确认` 两个合法值，workflow 生成时**一律填 `⬜`**（包括从代码推断出的假设——签字是人的动作，AI 不代签）；依据列区分 `代码推断` 与 `需人工判断`，两类都需人工签字。仓库内附示例模板 `.audit/scope.md.template`。
- `smart-contract-audit-pipeline` 的 L2 ⚖️裁判角色新增吃 scope 摘要，并新增裁判规则第 0 条：一条发现的攻击前提正是某条已签字确认的信任假设时，移入 `rejectedFindings` 并写明命中了哪条假设；但攻击路径不依赖任何被信任主体（任意人都能发起）时，信任假设不构成拒绝理由——"信任 owner"不覆盖"任意人能冒充 owner"这类权限校验缺陷。设计理由：管理员能做某个操作算不算漏洞完全取决于信任假设，裁判才是做这个取舍的角色。
- 审计总报告 `.audit/reports/audit-latest.md` 的「审查元信息」表新增一行 `| 审计范围文档 | .audit/scope.md（确认人：X，确认日期：Y） |`，缺失时显示"未提供"，用于回答"上线时那版范围文档是谁签的字"。
- 新增使用指南 `docs/generate-scope-guide.md`：范围文档怎么生成、人工签字具体怎么做、为什么代码推断出来的假设也要签字，以及 pipeline 报"审计范围文档未就绪"时的常见卡点与处理方式。
- `smart-contract-audit-pipeline` 新增审计总报告产物 `.audit/reports/audit-latest.md`：汇总全局门禁、L1 扫描结果、逐合约发现与 PoC、人工复核事项，每轮覆盖写入；返回值新增 `archive: { status, path, error }` 字段，归档失败会在日志中告警并如实记录，不影响门禁结论。
- `smart-contract-audit-pipeline` 新增可选参数 `args.metadata`：可传入审查开始/结束时间、总耗时、审查模型、审查人以及各阶段耗时，写入总报告；未传入的字段统一显示为"未提供"，插件不做任何推断。
- `smart-contract-audit-pipeline` 新增 L2 审计留痕：`l2Stage` 按专项记录四个角色的输出与提示词指纹（FNV-1a，`promptFingerprint`），由纯函数 `buildCategoryTrace` 整理成轨迹；总报告每个合约新增「L2 专项执行轨迹」「规格重建」「被裁判拒绝的发现」「去向未登记的候选发现」四个小节，此前被直接丢弃的 rejectedFindings 现在连同拒绝理由可供抽查。
- 新增裁判对账 `reconcileJudgeOutput`（纯代码）：审计员的每条候选发现必须以原标题出现在裁判的确认或拒绝列表之一，找不到的标为"去向未登记"；它与"某专项在某角色环节失败"一起由代码直接写入「人工复核事项」。裁判提示词同步新增对账规则。
- 新增结构化轨迹文件 `.audit/reports/audit-trace-latest.json`，返回值新增 `traceArchive` 字段；与总报告分开归档、分开做异常隔离，失败不影响总报告与门禁。两份归档共用纯函数 `checkArchiveResult` 做路径与长度校验，`archivePrompt` 新增可选的路径与文档名参数。
- 新增表达规范 `PLAIN_LANGUAGE_RULE`，注入 L1、L2 四个角色、L3 PoC、L4 报告与总览的提示词；裁判的 confirmedFindings 新增必填字段 `plainExplanation`（2~3 句大白话说明），在「发现明细」表中单独成列。
- `generate-scope-template` 支持读取业务文档：新增「文档收集」阶段与可选参数 `args.docs`（数组或逗号分隔字符串，`normalizeDocArgs` 规范化）；不指定时自动在 `docs/`、`spec/`、`design/` 等目录和仓库根目录查找。支持 Markdown、TXT、PDF，Word 尝试用 pandoc/解压提取，读不到的文档如实标出原因；从文档提取编号化的业务要求（REQ-xx），系统与角色分析、经济模型两个阶段都会参考。
- 信任假设依据新增 `doc-stated`（渲染为「文档声明（出处）」），新增 `source` 字段记录需求编号与文档章节。
- `generate-scope-template` 新增「文档与代码对照」阶段与 scope.md 第 6 章：每条业务要求给出 一致 / 不一致 / 代码未实现 / 无法判断 结论，并列出代码有、文档未提及的重要行为；纯函数 `reconcileRequirementChecks` 对账，漏掉的条目标为「未核对」。第 6 章不参与放行门禁。返回值新增 `docs`、`docCheck`。
- `smart-contract-audit-pipeline` 的上下文摘要新增第⑥段「文档与代码不一致要点」（读取 scope.md 第 6 章），L2 业务逻辑专项的审计员必须逐条处理其中涉及当前合约的条目。

### Changed

- `generate-scope-template` 产出的 `.audit/scope.md` 改为「少而精、看得懂」：① 从源头压缩条目——信任假设同类合并、最多约 15 条并按影响资金程度排序（超出只告警不截断），权限矩阵同角色同合约合并为一行、不列只读函数，资金入口同类合并，参数只留影响资金或权限的，文档需求提取上限由 60 条降为 30 条；② 第 3 章新增「如果不成立会怎样」「你怎么核对」两列（状态列仍在最后，pipeline 门禁不受影响）；第 6 章「需要关注的条目」新增「这意味着什么」列，「已核对一致的条目」改为紧凑列表；③ 新增「怎么读这份文档」与「附录：术语表」，所有分析 agent 共用 `PLAIN_LANGUAGE_RULE` 写法规则（先大白话、后括号代码名）。示例模板 `.audit/scope.md.template` 同步更新。
- `smart-contract-audit-pipeline` 的「加载审计上下文」agent 从输出纯文本改为输出结构化 JSON（新增 `CONTEXT_SCHEMA`），字段：`scopeExists` / `unconfirmedAssumptions[]` / `scopeConfirmedBy` / `scopeConfirmedAt` / `scopeSummary` / `summary`。改动理由：范围门禁必须靠可被代码检查的字段做判断，不能依赖一段"看起来像确认过了"的自然语言。
- 上下文摘要从四段扩为五段（新增第①段「审计范围与信任假设要点」），字数上限从 800 字提高到 1200 字。
- 上下文 agent 现在优先读 `.audit/scope.md`；若其第 4 章已写明经济模型与资金流，直接采信，不再重复去翻 PRD 类文档。
- 工作流总数由四个增加到五个。推荐的完整顺序：`generate-scope-template` →（人工签字）→ `generate-invariants-template` → `smart-contract-audit-pipeline` → `invariant-fuzz-campaign` → `formal-verification-halmos`。
- 文档同步更新：`README.md`、`skills/audit-toolkit-guide/SKILL.md`、`docs/workflow-details.md`（新增 `## 0. generate-scope-template`，原 0/1/2/3 四节顺延为 1/2/3/4）。
- `meta.phases` 中两个阶段标题更名：`L3 PoC复现` → `L3 PoC 复现`，`L4 复核清单` → `L4 复核与归档`（阶段标题会展示在 UI 上）。

## [0.1.0] - 2026-08-27

### Added

- 首个发布版本，包含三个 Dynamic Workflow：
  - `smart-contract-audit-pipeline`：L1 确定性静态扫描 → L2 LLM 语义审计（四角色对抗×10专项）→ L3 PoC 复现验证 → L4 人工复核清单
  - `invariant-fuzz-campaign`：读取 `.audit/invariants.md`，用 Echidna + Medusa 做长程模糊测试
  - `formal-verification-halmos`：对人工指定的核心数学模块用 Halmos 做有界符号执行证明
- 入口技能 `audit-toolkit-guide`：三工作流定位对比与调用引导
- 单仓库自举 marketplace（`.claude-plugin/marketplace.json`，`source: "./"`）
