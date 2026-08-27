# Changelog

本项目的版本变更记录，格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [0.1.0] - 2026-08-27

### Added

- 首个发布版本，包含三个 Dynamic Workflow：
  - `smart-contract-audit-pipeline`：L1 确定性静态扫描 → L2 LLM 语义审计（四角色对抗×10专项）→ L3 PoC 复现验证 → L4 人工复核清单
  - `invariant-fuzz-campaign`：读取 `.audit/invariants.md`，用 Echidna + Medusa 做长程模糊测试
  - `formal-verification-halmos`：对人工指定的核心数学模块用 Halmos 做有界符号执行证明
- 入口技能 `audit-toolkit-guide`：三工作流定位对比与调用引导
- 单仓库自举 marketplace（`.claude-plugin/marketplace.json`，`source: "./"`）
