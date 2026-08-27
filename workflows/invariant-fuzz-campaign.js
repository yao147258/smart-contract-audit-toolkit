// 不变量深度模糊测试长跑 Workflow（Echidna + Medusa）
// 属于 smart-contract-audit-toolkit 插件的一部分，安装后以
// /smart-contract-audit-toolkit:invariant-fuzz-campaign 命名空间调用。
// 定位：这是独立于 smart-contract-audit-pipeline.js 的另一条流水线——
//   smart-contract-audit-pipeline 的 L3 只对"L2 已怀疑的具体发现"逐条生成 PoC；
//   本 workflow 不看 L2 结论，直接对 .audit/invariants.md 里"系统永远成立的性质"
//   做无边界随机攻击，找 L2 语义审计想不到的组合型漏洞。
// 用法：
//   /smart-contract-audit-toolkit:invariant-fuzz-campaign                  // 跑 invariants.md 里全部未跳过的不变量
//   /smart-contract-audit-toolkit:invariant-fuzz-campaign 只跑 INV-01 和 INV-02，只用 echidna 引擎
//   （等价于 Workflow({ name: 'invariant-fuzz-campaign', args: {
//     invariantIds: ['INV-01', 'INV-02'],   // 只跑指定不变量（比如本次只改了某个核心状态机相关逻辑）
//     engines: ['echidna'],                 // 只用某个引擎（默认 echidna+medusa 都跑，装不上就如实报缺失）
//     roundsPerEngine: 3,                   // 每个引擎跑几轮（靠 corpus 复用累积覆盖率）
//     minutesPerRound: 5,                   // 每轮时间预算（单个 Bash 调用超时上限10分钟，别设太大）
//   }}) ）
// 建议节奏：merge to main 后 / 每周定时（可配合 CronCreate 做成周期任务），不建议每个 PR 都跑——
// 太慢，长程 fuzz 更适合排在"每周"而不是"每个PR"档位。

export const meta = {
  name: 'invariant-fuzz-campaign',
  description: '读取 .audit/invariants.md，对未跳过的不变量生成/复用 Echidna+Medusa 测试装置，跑长程模糊测试，反例回归入库',
  whenToUse: '核心状态机相关合约有较大改动后，或按周期（建议每周）跑一次深度 fuzz，寻找 L2 语义审计和常规单测都覆盖不到的组合型漏洞；不适合每个 PR 都跑（太慢）。',
  phases: [
    { title: '准备' },
    { title: '装置生成' },
    { title: 'Fuzz长跑' },
    { title: '结果归档' },
  ],
}

const DEFAULT_ENGINES = ['echidna', 'medusa']

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------
const INVARIANT_LIST_SCHEMA = {
  type: 'object',
  properties: {
    invariants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          contract: { type: 'string' },
          testEntry: { type: 'string', description: '检验方式列里的函数名，如 invariant_solvency' },
          status: { type: 'string' },
        },
        required: ['id', 'description', 'contract'],
      },
    },
  },
  required: ['invariants'],
}

const HARNESS_SCHEMA = {
  type: 'object',
  properties: {
    invariantId: { type: 'string' },
    harnessPath: { type: 'string' },
    engineConfigNote: { type: 'string', description: 'echidna.yaml / medusa 配置要点，或复用了哪个已有配置' },
    corpusDir: { type: 'string' },
    ready: { type: 'boolean' },
    blockedReason: { type: 'string', description: 'ready=false 时必填：为什么搭不出安全的装置（如部署依赖不明确），需要人工补充 fixture' },
  },
  required: ['invariantId', 'ready'],
}

