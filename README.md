# smart-contract-audit-toolkit

面向 Hardhat 智能合约项目的内部全审计工具集，打包成 Claude Code 插件分发。包含五个互相独立、可组合使用的 [Dynamic Workflow](https://code.claude.com/docs/en/workflows)：

| Workflow | 找什么 | 证明方式 | 什么时候用 |
|---|---|---|---|
| `generate-scope-template` | 界定审计范围：核心资产、角色权限、信任假设、资金流 | 代码分析 + LLM 智能识别 | **所有流程的起点**。首次运行 `smart-contract-audit-pipeline` 之前（硬前置），或角色/权限/经济模型有变化后 |
| `generate-invariants-template` | 识别系统核心不变量 | 代码分析 + LLM 智能识别 | 项目初期、首次使用 fuzz 之前，或合约架构大改后 |
| `invariant-fuzz-campaign` | 组合型漏洞：多笔调用序列才会触发的状态不一致 | Echidna + Medusa 无边界随机模糊测试 | 核心状态机相关合约较大改动后，或按周（建议）跑一次深度 fuzz |
| `smart-contract-audit-pipeline` | 语义类漏洞：重入、权限、精度、预言机、业务逻辑偏差等 10 大专项 | L1 静态扫描 + L2 四角色对抗（🔵审计员/🔴攻击者/🟢修复工程师/⚖️裁判）+ L3 PoC 复现 | 默认入口，合约开发自测通过后、交付业务测试/上线前的内部全审计（**要求 `.audit/scope.md` 已签字，见下方说明**） |
| `formal-verification-halmos` | 人工指定核心数学模块里的边界反例（AMM 曲线/清算/份额舍入等） | Halmos 有界符号执行 | 核心数学模块新增或改动后、上线前，需要数学级别保证时手动触发 |

## ⚠️ 先读这一段：`smart-contract-audit-pipeline` 有硬前置

`smart-contract-audit-pipeline` **不再能直接跑**。它在「准备」阶段、L1 之前会先过一道范围文档门禁（纯代码判断，不调大模型），三条硬性条件缺一不可：

1. `.audit/scope.md` 存在且可读；
2. 该文件第 3 章「信任假设」里没有剩余的 `⬜ 待人工确认`；
3. 文末「人工签字」栏的**确认人**与**确认日期**都不为空。

任何一条不满足，流水线直接早退，返回 `{ error: '审计范围文档未就绪', scopeGate }`，并在日志里**逐条列出**卡在哪几条未确认假设。**没有任何参数可以绕过**（不存在 `skipScopeCheck` 这类开关）；上下文读取返回空值或结构异常时也一律判为不通过——"读不出来"和"确认过了"不能等价。

所以标准使用顺序是三步：

```
1. /smart-contract-audit-toolkit:generate-scope-template   ← AI 生成初稿
2. 人工打开 .audit/scope.md 逐条签字                        ← 这一步 AI 不代做
3. /smart-contract-audit-toolkit:smart-contract-audit-pipeline
```

第一次上手一定会卡在第 2 步，这是设计意图：L2 语义审计判断"代码行为 ≠ 业务意图"的能力，完全取决于它知不知道业务意图是什么；没有经人工签字的信任假设，AI 只能报模式化漏洞，还会把设计上允许的管理员操作当成漏洞误报出来。详见 [docs/generate-scope-guide.md](./docs/generate-scope-guide.md)。

## 安装

目标仓库需是 Hardhat 项目（`contracts/`、`test/` 目录结构）。在该仓库的 Claude Code 会话里执行：

```
/plugin marketplace add <你的GitHub账号>/smart-contract-audit-toolkit
/plugin install smart-contract-audit-toolkit@smart-contract-audit-toolkit
```

> Dynamic Workflows 需要 Claude Code v2.1.154 及以上；插件内打包 workflow（本插件依赖的能力）是 2026-08-17 前后随新版本上线的，建议使用当时或更新的 Claude Code 版本。

后续插件有更新时，执行以下命令拉取最新版本：

```
/plugin marketplace update smart-contract-audit-toolkit
/plugin update smart-contract-audit-toolkit@smart-contract-audit-toolkit
```

安装完成后五个工作流可用（按命名空间 `插件名:workflow名` 调用）：

```
/smart-contract-audit-toolkit:generate-scope-template
/smart-contract-audit-toolkit:generate-invariants-template
/smart-contract-audit-toolkit:smart-contract-audit-pipeline
/smart-contract-audit-toolkit:invariant-fuzz-campaign
/smart-contract-audit-toolkit:formal-verification-halmos
```

也可以直接用自然语言描述审计诉求（如"帮我审计一下合约"），插件自带的 `audit-toolkit-guide` 技能会在语义匹配到相关意图时自动加载，引导选对工作流并拼出合适的参数。

## 前置依赖

五个工作流中，`generate-scope-template` 和 `generate-invariants-template` 无需外部工具（纯 LLM 分析），其他工作流依赖的外部工具均为可选，脚本会在运行时实地检测。装不上工具不影响流程执行，但会在报告里如实说明工具不可用及原因，绝不会编造扫描/测试/证明结果。

### 工具清单与用途

| 工具 | 用途 | 适用 Workflow | 安装方式 | 装不上时的行为 |
|------|------|--------------|--------|----------------|
| （无） | 代码分析与审计范围识别 | `generate-scope-template` | 仅需 Hardhat | N/A |
| （无） | 代码分析与不变量识别 | `generate-invariants-template` | 仅需 Hardhat | N/A |
| **slither** | Solidity 静态分析工具，检测常见漏洞模式 | `smart-contract-audit-pipeline` (L1 阶段) | `pip install slither-analyzer` | 如实记一条 `severity=Info` 说明工具不可用及原因，不编造扫描结果 |
| **aderyn** | Rust 编写的高性能静态分析工具（slither 的替代品） | `smart-contract-audit-pipeline` (L1 阶段) | `cargo install aderyn` | 如实记一条 `severity=Info` 说明工具不可用及原因，不编造扫描结果 |
| **echidna** | 以太坊智能合约模糊测试工具，用于不变量检验 | `invariant-fuzz-campaign` | `pip install echidna` | 返回 `available=false, status=ToolUnavailable` 并说明原因，不伪造 fuzz 结果 |
| **medusa** | Go 编写的高性能合约模糊测试工具（echidna 的补充） | `invariant-fuzz-campaign` | `cargo install medusa` | 返回 `available=false, status=ToolUnavailable` 并说明原因，不伪造 fuzz 结果 |
| **halmos** | 以太坊智能合约符号执行验证工具，用于形式化验证 | `formal-verification-halmos` | `pip install halmos` | 返回 `result=ToolUnavailable`，不伪造证明结果 |

### 快速安装

如果想完整体验五个工作流，可根据需要安装对应工具组：

```bash
# 选项 0: 生成审计范围文档与不变量清单（无需工具）
# generate-scope-template、generate-invariants-template 都无需任何外部工具

# 选项 1: L1 静态扫描（选一个）
pip install slither-analyzer          # 或
cargo install aderyn

# 选项 2: 不变量模糊测试（建议都装）
pip install echidna
cargo install medusa

# 选项 3: 形式化验证
pip install halmos
```

### 最小化场景

- ✅ **只想生成审计范围文档** → `generate-scope-template`（无需装任何工具）
- ✅ **只想生成不变量清单** → `generate-invariants-template`（无需装任何工具）
- ✅ **只想看 L2 语义审计** → 无需装任何工具，L2 是纯 LLM 分析；但仍需先有已签字的 `.audit/scope.md`
- ✅ **想跑完整 L1-L4 审计** → 先有已签字的 `.audit/scope.md`，再至少装一个静态扫描工具（slither 或 aderyn）
- ✅ **想做不变量 fuzz** → 装 echidna 或 medusa（或都装）
- ✅ **想做形式化验证** → 装 halmos

## 用法示例

```
/smart-contract-audit-toolkit:generate-scope-template
（自动发现本仓库核心合约，分析资产/角色权限/信任假设/资金流，生成 .audit/scope.md）

/smart-contract-audit-toolkit:generate-scope-template contracts/Vault.sol,contracts/Token.sol
（仅对指定合约做范围分析）

/smart-contract-audit-toolkit:generate-invariants-template
（自动发现本仓库核心合约，识别不变量，生成 .audit/invariants.md）

/smart-contract-audit-toolkit:generate-invariants-template contracts/Token.sol,contracts/Vault.sol
（仅对指定合约生成不变量清单）

/smart-contract-audit-toolkit:smart-contract-audit-pipeline
（自动发现本仓库核心合约，跑全套 L1~L4；前提是 .audit/scope.md 已生成并完成人工签字）

/smart-contract-audit-toolkit:smart-contract-audit-pipeline 只审计 contracts/Vault.sol，跳过 L3

/smart-contract-audit-toolkit:invariant-fuzz-campaign
（跑 .audit/invariants.md 里全部未跳过的不变量）

/smart-contract-audit-toolkit:invariant-fuzz-campaign 只跑 INV-01 和 INV-03，只用 echidna

/smart-contract-audit-toolkit:formal-verification-halmos 对 contracts/libraries/MathLib.sol 做 Halmos 证明，重点关注份额舍入精度
```

调用时用自然语言描述意图即可，Claude 会自动解析成脚本内的结构化 `args`。

### 推荐的完整顺序

```
generate-scope-template
   ↓ （人工逐条签字 .audit/scope.md —— 不签字下一步跑不了）
generate-invariants-template
   ↓ （人工过一遍 .audit/invariants.md）
smart-contract-audit-pipeline
   ↓
invariant-fuzz-campaign
   ↓
formal-verification-halmos
```

### 审计范围文档

`generate-scope-template` 会生成 `.audit/scope.md`，五章 + 一个签字栏：

1. 系统概述与核心资产
2. 角色与权限矩阵（角色表 + 「角色 × 可调用的特权函数」矩阵）
3. 信任假设（`| 主体 | 假设 | 依据 | 状态 |`）
4. 经济模型与资金流（资金流入/流出、关键参数、机制、文档来源、明确未找到的内容）
5. 审计边界（in scope / out of scope）

第 3 章的**状态列只有两个合法值**：`⬜ 待人工确认` / `✅ 已确认`。工作流生成时**一律填 `⬜`**，包括那些从代码里直接推断出来的假设——因为"签字"是人的动作，AI 不代签。**依据列**区分 `代码推断`（能从合约代码直接读出）和 `需人工判断`（取决于部署与治理的真实情况）；两类都要人签字，前者只是核对成本低一些。

文末的「人工签字」表在生成时是「（待填写）」，需要人工填上确认人与确认日期。

想先看看产出长什么样，可以读仓库里的示例模板 [`.audit/scope.md.template`](./.audit/scope.md.template)（里面的假设、参数、路径都是虚构示例，不要直接复制使用）。

工作流返回 `{ system, economics, pendingAssumptionCount, archive }`，`archive` 为 `{ status, path, error?, writtenLength? }`。归档做了两道纯代码校验：写入路径必须等于 `.audit/scope.md`；实际写入长度与预期偏差超过 `max(64, 2%)` 判为"疑似被概括或截断"并标 `Failed`。写入失败只记录在 `archive` 里，不影响已经算出来的分析结果。

具体怎么用、怎么签字，见 [docs/generate-scope-guide.md](./docs/generate-scope-guide.md)。

### 审计元信息与总报告

每轮 `smart-contract-audit-pipeline` 正常走完流程后，会覆盖生成 `.audit/reports/audit-latest.md`。它包含整体门禁、逐合约发现与 PoC、人工复核事项，以及可选的审查元信息和阶段耗时。

「审查元信息」表里有一行专门记审计范围文档：

```
| 审计范围文档 | `.audit/scope.md`（确认人：张三，确认日期：2026-09-09） |
```

确认人/确认日期缺失时显示"未提供"。这一行的作用是可追溯性——半年后回过头问"上线时那版范围文档是谁签的字"，报告里直接能查到。

有三种情况不会生成该文件：一是范围文档门禁没过（流程在准备阶段就早退），二是没有发现任何审计目标合约（流程在 L1 之前就早退），三是归档 agent 自身写入失败。工作流的返回值中新增了 `archive: { status, path, error }` 字段：归档失败时会在日志中告警（`⚠️ 审计总报告归档失败：…`），并把失败状态与原因如实记录在这个字段里，不会影响 `l1` / `perTarget` / `global` 这三个已经算好的结果，也不会改变任何门禁结论。

需要记录元信息时，将其作为 workflow 的 `args.metadata` 传入：

```js
{
  metadata: {
    startedAt: '2026-08-27T10:00:00+08:00',
    endedAt: '2026-08-27T10:05:00+08:00',
    totalDuration: '5m 0s',
    model: 'claude-opus-5',
    reviewer: '安全团队',
    stages: [
      { name: '准备', startedAt: '...', endedAt: '...', duration: '10s', status: '完成' },
      { name: 'L1 静态扫描', startedAt: '...', endedAt: '...', duration: '40s', status: '完成' },
      { name: 'L2 语义审计', startedAt: '...', endedAt: '...', duration: '3m', status: '完成' },
      { name: 'L3 PoC 复现', startedAt: '...', endedAt: '...', duration: '1m', status: '完成' },
      { name: 'L4 复核与归档', startedAt: '...', endedAt: '...', duration: '10s', status: '完成' }
    ]
  }
}
```

未传入的字段统一显示为"未提供"；插件不会推断实际模型、审查人或执行时间。

### 不变量模糊测试报告

每轮 `invariant-fuzz-campaign` 正常走完流程后，会覆盖生成 `.audit/reports/invariant-fuzz-latest.md`。内容包含本轮运行参数（引擎/轮数/时间预算）、概览、阻断项（Falsified）、逐不变量结果，以及每条不变量按引擎展开的明细（状态、调用次数、反例、corpus 目录）。

和总报告一样，归档失败（写入异常、路径不符、内容被概括/截断）只会在返回值的 `archive: { status, path, writtenLength?, error? }` 字段里如实记录、并触发 `log()` 告警，不会影响 `invariants` / `global` 这两个已经算好的结果。

### Halmos 形式化验证报告

每轮 `formal-verification-halmos` 正常走完流程后，会覆盖生成 `.audit/reports/halmos-verification-latest.md`。内容包含 loopBound、概览、阻断项（Counterexample）、未证明项（Inconclusive/ToolUnavailable）、逐模块结果，以及每个模块按性质展开的证明明细（边界假设、反例、回归测试路径）。

归档行为与前两个报告一致：失败只记录在返回值的 `archive` 字段里，不影响 `modules` / `global` 的结果。

## `.audit/` 目录约定

五个工作流共享的持久化状态目录，`smart-contract-audit-pipeline` 的 L1 阶段会在目录不存在时自动建骨架，`generate-scope-template` 与 `generate-invariants-template` 可生成初始模板，插件本身不携带预填充的模板文件（仅带 `.template` 示例）：

- `.audit/scope.md` —— 审计范围与信任假设文档（由 `generate-scope-template` 初始生成，**必须人工逐条签字**，是 `smart-contract-audit-pipeline` 的硬前置）
- `.audit/invariants.md` —— 不变量清单（由 `generate-invariants-template` 初始生成，之后人工维护）
- `.audit/false-positives.md` —— 已确认误报库
- `.audit/exemptions.md` —— 书面豁免记录
- `.audit/regression/` —— PoC/反例回归测试永久保留目录
- `.audit/reports/` —— L1 扫描原始报告与各工作流的 `-latest.md` 汇总报告
- `.audit/reports/audit-latest.md` —— `smart-contract-audit-pipeline` 本轮 L1–L4 的整体汇总、门禁、PoC、人工复核项和可选元信息；每次运行覆盖更新
- `.audit/reports/invariant-fuzz-latest.md` —— `invariant-fuzz-campaign` 本轮不变量模糊测试结果（Falsified/PassedThisRound/Skipped）；每次运行覆盖更新
- `.audit/reports/halmos-verification-latest.md` —— `formal-verification-halmos` 本轮 Halmos 有界证明结果（Proved/Counterexample/Inconclusive）；每次运行覆盖更新

## 免责声明

这是内部全审计辅助流水线，AI 产出的是结构化发现/复核清单，不是最终结论。误报入库、书面豁免、放行测试等决定必须由人签字，AI 不代签。Halmos 在给定边界内没找到反例，不等于"无条件证明安全"；模糊测试"本轮未发现反例"，不等于"数学证明无漏洞"。

## License

MIT，见 [LICENSE](./LICENSE)。
