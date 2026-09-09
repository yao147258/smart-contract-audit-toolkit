---
name: audit-toolkit-guide
description: 在智能合约仓库（Hardhat 项目）里做安全审计相关工作时使用——介绍 smart-contract-audit-toolkit 插件自带的五个审计 workflow（审计范围与信任假设文档、不变量清单生成、确定性静态扫描+LLM语义审计+PoC复现、不变量深度模糊测试、Halmos有界形式化验证）各自解决什么问题、怎么选、怎么调用，以及审计流水线的硬前置条件。调用时如果检测到工具缺失，会自动尝试安装。当用户提到"审计合约""扫描漏洞""审计范围""信任假设""fuzz测试""形式化验证""Halmos""Echidna""不变量"等诉求时应加载本技能。
---

# smart-contract-audit-toolkit 使用指南

本插件提供五个互相独立、可组合使用的审计 workflow，覆盖几种不同的"找漏洞"方式。选错工具是最常见的误用——先看下面的定位表，再决定调用哪一个。

## ⚠️ 最重要的一条：审计流水线有硬前置

用户说"审计合约""帮我扫一遍漏洞"时，**不要直接调 `smart-contract-audit-pipeline`**。它在准备阶段会先过一道范围文档门禁（纯代码判断），三条硬性条件缺一不可：

1. `.audit/scope.md` 存在且可读；
2. 该文件第 3 章「信任假设」没有剩余的 `⬜ 待人工确认`；
3. 文末「人工签字」栏的确认人与确认日期都非空。

任一不满足就直接早退，返回 `{ error: '审计范围文档未就绪', scopeGate }`，日志里会逐条列出卡在哪几条未确认假设。**没有任何参数可以绕过**（不存在 `skipScopeCheck` 这类开关）；上下文读不出来时按 fail-closed 判为不通过。

**因此正确的引导方式是**：

- 先看仓库里有没有 `.audit/scope.md`；
- 没有 → 引导用户先跑 `/smart-contract-audit-toolkit:generate-scope-template`，并**明确告诉他生成完还需要人工逐条签字**（把第 3 章的 `⬜ 待人工确认` 改成 `✅ 已确认`，并填写文末签字栏的确认人与确认日期），签完才能跑 pipeline；
- 有但还没签完 → 指出还差哪些条目，让人工补齐，不要替用户改状态列，也不要替用户填签字栏。**AI 不代签**。

## 五个工作流怎么选

| Workflow | 命名空间调用 | 找什么 | 证明方式 | 什么时候用 |
|---|---|---|---|---|
| `generate-scope-template` | `/smart-contract-audit-toolkit:generate-scope-template` | 界定审计范围：核心资产、角色与权限矩阵、信任假设、经济模型与资金流 | 纯 LLM 代码分析（不需要任何外部工具） | **所有流程的起点**。首次跑 `smart-contract-audit-pipeline` 之前（硬前置），或合约角色/权限/经济模型发生变化后 |
| `generate-invariants-template` | `/smart-contract-audit-toolkit:generate-invariants-template` | 识别系统核心不变量，生成 `.audit/invariants.md` | 纯 LLM 代码分析（不需要任何外部工具） | 项目初期、首次跑 `invariant-fuzz-campaign` 之前，或合约架构大改后 |
| `invariant-fuzz-campaign` | `/smart-contract-audit-toolkit:invariant-fuzz-campaign` | 组合型漏洞：多笔调用序列才会触发的状态不一致 | Echidna + Medusa 无边界随机模糊测试（抽样，不是证明） | 核心状态机相关合约有较大改动后，或按周期（建议每周）跑一次深度 fuzz；不适合每个 PR 都跑（太慢） |
| `smart-contract-audit-pipeline` | `/smart-contract-audit-toolkit:smart-contract-audit-pipeline` | 语义类漏洞：重入、权限、精度、预言机、业务逻辑偏差等 10 大专项 | L1 静态扫描 + L2 四角色对抗（🔵审计员/🔴攻击者/🟢修复工程师/⚖️裁判）+ L3 PoC 复现 | 默认入口，但**要求 `.audit/scope.md` 已生成且完成人工签字**。合约开发自测通过后、交付业务测试/上线前的内部全审计；也可用 `targets` 做增量审计 |
| `formal-verification-halmos` | `/smart-contract-audit-toolkit:formal-verification-halmos` | 人工指定的核心数学模块（AMM 曲线、清算/健康度、份额舍入等）里的边界反例 | Halmos 有界符号执行（在给定边界内穷尽，不是无条件证明） | 核心数学模块新增或改动后、上线前，人工判断某个公式类模块需要数学级别保证时手动触发；`modules` 必须显式指定，不做自动发现 |