const ENGINE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    invariantId: { type: 'string' },
    engine: { type: 'string', description: 'echidna | medusa' },
    available: { type: 'boolean' },
    status: { type: 'string', description: 'Passed（本轮未发现反例）/ Falsified（发现反例）/ ToolUnavailable / HarnessNotReady' },
    roundsRun: { type: 'number' },
    totalCallsRun: { type: 'number', description: '尽力从工具输出统计的总调用序列数，仅供参考' },
    counterexample: { type: 'string', description: 'Falsified 时必填：完整可复现的调用序列，禁止编造' },
    corpusPath: { type: 'string' },
  },
  required: ['invariantId', 'engine', 'status'],
}

const INVARIANT_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    invariantId: { type: 'string' },
    overallStatus: { type: 'string', description: 'Falsified（至少一个引擎找到反例，阻断） / PassedThisRound（跑过但只是本轮未发现反例，不是数学证明） / Skipped（装置未就绪或工具不可用）' },
    regressionTestPath: { type: 'string' },
    invariantsMdUpdated: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['invariantId', 'overallStatus'],
}

const GLOBAL_SCHEMA = {
  type: 'object',
  properties: {
    overview: { type: 'string' },
    falsifiedCount: { type: 'number' },
    skippedCount: { type: 'number' },
    blockingItems: { type: 'array', items: { type: 'string' } },
  },
  required: ['overview'],
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------
function invariantListPrompt() {
  return `读取 .audit/invariants.md 的不变量表格（若文件不存在，如实说明并返回空数组，不要编造）。
逐行解析为结构化数据：id（如 INV-01）、description（不变量描述）、contract（涉及合约）、testEntry（检验方式列里的函数名，如 invariant_solvency）、status（状态列原文）。
状态列写"跳过"/"不适用"/"N/A"的行也要如实列出（后续会按参数过滤，不要在这一步自行丢弃）。
严格按 schema 返回。`
}

function harnessPrompt(inv) {
  return `为不变量 ${inv.id}（${inv.description}，涉及合约 ${inv.contract}，检验方式 ${inv.testEntry || '未指定，需你判断合理的属性函数名'}）准备 Echidna/Medusa 测试装置。

步骤：
1. 先在 test/invariant/、test/echidna/ 下查找是否已存在对应装置（按 testEntry 或 ${inv.id} 命名线索找），存在则直接复用，不要重复造轮子；
2. 不存在则新建 test/invariant/${inv.id}.sol：
   - 部署真实目标合约 ${inv.contract}（及其必要依赖，可复用 contracts/mocks/ 下的 Mock 代币等辅助部署，但被测的核心合约本身必须是真实源码）；
   - 写一个 echidna_<属性名>() public view returns (bool) 函数，返回值为 ${inv.description} 这条性质是否仍然成立（Echidna 和 Medusa 都支持这种 property 命名约定）；
   - 护栏（不可协商）：装置**禁止 override/重写**目标合约任何方法，只能通过其真实 public/external 接口交互——否则 fuzz 的是你自己写的代码，不是真实合约；
3. 准备/复用配置文件（echidna.yaml 或 medusa 配置），corpusDir 指到 .audit/fuzz-corpus/${inv.id}/（目录不存在就创建）；
4. 如果部署依赖（比如需要先完成一套复杂的初始化序列，且没有现成脚本可参考）导致你无法在不臆造业务假设的前提下安全搭出装置，ready=false 并在 blockedReason 里写清楚卡在哪一步，交给人工补 fixture，不要硬编造一个可能歪曲语义的部署方式。

严格按 schema 返回 JSON。`
}

function enginePrompt(engine, inv, harness, rounds, minutesPerRound) {
  const cmdHint = engine === 'echidna'
    ? `echidna ${harness.harnessPath} --contract <Harness合约名> --config <echidna.yaml> --corpus-dir ${harness.corpusDir || ('.audit/fuzz-corpus/' + inv.id)}`
    : `medusa fuzz --config <medusa.json 指向 ${harness.harnessPath}>`
  return `用 ${engine} 对 ${inv.id} 的装置 ${harness.harnessPath} 跑深度模糊测试。

1. 先确认 ${engine} 是否已安装（${engine === 'echidna' ? 'echidna --version，未装尝试用 cyfrinup 或官方二进制安装' : 'medusa --version，未装尝试 go install github.com/crytic/medusa@latest（需要 Go 工具链）'}）；如果确实装不上（网络/环境限制），如实返回 available=false, status=ToolUnavailable 并说明原因，绝不允许伪造 fuzz 结果；
2. 若可用，跑最多 ${rounds} 轮，每轮时间预算约 ${minutesPerRound} 分钟（单条 Bash 命令超时上限10分钟，请用工具自带的 --test-limit / timeout 参数控制单轮时长，不要让一次调用超时被杀掉）；
3. 每轮之间复用同一个 corpus 目录（--corpus-dir），让覆盖率跨轮累积，而不是每轮从零开始；
4. 参考命令：${cmdHint}
5. 一旦某一轮发现性质被打破（反例），**立刻停止**，不要再跑剩余轮次——把完整可复现的调用序列（合约方法名+参数+调用顺序）写进 counterexample，禁止编造或简化到无法复现的程度；
6. 跑满 ${rounds} 轮仍未发现反例 → status=Passed，如实填 roundsRun 和尽力统计的 totalCallsRun（这只代表"本轮未发现"，不是数学证明，长跑覆盖率有限）。

严格按 schema 返回 JSON。`
}

function archivePrompt(inv, fuzzOut) {
  return `汇总不变量 ${inv.id} 本轮 fuzz 结果，归档并更新 .audit/invariants.md：
${JSON.stringify(fuzzOut.engineResults)}

任务：
1. 判定 overallStatus：任一引擎 status=Falsified → Falsified（阻断级）；至少一个引擎 Passed 且没有 Falsified → PassedThisRound；全部 ToolUnavailable/HarnessNotReady → Skipped；
2. 若 Falsified：把反例调用序列转成一个可独立重跑的 Hardhat 回归测试（test/regression/ 或 .audit/regression/ 下，文件名建议 POC-INV-<id>-<关键词>.js），复现出同样的失败，路径填入 regressionTestPath；
3. 更新 .audit/invariants.md 中 ${inv.id} 那一行的"状态"列（只改这一行，不要动其他行）：
   - Falsified → 写 "FAILED - 见 <regressionTestPath>"；
   - PassedThisRound → 写 "Fuzz通过本轮（<engine> ${'{'}roundsRun{'}'} 轮/${'{'}totalCallsRun{'}'} 次调用，非数学证明）"，把 invariantsMdUpdated 设为 true；
   - Skipped → 保留原状态不动，invariantsMdUpdated=false，在 notes 里写清楚原因（工具不可用/装置未就绪），供人工后续补齐；
4. notes 里如实总结这一条的关键信息，供 L4 人工复核时快速定位。
严格按 schema 返回 JSON。`
}

function globalPrompt(results) {
  return `汇总本轮不变量 fuzz campaign 的全部结果：
${JSON.stringify(results.map(r => ({ id: r.invariant.id, overallStatus: r.report && r.report.overallStatus, notes: r.report && r.report.notes })))}

任务：
1. overview：几句话概述本轮整体情况（几条 Falsified、几条本轮通过、几条因工具/装置问题被 Skipped）；
2. falsifiedCount / skippedCount：对应计数；
3. blockingItems：列出所有 Falsified 的不变量（对应哪个合约、回归测试路径），这些属于阻断级问题，必须修复后重新跑本 workflow 验证；Skipped 的也要在这里提示"未验证，不代表安全"，避免被误解为已通过。
严格按 schema 返回 JSON。`
}

// ---------------------------------------------------------------------------
// 流水线阶段
// ---------------------------------------------------------------------------
async function fuzzStage(harnessOut, inv, engines, rounds, minutesPerRound) {
  if (!harnessOut || !harnessOut.ready) {
    log(`⚠️ ${inv.id}：装置未就绪（${(harnessOut && harnessOut.blockedReason) || '未知原因'}），跳过本轮 fuzz`)
    return { invariant: inv, harness: harnessOut, engineResults: [] }
  }
  const engineResults = await parallel(
    engines.map(engine => () =>
      agent(enginePrompt(engine, inv, harnessOut, rounds, minutesPerRound), {
        phase: 'Fuzz长跑',
        schema: ENGINE_RESULT_SCHEMA,
        label: `Fuzz-${engine}:${inv.id}`,
        effort: 'high',
      })
    )
  )
  return { invariant: inv, harness: harnessOut, engineResults: engineResults.filter(Boolean) }
}

async function archiveStage(fuzzOut, inv) {
  if (!fuzzOut) return null
  const report = await agent(archivePrompt(inv, fuzzOut), {
    phase: '结果归档',
    schema: INVARIANT_REPORT_SCHEMA,
    label: `归档:${inv.id}`,
  })
  return { invariant: inv, engineResults: fuzzOut.engineResults, report }
}

// ===========================================================================
// 主流程
// ===========================================================================
phase('准备')
const invList = await agent(invariantListPrompt(), { schema: INVARIANT_LIST_SCHEMA, label: '解析不变量清单' })

let invariants = (invList.invariants || []).filter(i => {
  const s = (i.status || '').trim()
  return s !== '跳过' && s !== '不适用' && s.toUpperCase() !== 'N/A'
})
if (args && args.invariantIds && args.invariantIds.length) {
  invariants = invariants.filter(i => args.invariantIds.indexOf(i.id) !== -1)
}
const skippedByStatus = (invList.invariants || []).length - invariants.length
if (skippedByStatus > 0) log(`${skippedByStatus} 条不变量因状态为"跳过/不适用"被排除，不参与本轮 fuzz`)

if (!invariants.length) {
  log('没有需要跑 fuzz 的不变量（.audit/invariants.md 为空、或全部被跳过/被 invariantIds 过滤掉），流程结束')
  return { error: '无可执行的不变量' }
}
log(`本轮 fuzz campaign 目标不变量 ${invariants.length} 条：${invariants.map(i => i.id).join('、')}`)

const engines = args && args.engines && args.engines.length
  ? DEFAULT_ENGINES.filter(e => args.engines.indexOf(e) !== -1)
  : DEFAULT_ENGINES
if (!engines.length) {
  log('args.engines 过滤后为空，回退为默认 echidna+medusa')
}
const rounds = (args && args.roundsPerEngine) || 3
const minutesPerRound = (args && args.minutesPerRound) || 5
log(`引擎：${(engines.length ? engines : DEFAULT_ENGINES).join('+')}，每引擎 ${rounds} 轮，每轮预算 ${minutesPerRound} 分钟`)

phase('装置生成')
const results = await pipeline(
  invariants,
  inv => agent(harnessPrompt(inv), { phase: '装置生成', schema: HARNESS_SCHEMA, label: `装置:${inv.id}` }),
  (harnessOut, inv) => fuzzStage(harnessOut, inv, engines.length ? engines : DEFAULT_ENGINES, rounds, minutesPerRound),
  (fuzzOut, inv) => archiveStage(fuzzOut, inv)
)

const valid = results.filter(Boolean)
const dropped = invariants.length - valid.length
if (dropped > 0) log(`⚠️ ${dropped}/${invariants.length} 条不变量在流水线某阶段失败，已跳过，未计入最终报告`)

const globalReport = await agent(globalPrompt(valid), { phase: '结果归档', schema: GLOBAL_SCHEMA, label: '总报告' })
log(`fuzz campaign 完成：${valid.length}/${invariants.length} 条走完全流程，Falsified ${globalReport.falsifiedCount || 0} 条`)

return {
  invariants: valid,
  global: globalReport,
}
