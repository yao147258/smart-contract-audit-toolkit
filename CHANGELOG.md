# Changelog

本项目的版本变更记录，格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## Unreleased

### ⚠️ Breaking Changes

- **`smart-contract-audit-pipeline` 新增硬前置：没有经人工签字的 `.audit/scope.md` 就无法启动。** 流水线在「准备」阶段、L1 之前执行门禁 `evaluateScopeGate(context)`（纯函数，不调大模型），三条硬性条件任一不满足即早退，返回 `{ error: '审计范围文档未就绪', scopeGate }`：① `.audit/scope.md` 存在且可读；② 第 3 章「信任假设」没有剩余的「⬜ 待人工确认」；③ 文末签字栏的确认人与确认日期都非空。**没有任何参数可以绕过**（不提供 `skipScopeCheck` 之类的开关），且为 fail-closed：上下文 agent 返回空值或结构异常时一律判为不通过。早退时的日志会逐条列出卡在哪几条未确认假设。

  **老用户升级后的迁移动作**（三步，缺一不可）：

  1. 跑 `/smart-contract-audit-toolkit:generate-scope-template` 生成 `.audit/scope.md`（无需任何外部工具）；
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

### Changed

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
