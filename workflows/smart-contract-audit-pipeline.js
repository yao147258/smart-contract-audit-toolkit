// 智能合约 AI 审计落地流程 —— L1~L4 内部全审计 Workflow
// 属于 smart-contract-audit-toolkit 插件的一部分，安装后以
// /smart-contract-audit-toolkit:smart-contract-audit-pipeline 命名空间调用。
// 用法：
//   /smart-contract-audit-toolkit:smart-contract-audit-pipeline                 // 自动发现本项目核心合约，跑全套
//   /smart-contract-audit-toolkit:smart-contract-audit-pipeline 只审计 contracts/Vault.sol 和 contracts/Treasury.sol，跳过 L3
//   （等价于 Workflow({ name: 'smart-contract-audit-pipeline', args: {
//     targets: ['contracts/Vault.sol', 'contracts/Treasury.sol'],              // 只审指定合约
//     categories: ['reentrancy', 'access-control'],                            // 只跑指定 L2 专项类别（默认全部10类）
//     skipL3: true,                                                            // 跳过 L3 PoC（快速过一遍 L1+L2，省 token）
//   }}) ）
// 注意：L1/L4 是硬性前置（门禁：L1 High 清零、每条 Critical/High 有 PoC 或书面闭环），
// 但本 workflow 的 L4 只产出"人工复核清单"，真正的误报入库(.audit/false-positives.md)、
// 书面豁免(.audit/exemptions.md)、放行测试的最终决定必须由人签字，AI 不代签。

import { buildAuditSummaryMarkdown, normalizeReportMetadata } from './audit-summary-report.js'

export const meta = {
  name: 'smart-contract-audit-pipeline',
  description: '智能合约四层AI审计流水线：L1确定性静态扫描 → L2 LLM语义审计(四角色对抗×10专项) → L3 PoC复现验证 → L4人工复核清单',
  whenToUse: '合约代码开发自测通过后、交付业务测试/上线前，需要跑一遍内部全审计（硬性前置）时使用；也可用 args.targets 只审某几个改动的合约做增量审计。',
  phases: [
    { title: '准备' },
    { title: 'L1 静态扫描' },
    { title: 'L2 语义审计' },
    { title: 'L3 PoC 复现' },
    { title: 'L4 复核与归档' },
  ],
}

// ---------------------------------------------------------------------------
// 常量：L2 专项类别清单（把常见智能合约漏洞库收敛为可执行的窄提示词分类，
// 每次只审一个专项、禁止跨类报告，用以降低单次扫描的误报率）
// ---------------------------------------------------------------------------
const VULN_CATEGORIES = [
  { key: 'reentrancy', label: '重入攻击' },
  { key: 'access-control', label: '访问权限与权限提升' },
  { key: 'integer-arithmetic', label: '整数溢出/精度损失/份额舍入' },
  { key: 'oracle-price', label: '预言机依赖与价格操纵' },
  { key: 'token-logic', label: '代币转账/授权/回退逻辑（含非标准ERC20）' },
  { key: 'business-logic', label: '业务逻辑与需求文档偏差（多开发/漏开发）' },
  { key: 'economic-model', label: '经济模型极端场景资金安全模拟' },
  { key: 'upgrade-governance', label: '升级路径可逆性与治理权限现实分布' },
  { key: 'external-calls', label: '外部调用/跨合约信任假设与可信边界' },
  { key: 'dos-liveness', label: '拒绝服务/资金锁死/关键路径可用性' },
]

// 常见误判清单，喂给每个 L2 角色和 L4 报告，减少重复噪音
const COMMON_FALSE_POSITIVES = `
1. 已加 nonReentrant 仍报重入 → 降级 Info/不报
2. 收款方确定是 EOA 且 immutable 时用 .transfer() → 降级 Low/Info
3. test/ mocks/ script/ 目录文件 → 跳过，不属于审计范围
4. interface I*.sol 无实现 → 不报；纯 library 只看精度与边界
5. lib/ node_modules/ 及仓库内可判断为第三方 vendored/fork 代码的目录（如目录内文件头版权声明、package.json/README 里的来源说明、或与仓库其余代码风格明显不同）→ 不扫源码本身，只查"我们怎么调用它"
6. 编译器自带 checked 运算且无 unchecked 块 → 溢出类降级/排除
`.trim()

