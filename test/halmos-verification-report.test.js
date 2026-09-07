import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const workflowPath = fileURLToPath(new URL('../workflows/formal-verification-halmos.js', import.meta.url))
const workflowSource = readFileSync(workflowPath, 'utf8')

const BEGIN_MARKER = '// ==== BEGIN HALMOS VERIFICATION REPORT PURE HELPERS'
const END_MARKER = '// ==== END HALMOS VERIFICATION REPORT PURE HELPERS ===='

const extractPureHelpers = () => {
  const beginIdx = workflowSource.indexOf(BEGIN_MARKER)
  const endIdx = workflowSource.indexOf(END_MARKER)
  if (beginIdx === -1 || endIdx === -1) throw new Error('哨兵注释不存在')
  const beginNewline = workflowSource.indexOf('\n', beginIdx)
  let code = workflowSource.substring(beginNewline + 1, endIdx)

  const exportNames = [...code.matchAll(/export\s+(?:function|const)\s+(\w+)/g)].map(m => m[1])

  code = code.split('\n').map(line => line.replace(/^export\s+/, '')).join('\n')
  code += `\nreturn { ${exportNames.join(', ')} };`

  const wrapper = `'use strict';\n${code}\n`
  return new Function(wrapper)()
}

const helpers = extractPureHelpers()
const { buildHalmosVerificationMarkdown, reportArchivePrompt } = helpers

test('buildHalmosVerificationMarkdown 汇总概览、阻断项、未证明项与逐模块明细', () => {
  const markdown = buildHalmosVerificationMarkdown({
    runParams: { loopBound: 4 },
    global: {
      overview: '2 个模块完成验证，1 处反例，1 处未证明',
      blockingItems: ['MathLib.sol: check_shareRoundingNoValueLeak 存在反例'],
      unprovenItems: ['RateModel.sol: check_monotonic 求解超时'],
    },
    modules: [
      {
        file: 'contracts/libraries/MathLib.sol',
        proofs: [
          { file: 'contracts/libraries/MathLib.sol', propertyName: 'check_shareRoundingNoValueLeak', result: 'Counterexample', boundsAssumed: 'amount<=uint96, loop=4', counterexample: 'amount=1, shares=0 -> 净提取超额', regressionTestPath: '.audit/regression/POC-MathLib-rounding.js' },
        ],
        report: { file: 'contracts/libraries/MathLib.sol', summary: '份额舍入存在反例，需人工修复', provedCount: 0, counterexampleCount: 1, inconclusiveCount: 0, escalateToCertora: false },
      },
      {
        file: 'contracts/RateModel.sol',
        proofs: [
          { file: 'contracts/RateModel.sol', propertyName: 'check_monotonic', result: 'Inconclusive', boundsAssumed: 'loop=4，求解器超时', regressionTestPath: '' },
        ],
        report: { file: 'contracts/RateModel.sol', summary: '单调性未能在给定边界内证明或证伪', provedCount: 0, counterexampleCount: 0, inconclusiveCount: 1, escalateToCertora: true },
      },
    ],
  })

  assert.match(markdown, /# Halmos 形式化验证报告/)
  assert.match(markdown, /loop.*4|loopBound.*4/)
  assert.match(markdown, /2 个模块完成验证，1 处反例，1 处未证明/)
  assert.match(markdown, /MathLib\.sol: check_shareRoundingNoValueLeak 存在反例/)
  assert.match(markdown, /RateModel\.sol: check_monotonic 求解超时/)
  assert.match(markdown, /check_shareRoundingNoValueLeak/)
  assert.match(markdown, /净提取超额/)
  assert.match(markdown, /POC-MathLib-rounding\.js/)
  assert.match(markdown, /check_monotonic/)
  assert.match(markdown, /Inconclusive/)
  assert.match(markdown, /contracts\/RateModel\.sol \|[^\n]*\| 是 \|/)
  assert.match(markdown, /无条件证明安全|不等于.*证明|不代表.*安全/)
})

test('buildHalmosVerificationMarkdown 在没有模块时明确显示"无"而不是留空', () => {
  const markdown = buildHalmosVerificationMarkdown({
    runParams: { loopBound: 4 },
    global: { overview: '未提供模块', blockingItems: [], unprovenItems: [] },
    modules: [],
  })

  assert.match(markdown, /未提供模块/)
  assert.match(markdown, /无/)
})

test('reportArchivePrompt 要求将报告覆盖写入固定路径并如实返回状态', () => {
  const prompt = reportArchivePrompt('# 示例报告')

  assert.match(prompt, /\.audit\/reports\/halmos-verification-latest\.md/)
  assert.match(prompt, /覆盖/)
  assert.match(prompt, /不得编造/)
  assert.match(prompt, /Written/)
  assert.match(prompt, /Failed/)
})

test('workflow 静态声明固定四阶段并保留顶层 phase 顺序', () => {
  const REPORT_STAGE_NAMES = ['准备', '规格设计', 'Halmos证明', '结果汇总']
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
