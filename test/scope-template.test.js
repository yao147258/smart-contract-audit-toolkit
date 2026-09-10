import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const workflowPath = fileURLToPath(new URL('../workflows/generate-scope-template.js', import.meta.url))
const workflowSource = readFileSync(workflowPath, 'utf8')

const BEGIN_MARKER = '// ==== BEGIN SCOPE TEMPLATE PURE HELPERS'
const END_MARKER = '// ==== END SCOPE TEMPLATE PURE HELPERS ===='

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
const { buildScopeMarkdown, SCOPE_PATH, scopeArchivePrompt } = helpers

const fullInput = () => ({
  system: {
    overview: '一个单池借贷协议，用户存入 USDC 获得份额，可按健康度借出 ETH。',
    assets: [
      { name: 'USDC', kind: 'ERC20', location: 'Vault 合约余额', description: '用户存入的本金' },
      { name: 'vUSDC 份额', kind: '份额代币', location: '用户钱包', description: '代表对池子的权益' },
    ],
    roles: [
      { role: 'owner', holder: '3/5 多签', description: '协议管理员' },
      { role: '任意用户', holder: 'EOA', description: '存取款与清算发起方' },
    ],
    permissions: [
      { role: 'owner', contract: 'contracts/Vault.sol', functions: ['setFee', 'pause'], note: '无时锁保护' },
    ],
    trustAssumptions: [
      { subject: 'owner (多签)', assumption: '假定不作恶且私钥未泄露', basis: 'needs-human' },
      { subject: 'USDC', assumption: '标准 ERC20，无 fee-on-transfer', basis: 'code-inferred' },
    ],
    inScope: ['contracts/Vault.sol', 'contracts/libraries/MathLib.sol'],
    outOfScope: [{ path: 'contracts/mocks/', reason: '测试替身，非上线代码' }],
  },
  economics: {
    fundsIn: [{ entry: 'deposit()', contract: 'contracts/Vault.sol', description: '用户存入 USDC' }],
    fundsOut: [{ entry: 'withdraw()', contract: 'contracts/Vault.sol', description: '用户赎回本金与收益' }],
    parameters: [{ name: 'feeBps', value: '50', settableBy: 'owner', description: '提取手续费' }],
    mechanisms: [{ name: '清算', description: '健康度低于 1 时任何人可发起清算并获得奖励' }],
    docSources: ['docs/PRD.md'],
    notFound: ['利率曲线参数的来源文档'],
  },
})