// ---------------------------------------------------------------------------
// JSON Schema：每一层/每一角色的结构化输出
// ---------------------------------------------------------------------------
const DISCOVERY_SCHEMA = {
  type: 'object',
  properties: {
    targets: { type: 'array', items: { type: 'string' } },
    excludedNote: { type: 'string', description: '被排除的目录/文件及原因，供人核对没有漏审' },
  },
  required: ['targets'],
}

const L1_SCHEMA = {
  type: 'object',
  properties: {
    toolsAvailable: { type: 'array', items: { type: 'string' }, description: '实际可用的工具，如 slither/aderyn/solc；未安装的如实注明' },
    highCount: { type: 'number' },
    mediumCount: { type: 'number' },
    lowCount: { type: 'number' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          severity: { type: 'string', description: 'High/Medium/Low/Info' },
          tool: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          location: { type: 'string' },
          isHardcodedSecret: { type: 'boolean' },
        },
        required: ['file', 'severity', 'title'],
      },
    },
    callGraphNote: { type: 'string', description: '调用图/继承关系要点摘要，供 L2 使用' },
    gatePass: { type: 'boolean', description: 'High 是否已清零（真实 High，不含已豁免）' },
  },
  required: ['highCount', 'mediumCount', 'findings', 'gatePass'],
}

const FINDING_FIELDS = {
  title: { type: 'string' },
  location: { type: 'string' },
  description: { type: 'string' },
}

const AUDITOR_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    target: { type: 'string' },
    rebuiltSpec: { type: 'string', description: '只读源码重建出的该专项规格意图' },
    candidateFindings: { type: 'array', items: { type: 'object', properties: FINDING_FIELDS, required: ['title', 'description'] } },
  },
  required: ['category', 'target', 'candidateFindings'],
}

const ATTACKER_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    target: { type: 'string' },
    rebuiltSpec: { type: 'string' },
    candidateFindings: { type: 'array', items: { type: 'object', properties: FINDING_FIELDS, required: ['title', 'description'] } },
    attackPaths: {
      type: 'array',
      items: {
        type: 'object',
        properties: { findingTitle: { type: 'string' }, attackPath: { type: 'string' }, preconditions: { type: 'string' } },
        required: ['findingTitle', 'attackPath'],
      },
    },
  },
  required: ['category', 'target', 'candidateFindings', 'attackPaths'],
}

const FIXER_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    target: { type: 'string' },
    candidateFindings: { type: 'array', items: { type: 'object', properties: FINDING_FIELDS, required: ['title', 'description'] } },
    attackPaths: { type: 'array', items: { type: 'object', properties: { findingTitle: { type: 'string' }, attackPath: { type: 'string' }, preconditions: { type: 'string' } }, required: ['findingTitle', 'attackPath'] } },
    patches: { type: 'array', items: { type: 'object', properties: { findingTitle: { type: 'string' }, minimalPatch: { type: 'string' } }, required: ['findingTitle', 'minimalPatch'] } },
  },
  required: ['category', 'target', 'candidateFindings', 'attackPaths', 'patches'],
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    target: { type: 'string' },
    confirmedFindings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', description: 'Critical/High/Medium/Low' },
          impact: { type: 'string' },
          likelihood: { type: 'string' },
          confidence: { type: 'string' },
          attackPath: { type: 'string' },
          minimalPatch: { type: 'string' },
          status: { type: 'string', description: 'Confirmed（已用代码逐行证明）/ NeedsPoC（需L3构造PoC验证，不得标Confirmed）' },
        },
        required: ['title', 'severity', 'status'],
      },
    },
    rejectedFindings: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, reason: { type: 'string' } }, required: ['title', 'reason'] },
    },
  },
  required: ['category', 'target', 'confirmedFindings', 'rejectedFindings'],
}

