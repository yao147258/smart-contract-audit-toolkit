# Changelog

本项目的版本变更记录，格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## Unreleased

### Added

- `smart-contract-audit-pipeline` 新增审计总报告产物 `.audit/reports/audit-latest.md`：汇总全局门禁、L1 扫描结果、逐合约发现与 PoC、人工复核事项，每轮覆盖写入；返回值新增 `archive: { status, path, error }` 字段，归档失败会在日志中告警并如实记录，不影响门禁结论。
- `smart-contract-audit-pipeline` 新增可选参数 `args.metadata`：可传入审查开始/结束时间、总耗时、审查模型、审查人以及各阶段耗时，写入总报告；未传入的字段统一显示为"未提供"，插件不做任何推断。

### Changed

- `meta.phases` 中两个阶段标题更名：`L3 PoC复现` → `L3 PoC 复现`，`L4 复核清单` → `L4 复核与归档`（阶段标题会展示在 UI 上）。

## [0.1.0] - 2026-08-27

### Added

- 首个发布版本，包含三个 Dynamic Workflow：
  - `smart-contract-audit-pipeline`：L1 确定性静态扫描 → L2 LLM 语义审计（四角色对抗×10专项）→ L3 PoC 复现验证 → L4 人工复核清单
  - `invariant-fuzz-campaign`：读取 `.audit/invariants.md`，用 Echidna + Medusa 做长程模糊测试
  - `formal-verification-halmos`：对人工指定的核心数学模块用 Halmos 做有界符号执行证明
- 入口技能 `audit-toolkit-guide`：三工作流定位对比与调用引导
- 单仓库自举 marketplace（`.claude-plugin/marketplace.json`，`source: "./"`）
