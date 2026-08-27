import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { meta, normalizeReportMetadata, buildAuditSummaryMarkdown } from '../workflows/smart-contract-audit-pipeline.js'

const workflowPath = pathToFileURL(fileURLToPath(new URL('../workflows/smart-contract-audit-pipeline.js', import.meta.url))).href

const runWithHostStubs = () => new Promise((resolve, reject) => {
  const script = `
    globalThis.events = []
    globalThis.phase = name => events.push(['phase', name])
    globalThis.log = () => {}
    globalThis.args = { targets: ['contracts/Vault.sol'], categories: ['reentrancy'], skipL3: false }
    globalThis.agent = async (prompt, options = {}) => {
      if (options.label === '加载审计上下文') return 'context'
      if (options.label === 'L1-全量扫描') return { toolsAvailable: [], highCount: 0, mediumCount: 0, lowCount: 0, findings: [], gatePass: true }
      if (options.label.startsWith('L2-审计员:')) return { category: 'reentrancy', target: 'contracts/Vault.sol', candidateFindings: [] }
      if (options.label.startsWith('L2-攻击者:')) return { category: 'reentrancy', target: 'contracts/Vault.sol', candidateFindings: [], attackPaths: [] }
      if (options.label.startsWith('L2-修复工程师:')) return { category: 'reentrancy', target: 'contracts/Vault.sol', candidateFindings: [], attackPaths: [], patches: [] }
      if (options.label.startsWith('L2-裁判:')) return { category: 'reentrancy', target: 'contracts/Vault.sol', confirmedFindings: [], rejectedFindings: [] }
      if (options.label.startsWith('L4-报告:')) return { target: 'contracts/Vault.sol', summary: '无发现' }
      if (options.label === 'L4-总报告') return { overview: '无发现', readyForDelivery: true, blockingItems: [], perTargetGate: [{ target: 'contracts/Vault.sol', gatePass: true }] }
      throw new Error('unexpected agent: ' + options.label)
    }
    globalThis.pipeline = async (items, ...steps) => {
      let values = items
      for (const step of steps) values = [await step(values[0], items[0])]
      return values
    }
    globalThis.parallel = async tasks => Promise.all(tasks.map(task => task()))
    const module = await import(${JSON.stringify(workflowPath)})
    const result = await module.default
    console.log(JSON.stringify({ events, result }))
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { env: process.env })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('error', reject)
  child.on('close', code => {
    if (code !== 0) return reject(new Error(stderr || ('child exited ' + code)))
    resolve(JSON.parse(stdout))
  })
})

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

test('meta.phases 使用固定五阶段名称与顺序', () => {
  assert.deepEqual(meta.phases.map(stage => stage.title), [
    '准备', 'L1 静态扫描', 'L2 语义审计', 'L3 PoC 复现', 'L4 复核与归档'
  ])
})

test('宿主桩可观察五阶段调用且获得最终结果', async () => {
  const { events, result } = await runWithHostStubs()
  assert.deepEqual(events.filter(event => event[0] === 'phase').map(event => event[1]), [
    '准备', 'L1 静态扫描', 'L2 语义审计', 'L3 PoC 复现', 'L4 复核与归档'
  ])
  assert.deepEqual(Object.keys(result).sort(), ['global', 'l1', 'perTarget'])
  assert.equal(result.global.readyForDelivery, true)
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