const POC_SCHEMA = {
  type: 'object',
  properties: {
    findingTitle: { type: 'string' },
    target: { type: 'string' },
    status: { type: 'string', description: 'Confirmed（PoC跑通）/ Suspected（迭代耗尽仍无法证明，降级人工队列）' },
    iterations: { type: 'number' },
    coverageNote: { type: 'string' },
    testPath: { type: 'string' },
    evidence: { type: 'string', description: '状态差分/关键断言输出摘要，禁止编造' },
  },
  required: ['findingTitle', 'status'],
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string' },
    summary: { type: 'string' },
    openItemsForHuman: { type: 'array', items: { type: 'string' }, description: 'AI结构性做不到、需人工二次确认的点：经济假设/治理分布/升级可逆性等' },
    suggestedFalsePositiveEntries: { type: 'array', items: { type: 'string' }, description: '建议人工确认后写入 .audit/false-positives.md 的条目（含理由），AI不直接落库' },
  },
  required: ['target', 'summary'],
}

const GLOBAL_SCHEMA = {
  type: 'object',
  properties: {
    overview: { type: 'string' },
    readyForDelivery: { type: 'boolean', description: '是否满足交付业务测试的门禁（不代表最终放行，仅供人工参考）' },
    blockingItems: { type: 'array', items: { type: 'string' } },
    perTargetGate: {
      type: 'array',
      items: { type: 'object', properties: { target: { type: 'string' }, gatePass: { type: 'boolean' } }, required: ['target', 'gatePass'] },
    },
  },
  required: ['overview', 'readyForDelivery'],
}

// ---------------------------------------------------------------------------
// 提示词构造函数
// ---------------------------------------------------------------------------
function contextPrompt() {
  return `读取本仓库以下文件作为本轮审计的上下文（不存在的如实说明"文件不存在"，不要编造内容）：
- .audit/invariants.md（L0 不变量清单）
- .audit/false-positives.md（已确认误报库，用于降噪，抑制重复报告）
- .audit/exemptions.md（已知问题书面豁免）
- 在 docs/ 目录或仓库根目录下查找 PRD/需求/技术设计类文档（常见命名如 *PRD*、*需求*、*设计*，或 README 中的架构章节），重点看与合约资金流转/利率/清算/额度相关的章节；找不到明确对应文件就如实说明，不要编造

把以上内容浓缩为不超过 800 字的审计上下文摘要，分四段：
①已知不变量要点  ②已确认误报要点（供后续各专项审计跳过）  ③已豁免问题要点  ④经济模型/资金流转要点（若无相关文档，如实说明未找到）。
直接输出摘要文本，不要输出 JSON。`
}

function discoveryPrompt() {
  return `枚举本仓库需要纳入本轮 L1-L4 内部审计的核心业务合约 .sol 文件。
规则：
- 纳入：contracts/ 顶层自研合约，以及承担核心数学/转账逻辑的 libraries（具体文件名不要凭记忆预设，必须用 git ls-files / find / ls 实地核对）；
- 排除：test/、script/、contracts/mocks/、contracts/interfaces/（纯接口无实现），以及能判断为第三方 vendored/fork 代码的目录（可通过目录内文件头版权声明、package.json/README 里的来源说明、或与仓库其余代码风格明显不同来判断）——第三方代码只查"我们怎么调用它"，不审源码本身；
- 用 bash（git ls-files / find / ls）实地核对文件是否存在，不要凭记忆猜测。
返回 targets 数组（仓库相对路径），excludedNote 简述排除了什么、为什么。`
}

