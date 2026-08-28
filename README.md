# smart-contract-audit-toolkit

面向 Hardhat 智能合约项目的内部全审计工具集，打包成 Claude Code 插件分发。包含三个互相独立、可组合使用的 [Dynamic Workflow](https://code.claude.com/docs/en/workflows)：

| Workflow | 找什么 | 证明方式 | 什么时候用 |
|---|---|---|---|
| `smart-contract-audit-pipeline` | 语义类漏洞：重入、权限、精度、预言机、业务逻辑偏差等 10 大专项 | L1 静态扫描 + L2 四角色对抗（🔵审计员/🔴攻击者/🟢修复工程师/⚖️裁判）+ L3 PoC 复现 | 默认入口，合约开发自测通过后、交付业务测试/上线前的内部全审计 |
| `invariant-fuzz-campaign` | 组合型漏洞：多笔调用序列才会触发的状态不一致 | Echidna + Medusa 无边界随机模糊测试 | 核心状态机相关合约较大改动后，或按周（建议）跑一次深度 fuzz |
| `formal-verification-halmos` | 人工指定核心数学模块里的边界反例（AMM 曲线/清算/份额舍入等） | Halmos 有界符号执行 | 核心数学模块新增或改动后、上线前，需要数学级别保证时手动触发 |

## 安装

目标仓库需是 Hardhat 项目（`contracts/`、`test/` 目录结构）。在该仓库的 Claude Code 会话里执行：

```
/plugin marketplace add <你的GitHub账号>/smart-contract-audit-toolkit
/plugin install smart-contract-audit-toolkit@smart-contract-audit-toolkit
```

> Dynamic Workflows 需要 Claude Code v2.1.154 及以上；插件内打包 workflow（本插件依赖的能力）是 2026-08-17 前后随新版本上线的，建议使用当时或更新的 Claude Code 版本。

安装完成后三个工作流可用（按命名空间 `插件名:workflow名` 调用）：

```
/smart-contract-audit-toolkit:smart-contract-audit-pipeline
/smart-contract-audit-toolkit:invariant-fuzz-campaign
/smart-contract-audit-toolkit:formal-verification-halmos
```

也可以直接用自然语言描述审计诉求（如"帮我审计一下合约"），插件自带的 `audit-toolkit-guide` 技能会在语义匹配到相关意图时自动加载，引导选对工作流并拼出合适的参数。

## 前置依赖

三个工作流依赖的外部工具均为可选，脚本会在运行时实地检测：

| 工具 | 用于哪个 workflow | 装不上时的行为 |
|---|---|---|
| slither / aderyn | `smart-contract-audit-pipeline`（L1） | 如实记一条 `severity=Info` 说明工具不可用及原因，不编造扫描结果 |
| echidna / medusa | `invariant-fuzz-campaign` | 返回 `available=false, status=ToolUnavailable` 并说明原因，不伪造 fuzz 结果 |
| halmos | `formal-verification-halmos` | 返回 `result=ToolUnavailable`，不伪造证明结果 |

## 用法示例

```
/smart-contract-audit-toolkit:smart-contract-audit-pipeline
（自动发现本仓库核心合约，跑全套 L1~L4）

/smart-contract-audit-toolkit:smart-contract-audit-pipeline 只审计 contracts/Vault.sol，跳过 L3

/smart-contract-audit-toolkit:invariant-fuzz-campaign
（跑 .audit/invariants.md 里全部未跳过的不变量）

/smart-contract-audit-toolkit:invariant-fuzz-campaign 只跑 INV-01 和 INV-03，只用 echidna

/smart-contract-audit-toolkit:formal-verification-halmos 对 contracts/libraries/MathLib.sol 做 Halmos 证明，重点关注份额舍入精度
```

调用时用自然语言描述意图即可，Claude 会自动解析成脚本内的结构化 `args`。

### 审计元信息与总报告

每轮 `smart-contract-audit-pipeline` 完成后会覆盖生成 `.audit/reports/audit-latest.md`。它包含整体门禁、逐合约发现与 PoC、人工复核事项，以及可选的审查元信息和阶段耗时。

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

## `.audit/` 目录约定

三个工作流共享的持久化状态目录，`smart-contract-audit-pipeline` 的 L1 阶段会在目录不存在时自动建骨架，插件本身不携带模板文件：

- `.audit/invariants.md` —— 不变量清单
- `.audit/false-positives.md` —— 已确认误报库
- `.audit/exemptions.md` —— 书面豁免记录
- `.audit/regression/` —— PoC/反例回归测试永久保留目录
- `.audit/reports/` —— L1 扫描原始报告与 `audit-latest.md` 审计总报告
- `.audit/reports/audit-latest.md` —— 本轮 L1–L4 的整体汇总、门禁、PoC、人工复核项和可选元信息；每次运行覆盖更新

## 免责声明

这是内部全审计辅助流水线，AI 产出的是结构化发现/复核清单，不是最终结论。误报入库、书面豁免、放行测试等决定必须由人签字，AI 不代签。Halmos 在给定边界内没找到反例，不等于"无条件证明安全"；模糊测试"本轮未发现反例"，不等于"数学证明无漏洞"。

## License

MIT，见 [LICENSE](./LICENSE)。
