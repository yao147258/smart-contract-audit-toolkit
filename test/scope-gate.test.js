import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const workflowPath = fileURLToPath(new URL('../workflows/smart-contract-audit-pipeline.js', import.meta.url))
const workflowSource = readFileSync(workflowPath, 'utf8')

const BEGIN_MARKER = '// ==== BEGIN AUDIT SUMMARY REPORT PURE HELPERS'
const END_MARKER = '// ==== END AUDIT SUMMARY REPORT PURE HELPERS ===='

const extractPureHelpers = () => {
  const beginIdx = workflowSource.indexOf(BEGIN_MARKER)
  const endIdx = workflowSource.indexOf(END_MARKER)
  if (beginIdx === -1 || endIdx === -1) throw new Error('哨兵注释不存在')
  const beginNewline = workflowSource.indexOf('\n', beginIdx)
  let code = workflowSource.substring(beginNewline + 1, endIdx)

  const exportNames = [...code.matchAll(/\/\*@export\*\/\s*(?:function|const)\s+(\w+)/g)].map(m => m[1])
  if (code.includes('const REPORT_STAGE_NAMES')) exportNames.unshift('REPORT_STAGE_NAMES')

  code += `\nreturn { ${exportNames.join(', ')} };`

  return new Function(`'use strict';\n${code}\n`)()
}

const helpers = extractPureHelpers()
const { evaluateScopeGate, buildAuditSummaryMarkdown, SCOPE_PATH } = helpers

const readyContext = () => ({
  scopeExists: true,
  unconfirmedAssumptions: [],
  scopeConfirmedBy: '张三',
  scopeConfirmedAt: '2026-09-01',
  summary: '范围摘要',
})

test('scope.md 不存在时门禁不通过，并指出该运行哪个 workflow', () => {
  const gate = evaluateScopeGate({ ...readyContext(), scopeExists: false })

  assert.equal(gate.pass, false)
  assert.match(gate.reason, /\.audit\/scope\.md/)
  assert.match(gate.reason, /generate-scope-template/)
})

test('存在未人工确认的信任假设时门禁不通过，并逐条列出卡在哪几条', () => {
  const gate = evaluateScopeGate({
    ...readyContext(),
    unconfirmedAssumptions: ['owner (多签)：假定不作恶', 'Chainlink ETH/USD：假定喂价及时准确'],
  })

  assert.equal(gate.pass, false)
  // 只说"有未确认项"等于让人自己去翻文件，必须把条目本身带出来
  assert.match(gate.reason, /owner \(多签\)：假定不作恶/)
  assert.match(gate.reason, /Chainlink ETH\/USD：假定喂价及时准确/)
})

test('签字栏留空时门禁不通过，即使假设已全部标记确认', () => {
  const missingSigner = evaluateScopeGate({ ...readyContext(), scopeConfirmedBy: '' })
  assert.equal(missingSigner.pass, false)
  assert.match(missingSigner.reason, /确认人/)

  const missingDate = evaluateScopeGate({ ...readyContext(), scopeConfirmedAt: '   ' })
  assert.equal(missingDate.pass, false)
  assert.match(missingDate.reason, /确认日期/)
})

test('上下文 agent 返回空值时门禁不通过（fail-closed，不得默认放行）', () => {
  assert.equal(evaluateScopeGate(null).pass, false)
  assert.equal(evaluateScopeGate(undefined).pass, false)
  assert.equal(evaluateScopeGate({}).pass, false)
})

test('范围文档齐备且已签字时门禁通过', () => {
  const gate = evaluateScopeGate(readyContext())

  assert.equal(gate.pass, true)
  assert.equal(gate.reason, '')
})

test('总报告元信息记录本轮审计所依据的范围文档与签字人', () => {
  assert.equal(SCOPE_PATH, '.audit/scope.md')

  const markdown = buildAuditSummaryMarkdown({
    targets: ['contracts/Vault.sol'],
    scope: { confirmedBy: '张三', confirmedAt: '2026-09-01' },
    l1: {},
    perTarget: [],
    global: {},
  })

  assert.match(markdown, /\| 审计范围文档 \| `\.audit\/scope\.md`（确认人：张三，确认日期：2026-09-01） \|/)
})

test('总报告在缺少签字信息时如实显示未提供，不编造签字人', () => {
  const markdown = buildAuditSummaryMarkdown({ targets: [], l1: {}, perTarget: [], global: {} })

  assert.match(markdown, /\| 审计范围文档 \| `\.audit\/scope\.md`（确认人：未提供，确认日期：未提供） \|/)
})