function l1Prompt(targets) {
  return `执行 L1 确定性静态扫描（静态工具扫描 + 编译器告警，不依赖语义理解），目标合约：
${targets.join('\n')}

步骤：
1. 若 .audit/ 目录不存在，创建骨架：.audit/invariants.md、.audit/false-positives.md、.audit/exemptions.md、.audit/regression/.gitkeep、.audit/reports/（空文件即可，不要覆盖已存在内容）；
2. 检查 slither / aderyn 是否已安装；若未安装，尝试 pip3 install slither-analyzer / cyfrinup 安装；若因网络等原因确实装不上，如实记一条 severity=Info、title="工具不可用：<工具名>" 并说明原因，绝不允许编造扫描结果；
3. 若无 slither.config.json，先跑一次 slither . 生成基线（不要预先加过滤，先看真实结果）；
4. 依次执行：
   slither . --config-file slither.config.json（若无配置文件则 slither .）
   slither . --print call-graph
   aderyn .
   npx hardhat compile 时留意的编译器告警
5. 硬编码私钥/明文密钥 = 红线，发现即记为 High，isHardcodedSecret=true；
6. 参考以下常见误判清单，命中的直接降级为 Info 或不报，不要占用 High/Medium 名额：
${COMMON_FALSE_POSITIVES}
7. 把 slither 原始 JSON 摘要和 aderyn 报告要点写入 .audit/reports/l1-<日期占位，用"latest"代替>.json 与 .audit/reports/l1-latest.md（覆盖写即可）。

按 schema 返回：真实 High/Medium/Low 计数（已排除上面误判清单命中的）、findings 明细（含 file/severity/tool/title/description/location）、call-graph 要点摘要、gatePass（highCount===0 时为 true）。`
}

function auditorPrompt(cat, target, l1, context) {
  const related = (l1.findings || []).filter(f => !f.file || target.indexOf(f.file) !== -1 || f.file.indexOf(target.split('/').pop()) !== -1)
  return `L2 语义审计 —— 角色①🔵审计员（中立立场，重建规格 + 扫描）。
目标合约：${target}
专项类别（本次只找这一类，禁止跨类报告，窄提示词可将误报降低60%+）：${cat.label}（${cat.key}）

审计上下文摘要：
${context}

L1 已认领的相关发现（不要重复这些已知模式，把精力放在"代码行为 ≠ 业务意图"上）：
${JSON.stringify(related)}

常见误判清单（命中的不要提出）：
${COMMON_FALSE_POSITIVES}

任务：
1. 只读 ${target} 源码，重建它在"${cat.label}"专项下应当保证的规格/不变量；
2. 逐条列出该专项下的疑似发现（candidateFindings），每条给出准确位置（函数名/行号范围）与描述；
3. 没有发现就返回空数组，不要为了凑数而报告。
严格按 schema 返回 JSON。`
}

function attackerPrompt(cat, target, auditorOut) {
  return `L2 语义审计 —— 角色②🔴攻击者。
在角色①🔵审计员的输出基础上工作，原样保留 category/target/rebuiltSpec/candidateFindings 字段，为每条 candidateFindings 补充 attackPaths：

角色①输出：
${JSON.stringify(auditorOut)}

任务：对每条候选发现，尝试写出一条**可落地**的攻击路径（具体到函数调用序列、前置条件 preconditions、触发方式）。写不出可落地攻击路径的发现，不要硬编 attackPath，如实在 preconditions 里说明"未找到可落地路径"——裁判角色会据此拒绝它，这是正常结果，不是失败。
严格按 schema 返回 JSON（保留角色①已有字段，新增 attackPaths）。`
}

function fixerPrompt(cat, target, attackerOut) {
  return `L2 语义审计 —— 角色③🟢修复工程师。
在角色②🔴攻击者的输出基础上工作，原样保留已有字段，为每条**确有攻击路径**的发现补充 patches（最小补丁，不做无关重构）：

角色②输出：
${JSON.stringify(attackerOut)}

任务：只对 attackPaths 中真正可落地的条目给出 minimalPatch（一句话描述改哪一行/加什么修饰符/加什么检查，不需要写完整 diff）。没有可落地攻击路径的发现不用给 patch。
严格按 schema 返回 JSON（保留已有字段，新增 patches）。`
}

