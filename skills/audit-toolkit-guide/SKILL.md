---
name: audit-toolkit-guide
description: 在智能合约仓库（Hardhat 项目）里做安全审计相关工作时使用——介绍 smart-contract-audit-toolkit 插件自带的三个审计 workflow（确定性静态扫描+LLM语义审计+PoC复现、不变量深度模糊测试、Halmos有界形式化验证）各自解决什么问题、怎么选、怎么调用。调用时如果检测到工具缺失，会自动尝试安装。当用户提到"审计合约""扫描漏洞""fuzz测试""形式化验证""Halmos""Echidna""不变量"等诉求时应加载本技能。
---

# smart-contract-audit-toolkit 使用指南

本插件提供三个互相独立、可组合使用的审计 workflow，覆盖三种不同的"找漏洞"方式。选错工具是最常见的误用——先看下面的定位表，再决定调用哪一个。

## 三个工作流怎么选

| Workflow | 命名空间调用 | 找什么 | 证明方式 | 什么时候用 |
|---|---|---|---|---|
| `invariant-fuzz-campaign` | `/smart-contract-audit-toolkit:invariant-fuzz-campaign` | 组合型漏洞：多笔调用序列才会触发的状态不一致 | Echidna + Medusa 无边界随机模糊测试（抽样，不是证明） | 核心状态机相关合约有较大改动后，或按周期（建议每周）跑一次深度 fuzz；不适合每个 PR 都跑（太慢） |
| `smart-contract-audit-pipeline` | `/smart-contract-audit-toolkit:smart-contract-audit-pipeline` | 语义类漏洞：重入、权限、精度、预言机、业务逻辑偏差等 10 大专项 | L1 静态扫描 + L2 四角色对抗（🔵审计员/🔴攻击者/🟢修复工程师/⚖️裁判）+ L3 PoC 复现 | 默认入口。合约开发自测通过后、交付业务测试/上线前的内部全审计；也可用 `targets` 做增量审计 |
| `formal-verification-halmos` | `/smart-contract-audit-toolkit:formal-verification-halmos` | 人工指定的核心数学模块（AMM 曲线、清算/健康度、份额舍入等）里的边界反例 | Halmos 有界符号执行（在给定边界内穷尽，不是无条件证明） | 核心数学模块新增或改动后、上线前，人工判断某个公式类模块需要数学级别保证时手动触发；`modules` 必须显式指定，不做自动发现 |

三者的证明力度依次递增（抽样 → 语义分析+局部PoC证明 → 有界穷尽证明），但覆盖范围和运行成本也依次增加，互不替代，可以在同一轮发布前依次都跑一遍。

## 调用示例

不需要理解底层 JSON 结构，直接用自然语言描述诉求即可，Claude 会解析成脚本内 `args`。**首次调用时如果检测到工具缺失，会自动尝试安装**（如果装不上会如实说明原因）。

```
/smart-contract-audit-toolkit:smart-contract-audit-pipeline
（自动发现本仓库核心合约，跑全套 L1~L4；如果没装 slither/aderyn 会自动安装）

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

三个 workflow 依赖的外部工具均为可选，脚本会在运行时实地检测。**如果检测到工具缺失，会自动尝试安装**；装不上会在报告里如实说明工具不可用及原因，绝不会编造扫描/测试/证明结果。

| 工具 | 用途 | 适用 Workflow | 安装方式 | 自动安装命令 |
|------|------|--------------|--------|------------|
| **slither** | Solidity 静态分析工具，检测常见漏洞模式 | `smart-contract-audit-pipeline` (L1 阶段) | `pip install slither-analyzer` | ✅ 自动执行 |
| **aderyn** | Rust 编写的高性能静态分析工具（slither 的替代品） | `smart-contract-audit-pipeline` (L1 阶段) | `cargo install aderyn` | ✅ 自动执行 |
| **echidna** | 以太坊智能合约模糊测试工具，用于不变量检验 | `invariant-fuzz-campaign` | `pip install echidna` | ✅ 自动执行 |
| **medusa** | Go 编写的高性能合约模糊测试工具（echidna 的补充） | `invariant-fuzz-campaign` | `cargo install medusa` | ✅ 自动执行 |
| **halmos** | 以太坊智能合约符号执行验证工具，用于形式化验证 | `formal-verification-halmos` | `pip install halmos` | ✅ 自动执行 |

### 工作流与工具的对应关系

| Workflow | 必需工具 | 备选工具 | 都缺失时的行为 |
|----------|---------|--------|---------------|
| `smart-contract-audit-pipeline` | slither 或 aderyn（至少一个） | — | 如实记一条 `severity=Info` 说明工具不可用及原因，L1 阶段降级处理 |
| `invariant-fuzz-campaign` | echidna 或 medusa（至少一个） | — | 返回 `available=false, status=ToolUnavailable` 并说明原因，不伪造 fuzz 结果 |
| `formal-verification-halmos` | halmos | — | 返回 `result=ToolUnavailable`，不伪造证明结果 |

### 最小化场景（不需要手动安装工具）

- ✅ **只想看 L2 语义审计** → 无需任何工具，L2 是纯 LLM 分析
- ✅ **其他工作流** → 脚本自动检测并安装缺失工具

## `.audit/` 目录约定

三个 workflow 共享的持久化状态目录，`smart-contract-audit-pipeline` 的 L1 阶段会在目录不存在时自动建骨架：

- `.audit/invariants.md` —— 不变量清单（`invariant-fuzz-campaign` 的输入，也被 L2 审计引用降噪）
- `.audit/false-positives.md` —— 已确认误报库
- `.audit/exemptions.md` —— 书面豁免记录
- `.audit/regression/` —— PoC/反例回归测试永久保留目录
- `.audit/reports/` —— L1 扫描原始报告与三个工作流各自的 `-latest.md` 汇总报告
- `.audit/reports/audit-latest.md` —— 本轮 L1–L4 的整体汇总、门禁、PoC、人工复核项和可选元信息；每次运行覆盖更新
- `.audit/reports/invariant-fuzz-latest.md` —— `invariant-fuzz-campaign` 本轮不变量模糊测试结果（概览、阻断项、逐不变量+逐引擎明细）；每次运行覆盖更新
- `.audit/reports/halmos-verification-latest.md` —— `formal-verification-halmos` 本轮 Halmos 有界证明结果（概览、阻断项、未证明项、逐模块+逐性质明细）；每次运行覆盖更新

三个 workflow 都会在正常走完流程后生成对应的 `-latest.md` 报告；`smart-contract-audit-pipeline` 的审查时间、模型、审查人和阶段耗时仅在调用方显式通过 `args.metadata` 传入时记录，未传入的一律显示"未提供"。三份报告的归档状态都会体现在各自返回值的 `archive: { status, path, error? }` 字段里——写入失败不会影响其余已计算好的审计/测试/证明结果。

## 重要边界

这是内部全审计辅助流水线，AI 产出的是结构化发现/复核清单，不是最终结论。误报入库、书面豁免、放行测试等决定必须由人签字，AI 不代签。Halmos 在给定边界内没找到反例，不等于"无条件证明安全"；模糊测试"本轮未发现反例"，不等于"数学证明无漏洞"。
