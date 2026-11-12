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
const { evaluateScopeGate, buildAuditSummaryMarkdown, SCOPE_PATH, parseScopeDocument, CONFIRMED_MARK } = helpers

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

const sampleScopeMarkdown = ({ rows = [['owner', '假定不作恶', CONFIRMED_MARK]], confirmedBy = '张三', confirmedAt = '2026-09-01' } = {}) => `# 审计范围与信任假设

## 3. 信任假设

| 主体 | 假设 | 如果不成立会怎样 | 你怎么核对 | 依据 | 状态 |
|---|---|---|---|---|---|
${rows.map(r => `| ${r[0]} | ${r[1]} | 占位 | 占位 | 需人工判断 | ${r[2]} |`).join('\n')}

## 4. 经济模型与资金流

占位

## 人工签字

| 项目 | 值 |
|---|---|
| 确认人 | ${confirmedBy || '（待填写）'} |
| 确认日期 | ${confirmedAt || '（待填写）'} |
| 确认范围 | 本文件第 3 章的全部信任假设 |

---
本文件由 AI 生成初稿。
`

test('parseScopeDocument：文件不存在时 scopeExists 为 false，不解析任何内容', () => {
  assert.deepEqual(
    parseScopeDocument({ exists: false, content: '' }),
    { scopeExists: false, unconfirmedAssumptions: [], scopeConfirmedBy: '', scopeConfirmedAt: '', parseError: '' }
  )
  assert.deepEqual(
    parseScopeDocument(null),
    { scopeExists: false, unconfirmedAssumptions: [], scopeConfirmedBy: '', scopeConfirmedAt: '', parseError: '' }
  )
})

test('parseScopeDocument：全部信任假设已确认且签字栏完整时返回就绪状态', () => {
  const parsed = parseScopeDocument({ exists: true, content: sampleScopeMarkdown() })
  assert.equal(parsed.scopeExists, true)
  assert.deepEqual(parsed.unconfirmedAssumptions, [])
  assert.equal(parsed.scopeConfirmedBy, '张三')
  assert.equal(parsed.scopeConfirmedAt, '2026-09-01')
  assert.equal(parsed.parseError, '')
})

test('parseScopeDocument：收集状态列仍为待确认的信任假设，格式为"主体：假设"', () => {
  const parsed = parseScopeDocument({ exists: true, content: sampleScopeMarkdown({
    rows: [['owner', '假定不作恶', '⬜ 待人工确认'], ['Chainlink', '假定喂价准确', CONFIRMED_MARK]],
  }) })
  assert.deepEqual(parsed.unconfirmedAssumptions, ['owner：假定不作恶'])
})

test('parseScopeDocument：状态列的全角空格与多余空白不影响判定（容错，但不放宽判定标准）', () => {
  const fullWidth = parseScopeDocument({ exists: true, content: sampleScopeMarkdown({ rows: [['owner', '假定不作恶', '✅　已确认']] }) })
  assert.deepEqual(fullWidth.unconfirmedAssumptions, [])

  const padded = parseScopeDocument({ exists: true, content: sampleScopeMarkdown({ rows: [['owner', '假定不作恶', `  ${CONFIRMED_MARK}  `]] }) })
  assert.deepEqual(padded.unconfirmedAssumptions, [])

  // 变体 emoji（如 ☑）不被接受——宁可误判为未确认，也不能放宽标准导致误判为已确认
  const variant = parseScopeDocument({ exists: true, content: sampleScopeMarkdown({ rows: [['owner', '假定不作恶', '☑ 已确认']] }) })
  assert.deepEqual(variant.unconfirmedAssumptions, ['owner：假定不作恶'])
})

test('parseScopeDocument：签字栏仍是占位符时 confirmedBy/confirmedAt 为空字符串', () => {
  const parsed = parseScopeDocument({ exists: true, content: sampleScopeMarkdown({ confirmedBy: '', confirmedAt: '' }) })
  assert.equal(parsed.scopeConfirmedBy, '')
  assert.equal(parsed.scopeConfirmedAt, '')
})

test('parseScopeDocument：第 3 章表格或人工签字表解析不出时记录 parseError（结构被破坏不能等同于已签字）', () => {
  const noChapter3 = parseScopeDocument({ exists: true, content: '# 文档\n\n## 4. 经济模型\n\n占位\n' })
  assert.match(noChapter3.parseError, /第 3 章/)

  const noSignoff = parseScopeDocument({ exists: true, content: sampleScopeMarkdown().replace(/## 人工签字[\s\S]*/, '') })
  assert.match(noSignoff.parseError, /人工签字/)
})

test('evaluateScopeGate：parseScopeDocument 报告 parseError 时门禁不通过', () => {
  const gate = evaluateScopeGate({
    scopeExists: true,
    unconfirmedAssumptions: [],
    scopeConfirmedBy: '张三',
    scopeConfirmedAt: '2026-09-01',
    parseError: '未能解析出第 3 章「信任假设」的表格内容，文档结构可能被破坏',
  })
  assert.equal(gate.pass, false)
  assert.match(gate.reason, /解析失败/)
})