function judgePrompt(cat, target, fixerOut) {
  return `L2 语义审计 —— 角色④⚖️裁判（默认每一条发现都是错的，除非代码逐行证明成立）。
汇总前三个角色的产出：
${JSON.stringify(fixerOut)}

裁判规则（不可协商）：
1. 逐条重新走查源码，验证 attackPath 是否真的成立；
2. 能用代码逐行证明成立 → status=Confirmed；
3. 攻击路径合理但需要运行时状态才能确证（如需要 fuzz/PoC）→ status=NeedsPoC，**不得**标记 Confirmed；
4. 证明不成立、或命中常见误判清单 → 移入 rejectedFindings，并写明可核查的拒绝理由（这条理由未来要进 .audit/false-positives.md，写不出理由就不要拒绝，先保留为 NeedsPoC）；
5. severity 按 Impact×Likelihood 定级为 Critical/High/Medium/Low；
6. 只有 confirmedFindings 会被送进 L3 PoC 复现（Critical/High）或写入最终报告，rejectedFindings 会被抑制。
严格按 schema 返回 JSON。`
}

function pocPrompt(target, finding, l1) {
  return `L3 PoC 复现验证（唯一能把"疑似"变"确认"的一层）。
目标合约：${target}
待验证发现：${JSON.stringify(finding)}

六步 agent loop（在你自己的工具调用循环内完成，不要中途放弃）：
1. 取 finding（已给出）；
2. 上下文切片：只读 ${target} 及其直接依赖的相关函数，不要通读全仓库；
3. 生成 PoC：优先用 Hardhat 3 内置 Solidity 测试（本仓库已是 Hardhat 项目，无需迁移到 Foundry）；若已检测到 foundry.toml/forge 可用，也可用 forge test 写在 test/poc/ 下；
4. 运行测试拿到反馈，有界迭代 ≤5 轮（每轮记录尝试了什么、失败原因），迭代次数计入 iterations；
5. 用状态差分做 oracle（记录关键状态变量在攻击前后的差值，或 Hardhat 等价的余额/权限快照对比），并做语义 sanity check —— "测试通过" 不等于 "漏洞成立"，必须差分结果与漏洞语义直接对应；
6. 5 轮内无法证明 → status=Suspected，降级人工队列，不得标 Confirmed。

四条护栏（不可协商）：
①PoC 禁止 override/重写目标合约任何方法（否则验证的是你自己写的代码，不是真实合约）；
②状态差分必须与该漏洞的语义直接相关；
③如果发现是"通用 revert 吞掉了断言"这类空烧 gas 的假阳性，强制更换攻击假设重试，不要在同一条死路上重复迭代；
④没有可复现的执行证据（测试输出/状态差分数据），一律不得标记 Confirmed —— 如实标 Suspected 并说明卡在哪一步。

跑通后，把测试文件路径记入 testPath；若确认成立，把该测试文件复制一份到 .audit/regression/ 下永久保留（文件名建议 POC-<severity首字母><序号>-<关键词>.t.sol 或 .js）。
严格按 schema 返回 JSON，evidence 字段填真实观测到的状态差分/断言输出摘要，禁止编造。`
}

function reportPrompt(target, l3Out, gate) {
  return `汇总 ${target} 的 L4 人工复核清单。你的产出是 checklist，不是结论，最终判定必须由人签字。

本合约 L1~L3 汇总数据：
${JSON.stringify({ confirmedFindings: l3Out.confirmedFindings, pocResults: l3Out.pocResults, gate })}

任务：
1. 写一段 summary，概述本合约当前风险状态（多少条 Confirmed/NeedsPoC/Suspected，严重度分布，gate 是否通过）；
2. 列出 openItemsForHuman —— AI 结构性做不到、必须人工二次确认的点：经济模型假设是否成立、治理/多签权限现实分布（多签成员是否同一人的多个钱包）、升级路径可逆性、测试阶段管理员权限是否属于"需求允许的合理配置"；
3. 列出 suggestedFalsePositiveEntries —— 建议人工确认后写入 .audit/false-positives.md 的条目草稿（每条含"理由"，人工确认后才能真正落库，AI 不直接写库）。
严格按 schema 返回 JSON。`
}

