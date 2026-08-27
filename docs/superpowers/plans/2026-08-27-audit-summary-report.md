# 审计总报告归档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `smart-contract-audit-pipeline` 在每轮完成后自动生成可阅读、可追溯的 `.audit/reports/audit-latest.md`，汇总审计结果、门禁、PoC、人工复核事项和可选执行元信息。

**Architecture:** 在 workflow 中新增一个独立的归档 agent。它只读取已经结构化产出的 L1、逐合约 L4 和全局报告，按固定 Markdown 结构写入目标仓库的 `.audit/reports/audit-latest.md`。workflow 自身不调用非确定性时间 API；元信息由可选 `args.metadata` 提供，缺失时明确显示“未提供”。

**Tech Stack:** Claude Code Dynamic Workflows（JavaScript）、Node.js 内置测试运行器、Markdown。

**Spec:** 本对话中已确认的 bounded 设计：自动归档最终 Markdown 报告，顶部包含审查时间、模型、审查人、总耗时和各阶段耗时；未提供的字段不得估算或伪造。

## Global Constraints

- 目标文件固定为 `.audit/reports/audit-latest.md`，每轮覆盖更新该“最新”报告。
- 不得使用 `Date.now()`、无参数 `new Date()` 或推断式身份信息生成审计元数据。
- 元信息只接受调用方的 `args.metadata`：`startedAt`、`endedAt`、`totalDuration`、`model`、`reviewer`、`stages`；缺失显示“未提供”。
- 每个 `stages` 项采用 `{ name, startedAt, endedAt, duration, status }`；报告按“准备、L1 静态扫描、L2 语义审计、L3 PoC 复现、L4 复核与归档”固定顺序显示，缺失的阶段填“未提供”。
- 报告只陈述真实的结构化输出；明确标记 `NeedsPoC`、`Suspected`、跳过的 L3 和人工待复核项，且保留“非最终放行结论”的免责声明。
- 归档 agent 失败不得改变 L1/L4 门禁逻辑；必须通过 `log()` 明确警告，返回值保留 `archive` 状态而不是静默吞掉。
- 不运行真实的安全审计、安装扫描器或创建真实 `.audit/` 记录来验证本功能。

---

### Task 1: 定义并测试元信息规范化与 Markdown 报告内容

**Files:**
- Create: `test/audit-summary-report.test.js`
- Modify: `workflows/smart-contract-audit-pipeline.js`

**Interfaces:**
- Consumes: 现有 L1 结构 `{ highCount, mediumCount, lowCount, findings, toolsAvailable, gatePass }`、单合约 L4 结构 `{ target, gate, confirmedFindings, pocResults, report }`、全局结构 `{ overview, readyForDelivery, blockingItems, perTargetGate }`。
- Produces: 导出的纯函数 `normalizeReportMetadata(metadata)`，返回 `{ startedAt, endedAt, totalDuration, model, reviewer, stages }`；导出的纯函数 `buildAuditSummaryMarkdown({ metadata, targets, categories, skipL3, l1, perTarget, global })`，返回完整 Markdown 字符串。

- [ ] **Step 1: 写入失败测试，定义缺省元信息与固定阶段顺序**

在 `test/audit-summary-report.test.js` 中使用 Node 内置测试运行器，先从 workflow 导入尚不存在的函数并写入：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReportMetadata } from '../workflows/smart-contract-audit-pipeline.js'

test('normalizeReportMetadata 为缺失字段和阶段填入未提供', () => {
  const metadata = normalizeReportMetadata()

  assert.equal(metadata.startedAt, '未提供')
  assert.equal(metadata.model, '未提供')
  assert.equal(metadata.reviewer, '未提供')
  assert.deepEqual(
    metadata.stages.map(stage => stage.name),
    ['准备', 'L1 静态扫描', 'L2 语义审计', 'L3 PoC 复现', 'L4 复核与归档']
  )
  assert.equal(metadata.stages[0].duration, '未提供')
})
```

- [ ] **Step 2: 运行测试，确认因导出函数不存在而失败**

Run: `node --test test/audit-summary-report.test.js`

Expected: FAIL，错误指出 `normalizeReportMetadata` 不是 workflow 的导出成员或未定义；不得因为测试语法错误失败。

- [ ] **Step 3: 以最小实现通过元信息规范化测试**

在 `workflows/smart-contract-audit-pipeline.js` 的常量区域定义：

```js
const REPORT_STAGE_NAMES = [
  '准备',
  'L1 静态扫描',
  'L2 语义审计',
  'L3 PoC 复现',
  'L4 复核与归档',
]

function displayValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '未提供'
}

export function normalizeReportMetadata(metadata = {}) {
  const suppliedStages = Array.isArray(metadata.stages) ? metadata.stages : []
  return {
    startedAt: displayValue(metadata.startedAt),
    endedAt: displayValue(metadata.endedAt),
    totalDuration: displayValue(metadata.totalDuration),
    model: displayValue(metadata.model),
    reviewer: displayValue(metadata.reviewer),
    stages: REPORT_STAGE_NAMES.map(name => {
      const supplied = suppliedStages.find(stage => stage && stage.name === name) || {}
      return {
        name,
        startedAt: displayValue(supplied.startedAt),
        endedAt: displayValue(supplied.endedAt),
        duration: displayValue(supplied.duration),
        status: displayValue(supplied.status),
      }
    }),
  }
}
```

不要新增任何时间获取逻辑。

- [ ] **Step 4: 重新运行元信息测试，确认通过**

Run: `node --test test/audit-summary-report.test.js`

Expected: PASS，1 个测试通过。

- [ ] **Step 5: 写入失败测试，定义报告必须包含的整体结果与审计语义**

在同一测试文件追加：

```js
import { buildAuditSummaryMarkdown } from '../workflows/smart-contract-audit-pipeline.js'

test('buildAuditSummaryMarkdown 汇总门禁、发现、PoC 和人工复核项', () => {
  const markdown = buildAuditSummaryMarkdown({
    metadata: {
      startedAt: '2026-08-27T10:00:00+08:00',
      endedAt: '2026-08-27T10:05:00+08:00',
      totalDuration: '5m 0s',
      model: 'claude-opus-5',
      reviewer: '安全团队',
      stages: [{ name: 'L1 静态扫描', duration: '30s', status: '完成' }],
    },
    targets: ['contracts/Vault.sol'],
    categories: [{ key: 'reentrancy', label: '重入攻击' }],
    skipL3: false,
    l1: {
      toolsAvailable: ['slither'], highCount: 0, mediumCount: 1, lowCount: 0,
      findings: [{ file: 'contracts/Vault.sol', severity: 'Medium', tool: 'slither', title: '外部调用', description: '检查外部调用', location: 'withdraw()' }],
      gatePass: true,
    },
    perTarget: [{
      target: 'contracts/Vault.sol',
      gate: { l1HighZero: true, criticalHighCount: 1, evidenceComplete: true, gatePass: true },
      confirmedFindings: [{ title: '重入风险', severity: 'High', status: 'NeedsPoC', impact: '资金损失', likelihood: '中', attackPath: '调用 withdraw', minimalPatch: '增加状态更新' }],
      pocResults: [{ findingTitle: '重入风险', status: 'Confirmed', iterations: 2, testPath: 'test/poc/reentrancy.js', evidence: '余额差分成立' }],
      report: { summary: '需要人工复核', openItemsForHuman: ['确认多签控制人'], suggestedFalsePositiveEntries: ['确认某项误报理由'] },
    }],
    global: { overview: '存在一条待验证高危发现', readyForDelivery: true, blockingItems: [], perTargetGate: [{ target: 'contracts/Vault.sol', gatePass: true }] },
  })

  assert.match(markdown, /# 智能合约审计总报告/)
  assert.match(markdown, /审查模型 \| claude-opus-5/)
  assert.match(markdown, /审查人 \| 安全团队/)
  assert.match(markdown, /L1 静态扫描 \| 未提供 \| 未提供 \| 30s \| 完成/)
  assert.match(markdown, /readyForDelivery \| 是/)
  assert.match(markdown, /重入风险/)
  assert.match(markdown, /NeedsPoC/)
  assert.match(markdown, /余额差分成立/)
  assert.match(markdown, /确认多签控制人/)
  assert.match(markdown, /不是最终放行结论/)
})
```

- [ ] **Step 6: 运行测试，确认因报告生成函数不存在而失败**

Run: `node --test test/audit-summary-report.test.js`

Expected: FAIL，只因 `buildAuditSummaryMarkdown` 未导出或未定义而失败。

- [ ] **Step 7: 实现最小的纯 Markdown 渲染函数**

在 workflow 中新增 `export function buildAuditSummaryMarkdown(input)`。函数必须：

```js
const metadata = normalizeReportMetadata(input.metadata)
```

并返回由字符串数组 `lines` 拼接的 Markdown。至少生成以下区段及字段：

```md
# 智能合约审计总报告

> 本报告由内部 AI 审计流水线生成，用于人工复核；不是最终放行结论。

## 审查元信息
| 元信息 | 值 |
|---|---|
| 审查开始时间 | ... |
| 审查结束时间 | ... |
| 总耗时 | ... |
| 审查模型 | ... |
| 审查人 | ... |
| 审计范围 | `contracts/Vault.sol` |
| L2 专项 | 重入攻击（reentrancy） |
| L3 PoC | 已执行 |

## 各阶段执行耗时
| 阶段 | 开始时间 | 结束时间 | 耗时 | 状态 |
```

随后按 `metadata.stages` 输出每行。再输出：`## 全局结论与门禁`、`## L1 静态扫描`、`## 逐合约审计结果`、`## 人工复核事项`、`## 免责声明`。

表格与列表应保留 L1 发现、confirmedFindings（包括 status）、PoC 的 testPath/evidence、`openItemsForHuman`、`suggestedFalsePositiveEntries` 与 `blockingItems`。空集合必须明确显示“无”。使用一个 `markdownCell(value)` 辅助函数把 `|` 替换为 `\\|`、换行替换为 `<br>`，避免源数据破坏表格。

- [ ] **Step 8: 重新运行全部报告生成测试，确认通过**

Run: `node --test test/audit-summary-report.test.js`

Expected: PASS，2 个测试通过。

- [ ] **Step 9: 提交本任务**

```bash
git add workflows/smart-contract-audit-pipeline.js test/audit-summary-report.test.js
git commit -m "feat: add audit summary report renderer"
```


### Task 2: 将渲染结果可靠归档到审计目标仓库

**Files:**
- Modify: `workflows/smart-contract-audit-pipeline.js`
- Modify: `test/audit-summary-report.test.js`

**Interfaces:**
- Consumes: `buildAuditSummaryMarkdown(input)` 的字符串结果以及主流程中的 `l1`、`valid`、`globalReport`。
- Produces: workflow 返回值中的 `archive`：`{ status: 'Written'|'Failed', path: '.audit/reports/audit-latest.md', error?: string }`。

- [ ] **Step 1: 写入失败测试，规定归档提示词的路径、覆盖行为和失败可见性**

为可测试性，在 workflow 中先定义并导出一个纯提示词构造函数。追加测试：

```js
import { archivePrompt } from '../workflows/smart-contract-audit-pipeline.js'

test('archivePrompt 要求将最终报告覆盖写入固定路径并如实返回状态', () => {
  const prompt = archivePrompt('# 示例报告')

  assert.match(prompt, /\.audit\/reports\/audit-latest\.md/)
  assert.match(prompt, /覆盖写/)
  assert.match(prompt, /不得编造/)
  assert.match(prompt, /写入成功后.*Written/)
  assert.match(prompt, /写入失败.*Failed/)
})
```

- [ ] **Step 2: 运行测试，确认归档提示词函数尚不存在而失败**

Run: `node --test test/audit-summary-report.test.js`

Expected: FAIL，只因 `archivePrompt` 未导出或未定义。

- [ ] **Step 3: 定义归档 schema、提示词与归档调用**

在 workflow 中增加：

```js
const ARCHIVE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', description: 'Written 或 Failed' },
    path: { type: 'string' },
    error: { type: 'string' },
  },
  required: ['status', 'path'],
}

export function archivePrompt(markdown) {
  return `把以下已经生成的审计总报告原样覆盖写入目标仓库的 .audit/reports/audit-latest.md。
若目录不存在，创建 .audit/reports/；不要修改任何其他文件，不要重写或概括报告，不得编造写入成功。
写入成功后返回 {"status":"Written","path":".audit/reports/audit-latest.md"}；写入失败后返回 {"status":"Failed","path":".audit/reports/audit-latest.md","error":"真实失败原因"}。

报告内容：
${markdown}`
}
```

在 `globalReport` 创建后、最终 `return` 前构造输入：

```js
const markdown = buildAuditSummaryMarkdown({
  metadata: args && args.metadata,
  targets,
  categories,
  skipL3,
  l1,
  perTarget: valid,
  global: globalReport,
})
const archive = await agent(archivePrompt(markdown), {
  phase: 'L4 复核清单',
  schema: ARCHIVE_SCHEMA,
  label: 'L4-归档总报告',
})
if (!archive || archive.status !== 'Written') {
  log(`⚠️ 审计总报告归档失败：${archive && archive.error ? archive.error : '归档 agent 未返回成功状态'}`)
}
```

将 `archive` 置入 workflow 最终返回值。不要让归档失败改变 `globalReport.readyForDelivery`。

- [ ] **Step 4: 重新运行归档提示词测试与完整测试文件，确认通过**

Run: `node --test test/audit-summary-report.test.js`

Expected: PASS，3 个测试通过。

- [ ] **Step 5: 对 workflow 做语法校验**

Run: `node --check workflows/smart-contract-audit-pipeline.js`

Expected: exit code 0。

- [ ] **Step 6: 提交本任务**

```bash
git add workflows/smart-contract-audit-pipeline.js test/audit-summary-report.test.js
git commit -m "feat: archive audit summary report"
```


### Task 3: 记录调用方式与落盘文件

**Files:**
- Modify: `README.md`
- Modify: `skills/audit-toolkit-guide/SKILL.md`

**Interfaces:**
- Consumes: workflow 的 `args.metadata` 合约和 `.audit/reports/audit-latest.md` 归档行为。
- Produces: 用户可复制的调用示例、字段说明和“缺失值为未提供”的数据真实性说明。

- [ ] **Step 1: 在 README 的调用示例后写入元信息调用示例**

在 `README.md` 的 workflow 用法示例后追加以下说明（按仓库当前 Markdown 风格调整）：

```md
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

未传入的字段统一显示为“未提供”；插件不会推断实际模型、审查人或执行时间。
```

- [ ] **Step 2: 更新 `.audit/` 目录约定**

把 README 的 `.audit/reports/` 描述从“L1 扫描原始报告”改为“L1 扫描原始报告与 `audit-latest.md` 审计总报告”。在文件列表中新增：

```md
- `.audit/reports/audit-latest.md` —— 本轮 L1–L4 的整体汇总、门禁、PoC、人工复核项和可选元信息；每次运行覆盖更新
```

- [ ] **Step 3: 在指南中同步最终报告行为与缺失元信息规则**

在 `skills/audit-toolkit-guide/SKILL.md` 的 `.audit/` 目录约定中添加同样的 `audit-latest.md` 文件说明；在“重要边界”前加入一句：

```md
`smart-contract-audit-pipeline` 会生成 `.audit/reports/audit-latest.md`；审查时间、模型、审查人和阶段耗时仅在调用方显式通过 `args.metadata` 传入时记录，未传入的一律显示“未提供”。
```

- [ ] **Step 4: 校验文档中路径与字段一致性**

Run: `rg -n "audit-latest\.md|args\.metadata|未提供" README.md skills/audit-toolkit-guide/SKILL.md workflows/smart-contract-audit-pipeline.js`

Expected: 三处均出现 `audit-latest.md`；README 与指南均说明 `args.metadata` 和“未提供”。

- [ ] **Step 5: 运行全量验证**

Run: `node --test test/audit-summary-report.test.js && node --check workflows/smart-contract-audit-pipeline.js`

Expected: 测试全部 PASS，语法校验 exit code 0。

- [ ] **Step 6: 检查最终 diff，确保没有意外真实审计产物**

Run: `git diff --check && git status --short`

Expected: 没有空白错误；仅 `README.md`、`skills/audit-toolkit-guide/SKILL.md`、`workflows/smart-contract-audit-pipeline.js`、`test/audit-summary-report.test.js` 与本计划文件变更；不应产生 `.audit/`、PoC 或扫描工具安装文件。

- [ ] **Step 7: 提交本任务**

```bash
git add README.md skills/audit-toolkit-guide/SKILL.md docs/superpowers/plans/2026-08-27-audit-summary-report.md
git commit -m "docs: document audit summary report"
```
