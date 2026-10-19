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
const {
  buildScopeMarkdown, SCOPE_PATH, scopeArchivePrompt, normalizePathArgs, reconcileRequirementChecks, DOC_CHECK_STATUSES,
  checkScopeArgs, reconcileScopePaths, findUnreadableDocs, applyScopeBoundary,
} = helpers

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
      { subject: 'owner (多签)', assumption: '假定不作恶且私钥未泄露', basis: 'needs-human', impactIfBroken: '管理员可以一次性卷走所有用户存款', howToVerify: '到区块浏览器查 owner 地址是否为 3/5 多签' },
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
  // 每条假设都要讲清"不成立会怎样"和"怎么核对"，状态列固定在最后一列
  assert.match(markdown, /\| 主体 \| 假设 \| 如果不成立会怎样 \| 你怎么核对 \| 依据 \| 状态 \|/)
  assert.match(markdown, /\| owner \(多签\) \| 假定不作恶且私钥未泄露 \| 管理员可以一次性卷走所有用户存款 \| 到区块浏览器查 owner 地址是否为 3\/5 多签 \| 需人工判断 \| ⬜ 待人工确认 \|/)
  // 模型漏填后果/核对方法时给出占位，而不是留空
  assert.match(markdown, /\| USDC \| 标准 ERC20，无 fee-on-transfer \| 待人工补充 \| 待人工补充 \| 代码推断 \| ⬜ 待人工确认 \|/)

  // 第 3 章表格内不得出现任何已确认标记（顶部放行规则里的字面示例除外，那是给人看的填写说明）
  const section = markdown.slice(markdown.indexOf('## 3. 信任假设'), markdown.indexOf('## 4.'))
  assert.ok(!section.includes('✅'), '生成阶段的信任假设表不得出现已确认状态，签字只能由人工完成')
})