function globalSynthesisPrompt(perTarget, l1) {
  return `汇总本轮全部 ${perTarget.length} 个目标合约的 L4 报告，产出总览：
${JSON.stringify(perTarget.map(r => ({ target: r.target, gate: r.gate, confirmedCount: (r.confirmedFindings || []).length, report: r.report })))}

L1 全局数据：highCount=${l1.highCount}, mediumCount=${l1.mediumCount}, gatePass=${l1.gatePass}

任务：
1. overview：用几句话概述本轮审计整体风险状况；
2. readyForDelivery：只有当"L1 High 清零"且"每条 Critical/High 都有 PoC 结论或书面闭环"时才为 true，否则 false（这只是给人的参考信号，不是自动放行）；
3. blockingItems：列出阻止交付业务测试的具体条目（对应哪个合约、哪条发现）；
4. perTargetGate：每个合约的 gate.gatePass 汇总列表。
严格按 schema 返回 JSON。`
}

// ---------------------------------------------------------------------------
// 纯函数：门禁判定（不调用大模型，避免让 AI 给自己打分）
// ---------------------------------------------------------------------------
function computeGates(l1, confirmedFindings, pocResults) {
  const l1HighZero = (l1.highCount || 0) === 0
  const criticalHigh = (confirmedFindings || []).filter(
    f => (f.status === 'Confirmed' || f.status === 'NeedsPoC') && (f.severity === 'Critical' || f.severity === 'High')
  )
  const evidenceComplete = criticalHigh.every(f => (pocResults || []).some(p => p.findingTitle === f.title))
  return {
    l1HighZero,
    criticalHighCount: criticalHigh.length,
    evidenceComplete,
    gatePass: l1HighZero && evidenceComplete,
  }
}

// ---------------------------------------------------------------------------
// L2 单目标：四角色对抗 × 多专项类别（专项之间用 pipeline，无阻塞并行推进）
// ---------------------------------------------------------------------------
async function l2Stage(target, l1, context, categories) {
  const categoryResults = await pipeline(
    categories,
    cat => agent(auditorPrompt(cat, target, l1, context), { phase: 'L2 语义审计', schema: AUDITOR_SCHEMA, label: `L2-审计员:${target}:${cat.key}` }),
    (auditorOut, cat) => agent(attackerPrompt(cat, target, auditorOut), { phase: 'L2 语义审计', schema: ATTACKER_SCHEMA, label: `L2-攻击者:${target}:${cat.key}`, effort: 'high' }),
    (attackerOut, cat) => agent(fixerPrompt(cat, target, attackerOut), { phase: 'L2 语义审计', schema: FIXER_SCHEMA, label: `L2-修复工程师:${target}:${cat.key}` }),
    (fixerOut, cat) => agent(judgePrompt(cat, target, fixerOut), { phase: 'L2 语义审计', schema: JUDGE_SCHEMA, label: `L2-裁判:${target}:${cat.key}`, effort: 'high' })
  )
  const valid = categoryResults.filter(Boolean)
  const dropped = categories.length - valid.length
  if (dropped > 0) log(`⚠️ ${target}：有 ${dropped}/${categories.length} 个 L2 专项类别在某一角色环节失败，已跳过（未静默计入"已通过"）`)
  const confirmedFindings = valid.flatMap(r => r.confirmedFindings || [])
  return { target, l1, categories: valid, confirmedFindings }
}

// ---------------------------------------------------------------------------
// L3 单目标：对该目标所有 Critical/High 发现并行做 PoC（此处 parallel 是合理屏障——
// L4 报告需要该目标全部 PoC 结果一起汇总，不是"图省事"式屏障）
// ---------------------------------------------------------------------------
async function l3Stage(l2Out, target, skipL3) {
  if (!l2Out) return null
  const needsEvidence = (l2Out.confirmedFindings || []).filter(
    f => (f.status === 'Confirmed' || f.status === 'NeedsPoC') && (f.severity === 'Critical' || f.severity === 'High')
  )
  if (skipL3) {
    if (needsEvidence.length > 0) log(`⚠️ ${target}：skipL3=true，跳过 ${needsEvidence.length} 条 Critical/High 的 PoC 验证，门禁将标记为未通过`)
    return { ...l2Out, pocResults: [] }
  }
  if (!needsEvidence.length) {
    log(`${target}：L2 无待验证的 Critical/High，跳过 L3`)
    return { ...l2Out, pocResults: [] }
  }
  const pocResults = await parallel(
    needsEvidence.map(f => () => agent(pocPrompt(target, f, l2Out.l1), { phase: 'L3 PoC 复现', schema: POC_SCHEMA, label: `L3-PoC:${target}:${f.title}`, effort: 'high' }))
  )
  return { ...l2Out, pocResults: pocResults.filter(Boolean) }
}

