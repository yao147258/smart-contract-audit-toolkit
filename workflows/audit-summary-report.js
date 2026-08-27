const REPORT_STAGE_NAMES = [
  '准备',
  'L1 静态扫描',
  'L2 语义审计',
  'L3 PoC 复现',
  'L4 复核与归档',
]

function displayValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '未提供'
}

export { REPORT_STAGE_NAMES }

export function normalizeReportMetadata(metadata = {}) {
  const source = metadata || {}
  const suppliedStages = Array.isArray(source.stages) ? source.stages : []
  return {
    startedAt: displayValue(source.startedAt),
    endedAt: displayValue(source.endedAt),
    totalDuration: displayValue(source.totalDuration),
    model: displayValue(source.model),
    reviewer: displayValue(source.reviewer),
    stages: REPORT_STAGE_NAMES.map(name => {
      const supplied = suppliedStages.find(stage => stage && stage.name === name) || {}
      return {
        name,
        startedAt: displayValue(supplied.startedAt),
        endedAt: displayValue(supplied.endedAt),
        duration: displayValue(supplied.duration),
        status: displayValue(supplied.status),
      }
    }),
  }
}

function markdownCell(value) {
  if (value === undefined || value === null || value === '') return '未提供'
  return String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, '<br>')
}

function listValue(values) {
  return Array.isArray(values) && values.length ? values : ['无']
}

function booleanValue(value) {
  return value === true ? '是' : value === false ? '否' : '未提供'
}