前两个是"准备类"工作流，产出的是给人看、给人改、给人签字的清单文件，不找漏洞；后三个才是真正找漏洞的，证明力度依次递增（抽样 → 语义分析+局部PoC证明 → 有界穷尽证明），覆盖范围和运行成本也依次增加，互不替代，可以在同一轮发布前依次都跑一遍。

推荐的完整顺序：

```
generate-scope-template →（人工逐条签字 .audit/scope.md）→ generate-invariants-template
  → smart-contract-audit-pipeline → invariant-fuzz-campaign → formal-verification-halmos
```

## 调用示例

不需要理解底层 JSON 结构，直接用自然语言描述诉求即可，Claude 会解析成脚本内 `args`。**首次调用时如果检测到工具缺失，会自动尝试安装**（如果装不上会如实说明原因）。

```
/smart-contract-audit-toolkit:generate-scope-template
（自动发现本仓库核心合约，分析资产/角色权限/信任假设/资金流，生成 .audit/scope.md；无需任何外部工具）

/smart-contract-audit-toolkit:generate-scope-template 只分析 contracts/Vault.sol 和 contracts/Token.sol

/smart-contract-audit-toolkit:generate-invariants-template
（自动发现本仓库核心合约，识别不变量，生成 .audit/invariants.md；无需任何外部工具）

/smart-contract-audit-toolkit:smart-contract-audit-pipeline
（自动发现本仓库核心合约，跑全套 L1~L4；如果没装 slither/aderyn 会自动安装。
  前提：.audit/scope.md 已生成且完成人工签字，否则准备阶段直接早退）

/smart-contract-audit-toolkit:smart-contract-audit-pipeline 只审计 contracts/Vault.sol，跳过 L3，加快速度

/smart-contract-audit-toolkit:invariant-fuzz-campaign
（跑 .audit/invariants.md 里全部未跳过的不变量，echidna+medusa 各3轮；如果缺工具会自动安装）

/smart-contract-audit-toolkit:invariant-fuzz-campaign 只跑 INV-01 和 INV-03，只用 echidna

/smart-contract-audit-toolkit:formal-verification-halmos 对 contracts/libraries/MathLib.sol 做 Halmos 证明，重点关注份额舍入精度
（如果没装 halmos 会自动安装）
```

## 前提条件

- 目标仓库需是 Hardhat 项目（`contracts/`、`test/` 目录结构）。
- Dynamic Workflows 需要 Claude Code v2.1.154 及以上；插件内打包 workflow（本插件依赖的能力）是 2026-08-17 前后随新版本上线的，建议使用当时或更新的 Claude Code 版本。

## 前置工具清单

`generate-scope-template` 和 `generate-invariants-template` 是纯 LLM 分析，**不需要任何外部工具**。另外三个 workflow 依赖的外部工具均为可选，脚本会在运行时实地检测。**如果检测到工具缺失，会自动尝试安装**；装不上会在报告里如实说明工具不可用及原因，绝不会编造扫描/测试/证明结果。

| 工具 | 用途 | 适用 Workflow | 安装方式 | 自动安装命令 |
|------|------|--------------|--------|------------|
| （无） | 代码分析，纯 LLM | `generate-scope-template`、`generate-invariants-template` | 仅需 Hardhat | N/A |
| **slither** | Solidity 静态分析工具，检测常见漏洞模式 | `smart-contract-audit-pipeline` (L1 阶段) | `pip install slither-analyzer` | ✅ 自动执行 |
| **aderyn** | Rust 编写的高性能静态分析工具（slither 的替代品） | `smart-contract-audit-pipeline` (L1 阶段) | `cargo install aderyn` | ✅ 自动执行 |
| **echidna** | 以太坊智能合约模糊测试工具，用于不变量检验 | `invariant-fuzz-campaign` | `pip install echidna` | ✅ 自动执行 |
| **medusa** | Go 编写的高性能合约模糊测试工具（echidna 的补充） | `invariant-fuzz-campaign` | `cargo install medusa` | ✅ 自动执行 |
| **halmos** | 以太坊智能合约符号执行验证工具，用于形式化验证 | `formal-verification-halmos` | `pip install halmos` | ✅ 自动执行 |

### 工作流与工具的对应关系