// ---------------------------------------------------------------------------
// L4 单目标：门禁用纯函数算，报告用 agent 写
// ---------------------------------------------------------------------------
async function l4Stage(l3Out, target) {
  if (!l3Out) return null
  const gate = computeGates(l3Out.l1, l3Out.confirmedFindings, l3Out.pocResults)
  const report = await agent(reportPrompt(target, l3Out, gate), { phase: 'L4 复核与归档', schema: REPORT_SCHEMA, label: `L4-报告:${target}` })
  return { target, gate, confirmedFindings: l3Out.confirmedFindings, pocResults: l3Out.pocResults, report }
}

// ===========================================================================
// 主流程
// ===========================================================================
phase('准备')
const context = await agent(contextPrompt(), { label: '加载审计上下文' })

let targets = args && args.targets && args.targets.length ? args.targets : null
if (!targets) {
  const discovery = await agent(discoveryPrompt(), { schema: DISCOVERY_SCHEMA, label: '发现审计目标' })
  targets = discovery.targets
  log(`自动发现目标合约 ${targets.length} 个（${discovery.excludedNote || ''}）`)
}
if (!targets || !targets.length) {
  log('未发现任何审计目标，流程结束')
  return { error: '无目标合约，请通过 args.targets 显式指定' }
}
log(`本轮审计目标合约 ${targets.length} 个：${targets.join('、')}`)

const categories = args && args.categories && args.categories.length
  ? VULN_CATEGORIES.filter(c => args.categories.indexOf(c.key) !== -1)
  : VULN_CATEGORIES
if (categories.length < VULN_CATEGORIES.length) {
  log(`本轮只跑 L2 专项类别：${categories.map(c => c.key).join(', ')}（共${VULN_CATEGORIES.length}类，其余跳过，非默认全量）`)
}
const skipL3 = !!(args && args.skipL3)
if (skipL3) log('skipL3=true：本轮跳过 L3 PoC 复现，Critical/High 不会有执行证据，门禁不会通过——仅适用于快速过一遍 L1+L2')

phase('L1 静态扫描')
const l1 = await agent(l1Prompt(targets), { schema: L1_SCHEMA, label: 'L1-全量扫描' })
log(`L1 完成：High ${l1.highCount} / Medium ${l1.mediumCount} / Low ${l1.lowCount}，门禁${l1.gatePass ? '通过' : '未通过（存在未处置 High）'}`)

// L2 → L3 → L4：以"目标合约"为流水线单元，逐合约独立推进，不设跨合约屏障——
// 合约A在做L3 PoC时，合约B可能已经在跑L2下一个专项，wall-clock取决于最慢的单条合约链路。
phase('L2 语义审计')
const l2Results = await pipeline(
  targets,
  target => l2Stage(target, l1, context, categories)
)

phase('L3 PoC 复现')
const l3Results = await pipeline(
  l2Results,
  l2Out => l3Stage(l2Out, l2Out && l2Out.target, skipL3)
)

phase('L4 复核与归档')
const perTarget = await pipeline(
  l3Results,
  l3Out => l4Stage(l3Out, l3Out && l3Out.target)
)

const valid = perTarget.filter(Boolean)
const droppedTargets = targets.length - valid.length
if (droppedTargets > 0) log(`⚠️ ${droppedTargets}/${targets.length} 个目标合约在流水线某阶段失败，已跳过，未计入最终报告`)

const globalReport = await agent(globalSynthesisPrompt(valid, l1), { schema: GLOBAL_SCHEMA, label: 'L4-总报告' })

log(`审计完成：${valid.length}/${targets.length} 个合约走完全流程，readyForDelivery=${globalReport.readyForDelivery}`)

return {
  l1,
  perTarget: valid,
  global: globalReport,
}
