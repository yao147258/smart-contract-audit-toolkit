import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const workflowPath = fileURLToPath(new URL('../workflows/invariant-fuzz-campaign.js', import.meta.url))
const workflowSource = readFileSync(workflowPath, 'utf8')

const BEGIN_MARKER = '// ==== BEGIN INVARIANT FUZZ REPORT PURE HELPERS'
const END_MARKER = '// ==== END INVARIANT FUZZ REPORT PURE HELPERS ===='

const extractPureHelpers = () => {
  const beginIdx = workflowSource.indexOf(BEGIN_MARKER)
  const endIdx = workflowSource.indexOf(END_MARKER)
  if (beginIdx === -1 || endIdx === -1) throw new Error('哨兵注释不存在')
  const beginNewline = workflowSource.indexOf('\n', beginIdx)
  let code = workflowSource.substring(beginNewline + 1, endIdx)

  const exportNames = [...code.matchAll(/\/\*@export\*\/\s*(?:function|const)\s+(\w+)/g)].map(m => m[1])

  code += `\nreturn { ${exportNames.join(', ')} };`

  const wrapper = `'use strict';\n${code}\n`
  return new Function(wrapper)()
}

const helpers = extractPureHelpers()
const { buildInvariantFuzzMarkdown, reportArchivePrompt } = helpers

test('buildInvariantFuzzMarkdown 汇总概览、阻断项与逐不变量明细', () => {
  const markdown = buildInvariantFuzzMarkdown({
    runParams: { engines: ['echidna', 'medusa'], rounds: 3, minutesPerRound: 5 },
    global: {
      overview: '1 条不变量被打破，1 条本轮通过',
      falsifiedCount: 1,
      skippedCount: 0,
      blockingItems: ['INV-01（对应 Vault.sol，回归测试 .audit/regression/POC-INV-01.js）'],
    },
    invariants: [
      {
        invariant: { id: 'INV-01', description: '总份额不超过总资产', contract: 'Vault.sol', testEntry: 'echidna_solvency', status: 'FAILED' },
        engineResults: [
          { invariantId: 'INV-01', engine: 'echidna', available: true, status: 'Falsified', roundsRun: 1, totalCallsRun: 4200, counterexample: 'deposit(1) -> withdraw(2) -> ...', corpusPath: '.audit/fuzz-corpus/INV-01' },
          { invariantId: 'INV-01', engine: 'medusa', available: true, status: 'Passed', roundsRun: 3, totalCallsRun: 9000, corpusPath: '.audit/fuzz-corpus/INV-01' },
        ],
        report: { invariantId: 'INV-01', overallStatus: 'Falsified', regressionTestPath: '.audit/regression/POC-INV-01.js', invariantsMdUpdated: true, notes: '需优先修复' },
      },
      {
        invariant: { id: 'INV-02', description: '总负债不超过抵押物', contract: 'Vault.sol', testEntry: 'echidna_collateral', status: '待验证' },
        engineResults: [
          { invariantId: 'INV-02', engine: 'echidna', available: true, status: 'Passed', roundsRun: 3, totalCallsRun: 8800, corpusPath: '.audit/fuzz-corpus/INV-02' },
        ],
        report: { invariantId: 'INV-02', overallStatus: 'PassedThisRound', invariantsMdUpdated: true, notes: '本轮未发现反例' },
      },
    ],
  })

  assert.match(markdown, /# 不变量深度模糊测试报告/)
  assert.match(markdown, /echidna\+medusa/)
  assert.match(markdown, /1 条不变量被打破，1 条本轮通过/)
  assert.match(markdown, /falsifiedCount.*1|Falsified.*1/)
  assert.match(markdown, /INV-01（对应 Vault\.sol/)
  assert.match(markdown, /INV-01/)
  assert.match(markdown, /Vault\.sol/)
  assert.match(markdown, /deposit\(1\) -> withdraw\(2\)/)
  assert.match(markdown, /\.audit\/regression\/POC-INV-01\.js/)
  assert.match(markdown, /PassedThisRound/)
  assert.match(markdown, /本轮未发现反例/)
  assert.match(markdown, /不是数学证明|不代表数学证明|不等于数学证明/)
})

test('buildInvariantFuzzMarkdown 在没有不变量时明确显示"无"而不是留空', () => {
  const markdown = buildInvariantFuzzMarkdown({
    runParams: { engines: ['echidna'], rounds: 3, minutesPerRound: 5 },
    global: { overview: '没有可执行的不变量', falsifiedCount: 0, skippedCount: 0, blockingItems: [] },
    invariants: [],
  })

  assert.match(markdown, /没有可执行的不变量/)
  assert.match(markdown, /无/)
})

test('reportArchivePrompt 要求将报告覆盖写入固定路径并如实返回状态', () => {
  const prompt = reportArchivePrompt('# 示例报告')

  assert.match(prompt, /\.audit\/reports\/invariant-fuzz-latest\.md/)
  assert.match(prompt, /覆盖/)
  assert.match(prompt, /不得编造/)
  assert.match(prompt, /Written/)
  assert.match(prompt, /Failed/)
})

test('workflow 静态声明固定四阶段并保留顶层 phase 顺序', () => {
  const REPORT_STAGE_NAMES = ['准备', '装置生成', 'Fuzz长跑', '结果归档']
  assert.deepEqual(
    [...workflowSource.matchAll(/\{ title: '([^']+)' \}/g)].map(match => match[1]),
    REPORT_STAGE_NAMES
  )

  const topLevelPhases = [...workflowSource.matchAll(/^phase\('([^']+)'\)/gm)].map(match => match[1])
  assert.ok(topLevelPhases.length > 0, '顶层至少应有一次 phase() 调用')
  let previousIndex = -1
  for (const name of topLevelPhases) {
    const index = REPORT_STAGE_NAMES.indexOf(name)
    assert.ok(index > previousIndex, `顶层 phase('${name}') 破坏了阶段的有序子序列关系`)
    previousIndex = index
  }
})