test('buildScopeMarkdown 输出五个章节、放行规则说明与人工签字栏', () => {
  const markdown = buildScopeMarkdown(fullInput())

  assert.match(markdown, /## 1\. 系统概述与核心资产/)
  assert.match(markdown, /## 2\. 角色与权限矩阵/)
  assert.match(markdown, /## 3\. 信任假设/)
  assert.match(markdown, /## 4\. 经济模型与资金流/)
  assert.match(markdown, /## 5\. 审计边界/)
  assert.match(markdown, /## 人工签字/)

  // 放行规则必须写在文件里，否则用户对着 pipeline 的早退报错无从下手
  assert.match(markdown, /generate-scope-template/)
  assert.match(markdown, /smart-contract-audit-pipeline/)
  assert.match(markdown, /没有参数可以绕过/)

  // 签字栏两个必填项以空占位出现，等待人工填写
  assert.match(markdown, /\| 确认人 \| （待填写） \|/)
  assert.match(markdown, /\| 确认日期 \| （待填写） \|/)
})

test('buildScopeMarkdown 生成的信任假设一律为待确认状态，依据列区分代码推断与人工判断', () => {
  const markdown = buildScopeMarkdown(fullInput())

  // AI 不代签：即使是代码推断出来的假设，状态列也必须是"待人工确认"
  assert.match(markdown, /\| owner \(多签\) \| 假定不作恶且私钥未泄露 \| 需人工判断 \| ⬜ 待人工确认 \|/)
  assert.match(markdown, /\| USDC \| 标准 ERC20，无 fee-on-transfer \| 代码推断 \| ⬜ 待人工确认 \|/)

  // 第 3 章表格内不得出现任何已确认标记（顶部放行规则里的字面示例除外，那是给人看的填写说明）
  const section = markdown.slice(markdown.indexOf('## 3. 信任假设'), markdown.indexOf('## 4.'))
  assert.ok(!section.includes('✅'), '生成阶段的信任假设表不得出现已确认状态，签字只能由人工完成')
})

test('buildScopeMarkdown 渲染资产、权限矩阵与资金流明细', () => {
  const markdown = buildScopeMarkdown(fullInput())

  assert.match(markdown, /\| USDC \| ERC20 \| Vault 合约余额 \| 用户存入的本金 \|/)
  assert.match(markdown, /\| owner \| contracts\/Vault\.sol \| `setFee`、`pause` \| 无时锁保护 \|/)
  assert.match(markdown, /\| 流入 \| deposit\(\) \| contracts\/Vault\.sol \| 用户存入 USDC \|/)
  assert.match(markdown, /\| 流出 \| withdraw\(\) \| contracts\/Vault\.sol \| 用户赎回本金与收益 \|/)
  assert.match(markdown, /\| feeBps \| 50 \| owner \| 提取手续费 \|/)
  assert.match(markdown, /docs\/PRD\.md/)
  assert.match(markdown, /利率曲线参数的来源文档/)
  assert.match(markdown, /\| contracts\/mocks\/ \| 测试替身，非上线代码 \|/)
})

test('buildScopeMarkdown 在输入为空时输出完整骨架而不是崩溃或留白', () => {
  const markdown = buildScopeMarkdown({})

  assert.match(markdown, /## 3\. 信任假设/)
  assert.match(markdown, /## 人工签字/)
  // 空表必须留下明确的待补充占位行，避免人工以为"这一项不存在"
  assert.match(markdown, /待人工补充/)
  assert.doesNotThrow(() => buildScopeMarkdown(undefined))
})

test('buildScopeMarkdown 转义单元格内的竖线与换行，避免打乱表格结构', () => {
  const markdown = buildScopeMarkdown({
    system: {
      trustAssumptions: [
        { subject: 'a|b', assumption: '第一行\n第二行', basis: 'code-inferred' },
      ],
    },
  })

  assert.match(markdown, /a\\\|b/)
  assert.match(markdown, /第一行<br>第二行/)
})

test('workflow 静态声明固定四阶段并保留顶层 phase 顺序', () => {
  const STAGE_NAMES = ['准备', '系统与角色分析', '经济模型与资金流', '文档生成与保存']
  assert.deepEqual(
    [...workflowSource.matchAll(/\{ title: '([^']+)' \}/g)].map(match => match[1]),
    STAGE_NAMES
  )

  const topLevelPhases = [...workflowSource.matchAll(/^phase\('([^']+)'\)/gm)].map(match => match[1])
  assert.ok(topLevelPhases.length > 0, '顶层至少应有一次 phase() 调用')
  let previousIndex = -1
  for (const name of topLevelPhases) {
    const index = STAGE_NAMES.indexOf(name)
    assert.ok(index > previousIndex, `顶层 phase('${name}') 破坏了阶段的有序子序列关系`)
    previousIndex = index
  }
})

test('scope.md 路径在生成侧与流水线门禁侧保持一致', () => {
  const pipelinePath = fileURLToPath(new URL('../workflows/smart-contract-audit-pipeline.js', import.meta.url))
  const pipelineSource = readFileSync(pipelinePath, 'utf8')
  const declared = pipelineSource.match(/\/\*@export\*\/ const SCOPE_PATH = '([^']+)'/)

  assert.ok(declared, '流水线里必须声明 SCOPE_PATH')
  // 两个 workflow 各自硬编码路径，一旦改一处漏一处，pipeline 会因为找不到文件而永久早退
  assert.equal(declared[1], SCOPE_PATH)
})

test('scopeArchivePrompt 要求把清单原样覆盖写入固定路径并如实返回状态', () => {
  assert.equal(SCOPE_PATH, '.audit/scope.md')

  const prompt = scopeArchivePrompt('# 审计范围\n正文')

  assert.match(prompt, /\.audit\/scope\.md/)
  assert.match(prompt, /围栏/)
  assert.match(prompt, /不得执行/)
  assert.match(prompt, /"status":"Written"/)
  assert.match(prompt, /"status":"Failed"/)
})
