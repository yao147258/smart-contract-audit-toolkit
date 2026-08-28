import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const workflowPath = fileURLToPath(new URL('../workflows/smart-contract-audit-pipeline.js', import.meta.url))
const workflowSource = readFileSync(workflowPath, 'utf8')

const extractPureHelpers = () => {
  const beginMarker = '// ==== BEGIN AUDIT SUMMARY REPORT PURE HELPERS'
  const endMarker = '// ==== END AUDIT SUMMARY REPORT PURE HELPERS ===='
  const beginIdx = workflowSource.indexOf(beginMarker)
  const endIdx = workflowSource.indexOf(endMarker)
  if (beginIdx === -1 || endIdx === -1) throw new Error('哨兵注释不存在')
  const beginNewline = workflowSource.indexOf('\n', beginIdx)
  let code = workflowSource.substring(beginNewline + 1, endIdx)

  // 收集所有 export 的函数名和常量名（包括 const 和 function）
  const exportNames = []
  const exportMatch = [...code.matchAll(/export\s+(?:function|const)\s+(\w+)/g)]
  exportMatch.forEach(m => exportNames.push(m[1]))

  // 也收集 REPORT_STAGE_NAMES（无 export 前缀）
  if (code.includes('const REPORT_STAGE_NAMES')) {
    exportNames.unshift('REPORT_STAGE_NAMES')
  }

  // 移除 export 关键字
  code = code.split('\n').map(line => line.replace(/^export\s+/, '')).join('\n')

  // 末尾追加返回语句
  const exportList = exportNames.join(', ')
  code += `\nreturn { ${exportList} };`

  const wrapper = `
    ${code}
  `
  const result = new Function(wrapper)()
  return result
}

const helpers = extractPureHelpers()
const { REPORT_STAGE_NAMES, normalizeReportMetadata, buildAuditSummaryMarkdown } = helpers

test('normalizeReportMetadata 为缺失字段和阶段填入未提供', () => {
  const metadata = normalizeReportMetadata()

  assert.equal(metadata.startedAt, '未提供')
  assert.equal(metadata.model, '未提供')
  assert.equal(metadata.reviewer, '未提供')
  assert.deepEqual(metadata.stages.map(stage => stage.name), REPORT_STAGE_NAMES)
  assert.equal(metadata.stages[0].duration, '未提供')
})

test('workflow 静态声明固定五阶段并保留顶层返回契约', () => {
  assert.deepEqual(
    [...workflowSource.matchAll(/\{ title: '([^']+)' \}/g)].map(match => match[1]).slice(0, 5),
    REPORT_STAGE_NAMES
  )
  assert.deepEqual(
    [...workflowSource.matchAll(/phase\('([^']+)'\)/g)].map(match => match[1]),
    REPORT_STAGE_NAMES
  )
  assert.doesNotMatch(workflowSource, /runAuditPipeline|workflowResult|export default/)
  assert.match(workflowSource, /return \{\s*l1,\s*perTarget: valid,\s*global: globalReport,\s*\}/)
})

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
