// L4-plus 形式化验证 Workflow（Halmos 符号执行）
// 属于 smart-contract-audit-toolkit 插件的一部分，安装后以
// /smart-contract-audit-toolkit:formal-verification-halmos 命名空间调用。
// 定位：只用于人工明确指定的"核心数学模块"（AMM 曲线、清算/健康度、份额舍入、桥记账、签名/Merkle 等），
//   不做自动发现——这是可选加强项，范围必须由人判断，不是每次审计都跑。
// 和另外两个 workflow 的边界：
//   smart-contract-audit-pipeline 的 L2/L3 = 语义审计 + 针对具体怀疑点的 PoC；
//   invariant-fuzz-campaign        = 无边界随机攻击找组合型漏洞（抽样，不是证明）；
//   本 workflow                     = 在人工给定的边界内，对指定函数做穷尽的数学证明（bounded proof）。
// 用法（modules 必填，不传直接报错退出）：
//   /smart-contract-audit-toolkit:formal-verification-halmos 对 contracts/libraries/MathLib.sol 和 contracts/RateModel.sol 做 Halmos 证明
//   （等价于 Workflow({ name: 'formal-verification-halmos', args: {
//     modules: [
//       { file: 'contracts/libraries/MathLib.sol', focus: '份额舍入精度，不允许通过舍入净提取超过应得价值' },
//       { file: 'contracts/RateModel.sol', focus: '利率曲线单调性、边界利用率下不发散' },
//     ],
//     loopBound: 4,        // halmos --loop 展开界限，越大越接近穷尽但越慢，默认4
//   }}) ）
// 重要诚实约定：Halmos 在给定边界内没找到反例 ≠ "无条件证明安全"，只代表"在文档记录的这些边界假设内成立"；
// 边界必须在报告里写清楚，绝不允许把"跑到超时/未穷尽"包装成"已证明"。

export const meta = {
  name: 'formal-verification-halmos',
  description: '对人工指定的核心数学模块（AMM曲线/清算/份额舍入等）用 Halmos 做有界符号执行证明，属于可选的 L4-plus 加强层',
  whenToUse: '核心数学模块新增或改动后、上线前 T-1 月，或人工判断某个公式类模块需要数学级别保证时手动触发；modules 必须由人工显式指定，不做自动发现。',
  phases: [
    { title: '准备' },
    { title: '规格设计' },
    { title: 'Halmos证明' },
    { title: '结果汇总' },
  ],
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------
const MODULE_SPEC_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    focus: { type: 'string' },
    properties: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'check_ 函数名，如 check_shareRoundingNoValueLeak' },
          statement: { type: 'string', description: '这条性质用自然语言描述的是什么' },
          boundsAssumed: { type: 'string', description: '对符号输入加了哪些范围约束（vm.assume），如"金额限定在 uint96 以内"' },
        },
        required: ['name', 'statement'],
      },
    },
    harnessPath: { type: 'string' },
    ready: { type: 'boolean' },
    blockedReason: { type: 'string', description: 'ready=false 时必填：为什么写不出合理的证明装置（如依赖 forge-std 但装不上、函数逻辑含无法约束的外部调用等）' },
  },
  required: ['file', 'ready'],
}

const PROOF_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    propertyName: { type: 'string' },
    result: { type: 'string', description: 'Proved（给定边界内无反例）/ Counterexample（找到具体反例）/ Inconclusive（超时或未穷尽，禁止当作Proved）/ ToolUnavailable' },
    boundsAssumed: { type: 'string', description: '必填：这次证明实际生效的边界假设（loop展开界限、数值范围约束等），供人核对"证明范围"够不够' },
    counterexample: { type: 'string', description: 'result=Counterexample 时必填：具体的反例输入值和推导路径，禁止编造' },
    regressionTestPath: { type: 'string' },
  },
  required: ['file', 'propertyName', 'result', 'boundsAssumed'],
}

const MODULE_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    summary: { type: 'string' },
    provedCount: { type: 'number' },
    counterexampleCount: { type: 'number' },
    inconclusiveCount: { type: 'number' },
    escalateToCertora: { type: 'boolean', description: '是否建议升级到 Certora（如：高TVL/跨合约不变量Halmos证不动）' },
  },
  required: ['file', 'summary'],
}