| Workflow | 必需工具 | 备选工具 | 都缺失时的行为 |
|----------|---------|--------|---------------|
| `generate-scope-template` | 无 | — | N/A（纯 LLM 分析） |
| `generate-invariants-template` | 无 | — | N/A（纯 LLM 分析） |
| `smart-contract-audit-pipeline` | slither 或 aderyn（至少一个） | — | 如实记一条 `severity=Info` 说明工具不可用及原因，L1 阶段降级处理 |
| `invariant-fuzz-campaign` | echidna 或 medusa（至少一个） | — | 返回 `available=false, status=ToolUnavailable` 并说明原因，不伪造 fuzz 结果 |
| `formal-verification-halmos` | halmos | — | 返回 `result=ToolUnavailable`，不伪造证明结果 |

### 最小化场景（不需要手动安装工具）

- ✅ **只想生成审计范围文档 / 不变量清单** → 无需任何工具
- ✅ **只想看 L2 语义审计** → 无需任何工具，L2 是纯 LLM 分析；但仍要求 `.audit/scope.md` 已签字
- ✅ **其他工作流** → 脚本自动检测并安装缺失工具

## `.audit/` 目录约定

五个 workflow 共享的持久化状态目录，`smart-contract-audit-pipeline` 的 L1 阶段会在目录不存在时自动建骨架：

- `.audit/scope.md` —— 审计范围与信任假设文档（由 `generate-scope-template` 生成，**必须人工逐条签字**；是 `smart-contract-audit-pipeline` 的硬前置，也是 L2 裁判角色判断"什么是被允许的行为"的依据）
- `.audit/invariants.md` —— 不变量清单（`invariant-fuzz-campaign` 的输入，也被 L2 审计引用降噪）
- `.audit/false-positives.md` —— 已确认误报库
- `.audit/exemptions.md` —— 书面豁免记录
- `.audit/regression/` —— PoC/反例回归测试永久保留目录
- `.audit/reports/` —— L1 扫描原始报告与三个"找漏洞"工作流各自的 `-latest.md` 汇总报告
- `.audit/reports/audit-latest.md` —— 本轮 L1–L4 的整体汇总、门禁、PoC、人工复核项和可选元信息；每次运行覆盖更新
- `.audit/reports/invariant-fuzz-latest.md` —— `invariant-fuzz-campaign` 本轮不变量模糊测试结果（概览、阻断项、逐不变量+逐引擎明细）；每次运行覆盖更新
- `.audit/reports/halmos-verification-latest.md` —— `formal-verification-halmos` 本轮 Halmos 有界证明结果（概览、阻断项、未证明项、逐模块+逐性质明细）；每次运行覆盖更新

这三个 workflow 都会在正常走完流程后生成对应的 `-latest.md` 报告；`smart-contract-audit-pipeline` 的审查时间、模型、审查人和阶段耗时仅在调用方显式通过 `args.metadata` 传入时记录，未传入的一律显示"未提供"。总报告的「审查元信息」表里还有一行 `| 审计范围文档 | .audit/scope.md（确认人：X，确认日期：Y） |`，缺失时显示"未提供"，用于回答"上线时那版范围文档是谁签的字"。三份报告的归档状态都会体现在各自返回值的 `archive: { status, path, error? }` 字段里——写入失败不会影响其余已计算好的审计/测试/证明结果。

## L2 裁判角色会用信任假设过滤发现

`smart-contract-audit-pipeline` 的 L2 ⚖️裁判角色除了看前三个角色的产出，还会吃一份 `.audit/scope.md` 的要点摘要，并按第 0 条规则先做一次过滤：

- 如果一条发现的攻击前提**正是某条已签字确认的信任假设**（典型如"owner 能调 setFee 抽走手续费"，而范围文档已确认 owner 是可信多签），这条发现会被移入 `rejectedFindings`，并写明命中了哪一条假设；
- 如果攻击路径**不依赖任何被信任的主体**（任意外部账户就能发起），信任假设不构成拒绝理由，继续按后面的规则走查；
- "信任 owner"只覆盖 owner 的合法操作，**不覆盖**"任意人都能冒充 owner"这类权限校验缺陷。

这也是为什么范围文档必须由人签字：管理员能做某个操作到底算不算漏洞，完全取决于信任假设，而裁判才是做这个取舍的角色。信任假设写错或没签字，L2 的结论就不可信。

## 重要边界

这是内部全审计辅助流水线，AI 产出的是结构化发现/复核清单，不是最终结论。误报入库、书面豁免、放行测试、**信任假设确认**等决定必须由人签字，AI 不代签——包括 `.audit/scope.md` 里那些"从代码直接推断出来"的假设，也一律由工作流标成 `⬜ 待人工确认`，等人来改。Halmos 在给定边界内没找到反例，不等于"无条件证明安全"；模糊测试"本轮未发现反例"，不等于"数学证明无漏洞"。