test('buildScopeMarkdown 渲染资产、权限矩阵与资金流明细', () => {
  const markdown = buildScopeMarkdown(fullInput())

  assert.match(markdown, /\| USDC \| ERC20 \| Vault 合约余额 \| 用户存入的本金 \|/)
  assert.match(markdown, /\| owner \| contracts\/Vault\.sol \| `setFee`、`pause` \| 无时锁保护 \|/)
  // 已带大白话说明的函数不整段套代码格式
  const plain = buildScopeMarkdown({ system: { permissions: [{ role: 'owner', contract: 'V.sol', functions: ['改手续费（`setFee`）', 'pause'] }] } })
  assert.match(plain, /\| owner \| V\.sol \| 改手续费（`setFee`）、`pause` \|/)
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

test('workflow 静态声明固定六阶段并保留顶层 phase 顺序', () => {
  const STAGE_NAMES = ['准备', '文档收集', '系统与角色分析', '经济模型与资金流', '文档与代码对照', '文档生成与保存']
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

// ---------------------------------------------------------------------------
// 业务文档读取与文档-代码对照
// ---------------------------------------------------------------------------

test('normalizePathArgs 接受数组或逗号/换行分隔字符串，去空去重', () => {
  assert.deepEqual(normalizePathArgs(['docs/a.md', ' docs/b.pdf ', '', 'docs/a.md']), ['docs/a.md', 'docs/b.pdf'])
  assert.deepEqual(normalizePathArgs('docs/a.md, spec/b.md，design/c.pdf\nREADME.md'), ['docs/a.md', 'spec/b.md', 'design/c.pdf', 'README.md'])
  assert.deepEqual(normalizePathArgs(undefined), [])
  assert.deepEqual(normalizePathArgs(42), [])
})

// ---------------------------------------------------------------------------
// 审计范围必须显式指定
// ---------------------------------------------------------------------------

test('checkScopeArgs 合约与文档都必须指定，缺任何一项都不通过并给出用法', () => {
  const ok = checkScopeArgs({ contracts: 'contracts/Vault.sol, contracts/core/', docs: ['docs/PRD.md'] })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.contracts, ['contracts/Vault.sol', 'contracts/core/'])
  assert.deepEqual(ok.docs, ['docs/PRD.md'])
  assert.deepEqual(ok.errors, [])

  for (const args of [undefined, null, {}, { contracts: ['contracts/Vault.sol'] }, { docs: ['docs/PRD.md'] }, { contracts: [], docs: '' }]) {
    const r = checkScopeArgs(args)
    assert.equal(r.ok, false, JSON.stringify(args))
    assert.ok(r.errors.length > 0)
    assert.match(r.usage, /contracts/)
    assert.match(r.usage, /docs/)
  }
  assert.ok(checkScopeArgs({ docs: ['a.md'] }).errors.some(e => /合约/.test(e)))
  assert.ok(checkScopeArgs({ contracts: ['a.sol'] }).errors.some(e => /文档/.test(e)))
})

test('checkScopeArgs 拒绝整仓扫描、越界路径、在线链接与非 .sol 的合约文件', () => {
  for (const bad of ['.', './', '/', '*', 'contracts/**', '../other/A.sol', '/etc/A.sol', 'C:\\x\\A.sol', 'contracts/Vault.js']) {
    const r = checkScopeArgs({ contracts: [bad], docs: ['docs/PRD.md'] })
    assert.equal(r.ok, false, `合约路径 ${bad} 应被拒绝`)
  }
  for (const bad of ['.', 'https://feishu.cn/doc/x', '../PRD.md']) {
    const r = checkScopeArgs({ contracts: ['contracts/Vault.sol'], docs: [bad] })
    assert.equal(r.ok, false, `文档路径 ${bad} 应被拒绝`)
  }
  // 目录（无扩展名或以 / 结尾）是允许的
  assert.equal(checkScopeArgs({ contracts: ['contracts/core', 'src/'], docs: ['docs/'] }).ok, true)
})

test('reconcileScopePaths 展开目录、只保留目录内的合法文件，任何路径有问题都不通过', () => {
  const requested = { contracts: ['contracts/Vault.sol', 'contracts/core/'], docs: ['docs/PRD.md', 'spec'] }
  const good = reconcileScopePaths(requested, {
    entries: [
      { path: 'contracts/Vault.sol', kind: 'contracts', exists: true, type: 'file' },
      { path: 'contracts/core', kind: 'contracts', exists: true, type: 'directory', files: ['contracts/core/A.sol', 'contracts/core/README.md', 'contracts/other/X.sol', 'contracts/core/sub/B.sol'] },
      { path: 'docs/PRD.md', kind: 'docs', exists: true, type: 'file' },
      { path: 'spec/', kind: 'docs', exists: true, type: 'directory', files: ['spec/fee.md', 'spec/img.png', 'spec/v2.pdf'] },
    ],
  })
  assert.equal(good.ok, true, good.errors.join('；'))
  // 目录外的文件（agent 多报的）和非 .sol 文件都要被代码剔除；Vault.sol 去重后只出现一次
  assert.deepEqual(good.contractFiles, ['contracts/Vault.sol', 'contracts/core/A.sol', 'contracts/core/sub/B.sol'])
  assert.deepEqual(good.docFiles, ['docs/PRD.md', 'spec/fee.md', 'spec/v2.pdf'])

  const bad = reconcileScopePaths(requested, {
    entries: [
      { path: 'contracts/Vault.sol', kind: 'contracts', exists: false, reason: '文件不存在' },
      { path: 'contracts/core/', kind: 'contracts', exists: true, type: 'directory', files: ['contracts/core/README.md'] },
      { path: 'docs/PRD.md', kind: 'docs', exists: true, type: 'file' },
    ],
  })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some(e => e.includes('contracts/Vault.sol') && e.includes('文件不存在')))
  assert.ok(bad.errors.some(e => e.includes('contracts/core/') && /\.sol/.test(e)), '目录里没有 .sol 必须报错')
  assert.ok(bad.errors.some(e => e.includes('spec') && /未核实|未返回/.test(e)), 'agent 漏报的路径必须报错')

  // agent 整体失败（null）时全部路径都报错，不能放行
  const none = reconcileScopePaths(requested, null)
  assert.equal(none.ok, false)
  assert.equal(none.errors.length, 4)
})

test('findUnreadableDocs 列出未读到或文档收集 agent 漏报的文档', () => {
  const files = ['docs/PRD.md', 'docs/设计.docx', 'spec/fee.md']
  const problems = findUnreadableDocs(files, {
    documents: [
      { path: 'docs/PRD.md', readable: true },
      { path: 'docs/设计.docx', readable: false, reason: 'pandoc 未安装' },
    ],
  })
  assert.deepEqual(problems.map(p => p.path), ['docs/设计.docx', 'spec/fee.md'])
  assert.match(problems[0].reason, /pandoc/)
  assert.deepEqual(findUnreadableDocs(['docs/PRD.md'], { documents: [{ path: './docs/PRD.md', readable: true }] }), [])
  assert.equal(findUnreadableDocs(files, null).length, 3)
})

test('applyScopeBoundary 由代码决定纳入范围：只含指定合约，排除项只能来自指定范围', () => {
  const system = {
    overview: 'x',
    inScope: ['contracts/Hallucinated.sol'],
    outOfScope: [
      { path: 'contracts/core/IVault.sol', reason: '纯接口' },
      { path: 'lib/openzeppelin/', reason: '第三方' },
    ],
  }
  const result = applyScopeBoundary(system, ['contracts/Vault.sol', 'contracts/core/IVault.sol'])
  assert.deepEqual(result.inScope, ['contracts/Vault.sol'])
  assert.deepEqual(result.outOfScope.map(o => o.path), ['contracts/core/IVault.sol'])
  assert.equal(result.overview, 'x')
  assert.deepEqual(applyScopeBoundary(null, ['a.sol']).inScope, ['a.sol'])
})

test('提示词：不再自动扫描，只处理核实过的合约与文档清单', () => {
  assert.ok(!/自动查找|自动发现|实地枚举 contracts/.test(workflowSource), '不得保留自动扫描分支')
  const bodyOf = name => {
    const start = workflowSource.indexOf(`function ${name}(`)
    assert.notEqual(start, -1, `未找到 ${name}`)
    return workflowSource.slice(start, workflowSource.indexOf('\n}\n', start))
  }
  assert.match(bodyOf('contractScopeBlock'), /只分析这些，不要分析清单之外的合约/)
  for (const name of ['systemAnalysisPrompt', 'economicsPrompt', 'docCheckPrompt']) {
    assert.match(bodyOf(name), /\$\{contractScopeBlock\(contractFiles\)\}/, `${name} 未限定合约范围`)
  }
  assert.match(bodyOf('docCollectionPrompt'), /不得读取清单之外的任何文件/)
  const pathCheck = workflowSource.slice(workflowSource.indexOf('function pathCheckPrompt('))
  assert.match(pathCheck, /git ls-files|ls/)
  assert.match(pathCheck, /exists/)
})

test('主流程：缺参或路径无效时在任何分析 agent 之前早退', () => {
  const main = workflowSource.slice(workflowSource.indexOf("phase('准备')"))
  const argCheck = main.indexOf('checkScopeArgs(args)')
  const firstAgent = main.indexOf('await agent(')
  assert.ok(argCheck > -1 && argCheck < firstAgent, '入参检查必须在第一个 agent 之前')
  assert.match(main, /return \{ error: '未指定审计范围'/)
  assert.match(main, /reconcileScopePaths\(/)
  assert.match(main, /return \{ error: '审计范围路径无效'/)
  assert.match(main, /findUnreadableDocs\(/)
  assert.match(main, /return \{ error: '业务文档无法读取'/)
  assert.match(main, /applyScopeBoundary\(/)
})

test('reconcileRequirementChecks 标出未核对条目并规范不合法的结论', () => {
  const requirements = [
    { id: 'REQ-01', statement: '只有多签能改费率', source: 'docs/PRD.md §2' },
    { id: 'REQ-02', statement: '费率上限 5%', source: 'docs/PRD.md §3' },
    { id: 'REQ-03', statement: '提现 24 小时后到账', source: 'docs/PRD.md §4' },
    { id: '', statement: '无编号条目会被忽略' },
  ]
  const result = reconcileRequirementChecks(requirements, {
    checks: [
      { requirementId: 'REQ-01', status: '不一致', codeBehavior: 'operator 也能改', location: 'Vault.setFee' },
      { requirementId: ' REQ-02 ', status: '基本一致' },
      { requirementId: 'REQ-99', status: '一致' },
    ],
    undocumentedBehaviors: [{ behavior: 'owner 可直接提走全部资金', location: 'Vault.emergencyWithdraw' }, null],
  })
  assert.deepEqual(result.rows.map(r => [r.id, r.status]), [['REQ-01', '不一致'], ['REQ-02', '无法判断'], ['REQ-03', '未核对']])
  assert.equal(result.counts['不一致'], 1)
  assert.equal(result.counts['无法判断'], 1)
  assert.equal(result.counts['未核对'], 1)
  assert.equal(result.counts['一致'], 0, '不存在的编号 REQ-99 不能计入统计')
  assert.equal(result.undocumented.length, 1)
  assert.deepEqual(DOC_CHECK_STATUSES, ['一致', '不一致', '代码未实现', '无法判断'])

  // 对照 agent 失败（null）时全部为未核对
  assert.equal(reconcileRequirementChecks(requirements, null).counts['未核对'], 3)
  assert.deepEqual(reconcileRequirementChecks(null, null).rows, [])
})

test('buildScopeMarkdown 渲染文档声明依据、文档读取情况与第 6 章对照结果', () => {
  const input = fullInput()
  input.system.trustAssumptions.push({ subject: 'owner', assumption: '由 3/5 多签持有', basis: 'doc-stated', source: 'REQ-01，docs/PRD.md §2' })
  input.docs = {
    documents: [
      { path: 'docs/PRD.md', format: 'Markdown', readable: true },
      { path: 'docs/设计.docx', format: 'Word', readable: false, reason: 'pandoc 未安装' },
    ],
  }
  input.docCheck = reconcileRequirementChecks(
    [
      { id: 'REQ-01', statement: '只有多签能改费率', source: 'docs/PRD.md §2' },
      { id: 'REQ-02', statement: '存款无手续费', source: 'docs/PRD.md §3' },
    ],
    {
      checks: [
        { requirementId: 'REQ-01', status: '不一致', codeBehavior: 'operator 也能调用 setFee', risk: '非多签角色可以把手续费调到任意值', location: 'contracts/Vault.sol setFee()' },
        { requirementId: 'REQ-02', status: '一致', location: 'contracts/Vault.sol deposit()' },
      ],
      undocumentedBehaviors: [{ behavior: 'owner 可直接提走全部资金', location: 'Vault.emergencyWithdraw', note: '文档未提及' }],
    }
  )
  const markdown = buildScopeMarkdown(input)

  assert.match(markdown, /\| owner \| 由 3\/5 多签持有 \| 待人工补充 \| 待人工补充 \| 文档声明（REQ-01，docs\/PRD\.md §2） \| ⬜ 待人工确认 \|/)
  assert.match(markdown, /`文档声明`/)
  assert.match(markdown, /- `docs\/PRD\.md`（Markdown）/)
  assert.match(markdown, /⚠️ `docs\/设计\.docx`：未能读取（pandoc 未安装）/)

  assert.match(markdown, /## 6\. 文档与代码对照/)
  assert.match(markdown, /一致 1 条 \/ 不一致 1 条 \/ 代码未实现 0 条 \/ 无法判断 0 条 \/ 未核对 0 条/)
  assert.match(markdown, /\| REQ-01 \| 只有多签能改费率 \| docs\/PRD\.md §2 \| 不一致 \| operator 也能调用 setFee \| 非多签角色可以把手续费调到任意值 \| contracts\/Vault\.sol setFee\(\) \|/)
  assert.match(markdown, /\| owner 可直接提走全部资金 \| Vault\.emergencyWithdraw \| 文档未提及 \|/)
  // 一致条目只需过目，用紧凑列表而不是宽表格
  assert.match(markdown, /- REQ-02 存款无手续费（出处：docs\/PRD\.md §3；代码：contracts\/Vault\.sol deposit\(\)）/)

  // 第 6 章不参与门禁：不得出现签字状态标记，避免干扰 pipeline 对第 3 章的计数
  const chapter6 = markdown.slice(markdown.indexOf('## 6.'), markdown.indexOf('## 人工签字'))
  assert.ok(!chapter6.includes('⬜') && !chapter6.includes('✅'), '第 6 章不得出现签字状态标记')
  // 章节顺序：5 → 6 → 签字栏
  assert.ok(markdown.indexOf('## 5.') < markdown.indexOf('## 6.') && markdown.indexOf('## 6.') < markdown.indexOf('## 人工签字'))
})

test('buildScopeMarkdown 没有业务文档时第 6 章给出明确提示', () => {
  const markdown = buildScopeMarkdown({})
  assert.match(markdown, /## 6\. 文档与代码对照/)
  assert.match(markdown, /本次没有读到可用的业务文档/)
  assert.match(markdown, /未在仓库中找到 PRD\/需求\/设计类文档，也未通过 docs 参数指定/)
})

test('buildScopeMarkdown 未核对条目在需要关注表中明确提示人工核对', () => {
  const markdown = buildScopeMarkdown({
    docCheck: reconcileRequirementChecks([{ id: 'REQ-01', statement: '要求 A', source: 'docs/a.md' }], null),
  })
  assert.match(markdown, /\| REQ-01 \| 要求 A \| docs\/a\.md \| 未核对 \| 对照 agent 未给出结论，需人工核对 \| 待人工补充 \|/)
})

test('buildScopeMarkdown 输出阅读指引与合并去重的术语表，不再输出精简说明', () => {
  const input = fullInput()
  input.system.glossary = [
    { term: '多签', explanation: '需要多个人共同签名才能执行操作的钱包' },
    { term: 'fee-on-transfer', explanation: '转账时自动扣一部分手续费的代币' },
  ]
  input.economics.glossary = [
    { term: '多签', explanation: '重复术语应被去重' },
    { term: '清算', explanation: '借款人抵押不足时，任何人可以替他还债并低价拿走抵押物' },
    { term: '', explanation: '无名术语忽略' },
  ]
  const markdown = buildScopeMarkdown(input)

  assert.match(markdown, /## 怎么读这份文档/)
  assert.ok(!markdown.includes('本文档做了哪些精简'), '精简说明一节已移除')

  assert.match(markdown, /## 附录：术语表/)
  assert.match(markdown, /\| 多签 \| 需要多个人共同签名才能执行操作的钱包 \|/)
  assert.ok(!markdown.includes('重复术语应被去重'), '同名术语只保留第一次出现的解释')
  assert.match(markdown, /\| 清算 \|/)
  assert.ok(!markdown.includes('无名术语忽略'))
  // 签字栏仍在文末，术语表不得出现签字状态标记
  assert.ok(markdown.indexOf('## 附录：术语表') < markdown.indexOf('## 人工签字'))
  const appendix = markdown.slice(markdown.indexOf('## 附录：术语表'), markdown.indexOf('## 人工签字'))
  assert.ok(!appendix.includes('⬜') && !appendix.includes('✅'))
})

test('buildScopeMarkdown 无术语时给出明确的"无"', () => {
  const markdown = buildScopeMarkdown({})
  assert.match(markdown, /## 附录：术语表\n\n- 无/)
})

test('reconcileRequirementChecks 透传"这意味着什么"字段', () => {
  const result = reconcileRequirementChecks(
    [{ id: 'REQ-01', statement: 'A', source: 'x' }],
    { checks: [{ requirementId: 'REQ-01', status: '不一致', risk: '可能被盗' }] }
  )
  assert.equal(result.rows[0].risk, '可能被盗')
})

test('提示词：要求合并压缩、上限、大白话写法、后果与核对方法、术语表', () => {
  const sys = workflowSource.slice(workflowSource.indexOf('function systemAnalysisPrompt('))
  assert.match(sys, /15 条/)
  assert.match(sys, /impactIfBroken/)
  assert.match(sys, /howToVerify/)
  assert.ok(!workflowSource.includes('condensedNote'), 'condensedNote 已无消费方，不应再出现')
  for (const name of ['systemAnalysisPrompt', 'economicsPrompt', 'docCheckPrompt']) {
    const start = workflowSource.indexOf(`function ${name}(`)
    const body = workflowSource.slice(start, workflowSource.indexOf('\n}\n', start))
    assert.match(body, /\$\{PLAIN_LANGUAGE_RULE\}/, `${name} 未注入大白话写法规则`)
  }
  const collect = workflowSource.slice(workflowSource.indexOf('function docCollectionPrompt('))
  assert.match(collect, /最多 30 条/)
  const check = workflowSource.slice(workflowSource.indexOf('function docCheckPrompt('))
  assert.match(check, /risk/)
})

test('提示词：分析阶段读取需求条目，对照阶段要求逐条对账，且声明文档内容是数据', () => {
  for (const name of ['systemAnalysisPrompt', 'economicsPrompt', 'docCheckPrompt']) {
    const start = workflowSource.indexOf(`function ${name}(`)
    assert.notEqual(start, -1, `未找到 ${name}`)
    const body = workflowSource.slice(start, workflowSource.indexOf('\n}\n', start))
    assert.match(body, /requirementsBlock\(requirements\)/, `${name} 未注入需求条目`)
  }
  const collect = workflowSource.slice(workflowSource.indexOf('function docCollectionPrompt('))
  assert.match(collect, /readable=false/)
  assert.match(collect, /omittedNote/)
  assert.match(collect, /\$\{DOC_SAFETY_NOTE\}/)
  const check = workflowSource.slice(workflowSource.indexOf('function docCheckPrompt('))
  assert.match(check, /对账规则/)
  assert.match(workflowSource, /doc-stated/)
})

test('主流程：无需求时跳过对照，结果经纯代码对账后写入文档并返回', () => {
  assert.match(workflowSource, /if \(requirements\.length\) \{[\s\S]*?docCheckPrompt\(/)
  assert.match(workflowSource, /const docCheck = reconcileRequirementChecks\(requirements, docCheckRaw\)/)
  assert.match(workflowSource, /buildScopeMarkdown\(\{ system, economics, docs, docCheck \}\)/)
  const returnBlock = workflowSource.slice(workflowSource.lastIndexOf('return {'))
  assert.match(returnBlock, /\bdocs\b/)
  assert.match(returnBlock, /\bdocCheck\b/)
})