const GLOBAL_SCHEMA = {
  type: 'object',
  properties: {
    overview: { type: 'string' },
    blockingItems: { type: 'array', items: { type: 'string' }, description: '所有 Counterexample，属于阻断级问题' },
    unprovenItems: { type: 'array', items: { type: 'string' }, description: '所有 Inconclusive/ToolUnavailable，明确提示"未证明≠安全"' },
  },
  required: ['overview'],
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------
function moduleSpecPrompt(mod, loopBound) {
  return `为核心数学模块 ${mod.file} 设计 Halmos 证明装置。人工给出的关注点：${mod.focus}

步骤：
1. 只读 ${mod.file} 源码，把"${mod.focus}"这句话拆解成若干条可形式化的性质（比如"对任意输入 x，函数结果单调不减""舍入误差不会让用户净提取超过其应得份额"）；
2. 检查依赖：Halmos 常见搭配 forge-std 的 Test 合约风格。检查 node_modules/ 或 lib/ 下是否已有 forge-std；没有就尝试 npm install --save-dev forge-std（或等价方式）安装。如果确实无法安装（无网络等），ready=false 并说明，不要硬凑一个不规范的装置；
3. 在 test/halmos/ 下新建证明合约（文件名建议对应 ${mod.file} 基名），为每条性质写一个 function check_<name>(...) 函数：
   - 函数参数即符号变量（Halmos 会自动做符号化），不要在函数体里把参数写死成具体值；
   - 用 vm.assume(...) 给符号输入加合理范围约束，约束必须来自真实业务边界（比如代币精度、经济模型里给出的额度上限），不要为了让证明"更容易通过"而收窄到失去意义；
   - 用 assert(...) 表达要证明的性质；
4. 每条性质记录 boundsAssumed：这次证明实际生效的范围假设是什么（哪些参数被 vm.assume 约束到什么范围、loop 展开界限 ${loopBound}），这是后续判断"证明范围够不够"的关键信息，必须如实、具体地写，不能笼统写"已加约束"。

严格按 schema 返回 JSON。`
}

function proofPrompt(mod, spec, prop, loopBound) {
  return `用 Halmos 对 ${mod.file} 的性质 "${prop.name}"（${prop.statement}）跑符号执行证明。
证明装置：${spec.harnessPath}

1. 确认 halmos 是否已安装（halmos --version；未装尝试 pip3 install halmos）。装不上如实返回 result=ToolUnavailable，不要伪造证明结果；
2. 执行：halmos --contract <装置合约名> --function ${prop.name} --loop ${loopBound}（必要时加 --solver-timeout-assertion 等参数避免无限等待，超时按步骤3处理）；
3. 结果判定（严格三分，不允许模糊）：
   - Halmos 报告该 check_ 函数下**没有找到反例** → result=Proved，boundsAssumed 里写清楚本次实际生效的约束（不能只写"见装置"，要写具体数值范围/loop界限）；
   - Halmos 报告 **Counterexample** → result=Counterexample，把具体反例输入值和为什么违反性质写进 counterexample（禁止编造，必须是 halmos 实际输出的值），并把这个反例转成一个可独立重跑的 Hardhat/Foundry 回归测试，路径填 regressionTestPath；
   - 求解器超时、内存不足、或函数太复杂 Halmos 拒绝分析 → result=Inconclusive，**绝不允许**把这种情况包装成 Proved，如实说明卡在哪一步（比如"loop展开4层仍超时，函数内含未约束的外部调用导致状态空间爆炸"）。

严格按 schema 返回 JSON。`
}

function moduleReportPrompt(mod, proofs) {
  return `汇总 ${mod.file} 的 Halmos 证明结果：
${JSON.stringify(proofs)}

任务：
1. summary：几句话概述这个模块被证明了什么、边界是什么、还有什么没证出来；
2. provedCount/counterexampleCount/inconclusiveCount：对应计数；
3. escalateToCertora：如果存在 Inconclusive（Halmos 证不动，比如跨合约状态空间太大）且这个模块屬于高价值核心逻辑，建议 true，交给人工评估是否值得买 Certora。
严格按 schema 返回 JSON。`
}

function globalPrompt(moduleResults) {
  return `汇总本轮 Halmos 形式化验证的全部模块结果：
${JSON.stringify(moduleResults.map(r => ({ file: r.file, report: r.report })))}

任务：
1. overview：概述本轮覆盖了哪些模块、整体证明情况；
2. blockingItems：列出所有 Counterexample（阻断级，必须先修复再重新验证）；
3. unprovenItems：列出所有 Inconclusive/ToolUnavailable 的条目，明确标注"未证明不等于安全"，避免被误读为已通过。
严格按 schema 返回 JSON。`
}

// ---------------------------------------------------------------------------
// 流水线阶段：单模块 = 设计规格 → 逐条性质证明（并行，需汇总）→ 模块报告
// ---------------------------------------------------------------------------
async function proveStage(spec, mod, loopBound) {
  if (!spec || !spec.ready) {
    log(`⚠️ ${mod.file}：证明装置未就绪（${(spec && spec.blockedReason) || '未知原因'}），跳过`)
    return { file: mod.file, spec, proofs: [] }
  }
  const properties = spec.properties || []
  if (!properties.length) {
    log(`⚠️ ${mod.file}：装置未产出任何可证明的性质，跳过`)
    return { file: mod.file, spec, proofs: [] }
  }
  // 同一模块的多条性质需要汇总进同一份模块报告，属于合理屏障
  const proofs = await parallel(
    properties.map(prop => () =>
      agent(proofPrompt(mod, spec, prop, loopBound), {
        phase: 'Halmos证明',
        schema: PROOF_RESULT_SCHEMA,
        label: `Halmos:${mod.file}:${prop.name}`,
        effort: 'high',
      })
    )
  )
  return { file: mod.file, spec, proofs: proofs.filter(Boolean) }
}

async function reportStage(proveOut, mod) {
  if (!proveOut) return null
  const report = await agent(moduleReportPrompt(mod, proveOut.proofs), {
    phase: '结果汇总',
    schema: MODULE_REPORT_SCHEMA,
    label: `模块报告:${mod.file}`,
  })
  return { file: mod.file, proofs: proveOut.proofs, report }
}

// ===========================================================================
// 主流程
// ===========================================================================
phase('准备')
const modules = args && args.modules && args.modules.length ? args.modules : null
if (!modules) {
  log('未提供 args.modules——本 workflow 要求人工显式指定核心数学模块（AMM曲线/清算/份额舍入等），不做自动发现，流程终止')
  return { error: '缺少 args.modules，请显式指定要证明的核心数学模块及关注点' }
}
const loopBound = (args && args.loopBound) || 4
log(`本轮 Halmos 形式化验证目标模块 ${modules.length} 个：${modules.map(m => m.file).join('、')}，loopBound=${loopBound}`)

phase('规格设计')
const results = await pipeline(
  modules,
  mod => agent(moduleSpecPrompt(mod, loopBound), { phase: '规格设计', schema: MODULE_SPEC_SCHEMA, label: `规格:${mod.file}` }),
  (spec, mod) => proveStage(spec, mod, loopBound),
  (proveOut, mod) => reportStage(proveOut, mod)
)

const valid = results.filter(Boolean)
const dropped = modules.length - valid.length
if (dropped > 0) log(`⚠️ ${dropped}/${modules.length} 个模块在流水线某阶段失败，已跳过，未计入最终报告`)

phase('结果汇总')
const globalReport = await agent(globalPrompt(valid), { phase: '结果汇总', schema: GLOBAL_SCHEMA, label: '总报告' })
log(`Halmos 验证完成：${valid.length}/${modules.length} 个模块走完全流程，阻断项 ${(globalReport.blockingItems || []).length} 条，未证明项 ${(globalReport.unprovenItems || []).length} 条`)

return {
  modules: valid,
  global: globalReport,
}