export function buildAuditSummaryMarkdown(input = {}) {
  const metadata = normalizeReportMetadata(input.metadata)
  const targets = Array.isArray(input.targets) ? input.targets : []
  const categories = Array.isArray(input.categories) ? input.categories : []
  const l1 = input.l1 || {}
  const perTarget = Array.isArray(input.perTarget) ? input.perTarget : []
  const global = input.global || {}
  const lines = [
    '# 智能合约审计总报告',
    '',
    '> 本报告由内部 AI 审计流水线生成，用于人工复核；不是最终放行结论。',
    '',
    '## 审查元信息',
    '| 元信息 | 值 |',
    '|---|---|',
    `| 审查开始时间 | ${markdownCell(metadata.startedAt)} |`,
    `| 审查结束时间 | ${markdownCell(metadata.endedAt)} |`,
    `| 总耗时 | ${markdownCell(metadata.totalDuration)} |`,
    `| 审查模型 | ${markdownCell(metadata.model)} |`,
    `| 审查人 | ${markdownCell(metadata.reviewer)} |`,
    `| 审计范围 | ${targets.length ? targets.map(target => '`' + markdownCell(target) + '`').join('、') : '无'} |`,
    `| L2 专项 | ${categories.length ? categories.map(category => {
      const key = typeof category === 'string' ? category : category.key
      const label = typeof category === 'string' ? category : category.label
      return `${markdownCell(label || key)}（${markdownCell(key)}）`
    }).join('、') : '无'} |`,
    `| L3 PoC | ${input.skipL3 ? '已跳过' : '已执行'} |`,
    '',
    '## 各阶段执行耗时',
    '| 阶段 | 开始时间 | 结束时间 | 耗时 | 状态 |',
    '|---|---|---|---|---|',
    ...metadata.stages.map(stage => `| ${markdownCell(stage.name)} | ${markdownCell(stage.startedAt)} | ${markdownCell(stage.endedAt)} | ${markdownCell(stage.duration)} | ${markdownCell(stage.status)} |`),
    '',
    '## 全局结论与门禁',
    `- 总览：${markdownCell(global.overview)}`,
    `- readyForDelivery | ${booleanValue(global.readyForDelivery)}`,
    `- L1 gatePass | ${booleanValue(l1.gatePass)}`,
    '- blockingItems：',
    ...listValue(global.blockingItems).map(item => `  - ${markdownCell(item)}`),
    '',
    '| 目标合约 | gatePass |',
    '|---|---|',
    ...(Array.isArray(global.perTargetGate) && global.perTargetGate.length
      ? global.perTargetGate.map(item => `| ${markdownCell(item.target)} | ${booleanValue(item.gatePass)} |`)
      : ['| 无 | 未提供 |']),
    '',
    '## L1 静态扫描',
    `- 工具：${l1.toolsAvailable && l1.toolsAvailable.length ? l1.toolsAvailable.map(markdownCell).join('、') : '无'}`,
    `- High：${markdownCell(l1.highCount)}`,
    `- Medium：${markdownCell(l1.mediumCount)}`,
    `- Low：${markdownCell(l1.lowCount)}`,
    '',
    '| 文件 | 严重度 | 工具 | 标题 | 描述 | 位置 |',
    '|---|---|---|---|---|---|',
    ...(Array.isArray(l1.findings) && l1.findings.length
      ? l1.findings.map(finding => `| ${markdownCell(finding.file)} | ${markdownCell(finding.severity)} | ${markdownCell(finding.tool)} | ${markdownCell(finding.title)} | ${markdownCell(finding.description)} | ${markdownCell(finding.location)} |`)
      : ['| 无 | 无 | 无 | 无 | 无 | 无 |']),
    '',
    '## 逐合约审计结果',
  ]

  if (!perTarget.length) {
    lines.push('无')
  } else {
    perTarget.forEach(result => {
      const gate = result.gate || {}
      lines.push('', `### ${markdownCell(result.target)}`, '', '| 门禁项 | 值 |', '|---|---|',
        `| l1HighZero | ${booleanValue(gate.l1HighZero)} |`,
        `| criticalHighCount | ${markdownCell(gate.criticalHighCount)} |`,
        `| evidenceComplete | ${booleanValue(gate.evidenceComplete)} |`,
        `| gatePass | ${booleanValue(gate.gatePass)} |`, '',
        '#### Findings', '| 标题 | 严重度 | 状态 | 影响 | 可能性 | 攻击路径 | 最小补丁 |', '|---|---|---|---|---|---|---|')
      const findings = Array.isArray(result.confirmedFindings) ? result.confirmedFindings : []
      lines.push(...(findings.length ? findings.map(finding => `| ${markdownCell(finding.title)} | ${markdownCell(finding.severity)} | ${markdownCell(finding.status)} | ${markdownCell(finding.impact)} | ${markdownCell(finding.likelihood)} | ${markdownCell(finding.attackPath)} | ${markdownCell(finding.minimalPatch)} |`) : ['| 无 | 无 | 无 | 无 | 无 | 无 | 无 |']))
      lines.push('', '#### PoC', '| 发现 | 状态 | 迭代次数 | 测试路径 | 证据 |', '|---|---|---|---|---|')
      const pocs = Array.isArray(result.pocResults) ? result.pocResults : []
      lines.push(...(pocs.length ? pocs.map(poc => `| ${markdownCell(poc.findingTitle)} | ${markdownCell(poc.status)} | ${markdownCell(poc.iterations)} | ${markdownCell(poc.testPath)} | ${markdownCell(poc.evidence)} |`) : ['| 无 | 无 | 无 | 无 | 无 |']))
      const report = result.report || {}
      lines.push('', `- L4 摘要：${markdownCell(report.summary)}`)
    })
  }

  lines.push('', '## 人工复核事项')
  const humanItems = perTarget.flatMap(result => {
    const report = result.report || {}
    return [
      ...listValue(report.openItemsForHuman).map(item => `${result.target || '未提供'}：${item}`),
      ...listValue(report.suggestedFalsePositiveEntries).map(item => `${result.target || '未提供'}：建议误报条目：${item}`),
    ]
  })
  lines.push(...(humanItems.length ? humanItems.map(item => `- ${markdownCell(item)}`) : ['无']))

  lines.push('', '## 免责声明', '', '本报告仅汇总自动化审计流水线的观测结果、候选发现、PoC 证据和 L4 人工复核事项。AI 不代替人工签字，不直接写入误报库、豁免库或回归目录；本报告不是最终放行结论。')
  return lines.join('\n')
}
