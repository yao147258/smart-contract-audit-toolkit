# Smart Contract Audit Toolkit - 工作流详细说明

本文档详细描述四个工作流的执行步骤、所用工具、处理流程和最终产出。

按照**执行顺序**组织：
1. 📋 生成不变量清单（初期准备）
2. ⭐ 抽样式（Fuzz 测试）
3. ⭐⭐⭐ 启发式（语义审计 + PoC）
4. ⭐⭐⭐⭐⭐ 穷尽式（形式化验证）

---

## 0. generate-invariants-template（不变量清单初始化）

### 概述

**目的**：在项目初期，自动发现核心合约，识别系统应该始终成立的性质（不变量），生成 `.audit/invariants.md` 清单文件。

**证明力度**：N/A（辅助工具，不提供安全证明）

**运行成本**：极低（仅需 LLM 分析，无外部工具依赖）

**执行时间**：通常 2-5 分钟

---

### 工作流程与步骤

#### **准备阶段**
| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 0.1 | 解析输入参数 | 无 | 检查用户是否指定了目标合约列表；未指定则自动发现 |

---

#### **合约分析阶段**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 1.1 | 发现核心合约 | **Claude LLM** | 遍历 `contracts/` 目录，识别核心合约（排除 test/、mocks/ 等）<br/>对每个合约识别：<br/>- 合约名、文件路径、用途描述<br/>- 核心状态变量<br/>- 关键 public/external 方法 |
| 1.2 | 合约特征提取 | **Claude LLM** | 为后续不变量识别收集必要的代码信息 |

**合约分析产出**：
- 核心合约列表（name, path, description, primaryStateVars, publicFunctions）

---

#### **不变量识别阶段**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 2.1 | 识别关键性质 | **Claude LLM** | 对每个合约识别 3-5 条关键的系统性质，分类为：<br/>- **conservation**（守恒型）：某种资源/总量必须守恒<br/>  示例：总代币供应量 = sum(balances)<br/>- **state-consistency**（状态一致型）：不同状态变量的一致性<br/>  示例：nonce 单调递增<br/>- **invariant-property**（不变性质）：状态某个属性必须恒真<br/>  示例：用户余额 ≥ 0<br/>- **boundary**（边界条件）：允许的最大/最小值<br/>  示例：交易费用不超过转账额度 |
| 2.2 | 分配 ID 与设计检验方式 | **Claude LLM** | 为每条不变量：<br/>- 分配 ID（INV-01, INV-02, ...）<br/>- 建议检验函数名（遵循 echidna 约定：invariant_*）<br/>- 说明风险背景与 fuzz 测试策略 |
| 2.3 | 质量检查 | **Claude LLM** | 确保不变量满足：<br/>- ✅ 足够具体：能用 Solidity assert() 直接检验<br/>- ✅ 足够重要：违反会导致严重损失<br/>- ✅ 足够独立：不与其他不变量冗余<br/>- ❌ 避免琐碎：不是自证性质 |

**不变量识别产出**：
- 不变量清单（id, description, category, contract, testEntry, rationale, suggestedFuzzStrategy）

---

#### **清单生成与保存阶段**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 3.1 | 生成 Markdown 清单 | 无 | 将结构化数据转换为 `.audit/invariants.md` 的表格格式 |
| 3.2 | 写入磁盘 | **Claude LLM** | 使用 agent 安全隔离地写入文件 |
| 3.3 | 校验写入 | 无 | 确认文件路径正确、内容未被篡改 |

---

### 最终产出物

```
.audit/
└── invariants.md                    # 不变量清单（人工维护的输入文件）
    ├── 表格格式，每行一个不变量
    ├── 字段：ID | 合约 | 描述 | 类别 | 检验方式 | 状态 | 备注
    └── 用户可直接编辑，加入新不变量或调整已有项目
```

### 使用建议

- **何时运行**：项目初期，首次使用 `invariant-fuzz-campaign` 之前；或合约架构大改后重新识别
- **输出审核**：AI 生成的不变量仅供参考，应由**有领域知识的工程师人工审核**，特别关注：
  - 是否遗漏了关键的系统性质
  - 建议的检验函数是否真的能在 Solidity 中简洁实现
  - 不变量描述是否足够准确
- **后续维护**：之后每次修改 `invariants.md` 时直接编辑表格即可，无需重新运行此工作流

---

---

## 1. invariant-fuzz-campaign（不变量深度模糊测试）

### 概述

**目的**：对智能合约的"核心不变量"（系统永远应该成立的性质）进行长程随机测试，发现组合型漏洞——即多笔交易序列才会暴露的状态不一致。

**证明力度**：⭐ 低（抽样式随机测试，可能遗漏）

**运行成本**：低到中等（取决于 fuzz 轮数和时间预算）

**执行时间**：通常 5-20 分钟/轮（可配置）

---

### 工作流程与步骤

#### **准备阶段**
| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 1.1 | 加载不变量清单 | 无 | 读取 `.audit/invariants.md`，解析所有不变量定义 |
| 1.2 | 过滤有效不变量 | 无 | 排除被标记为 `skip: true` 的不变量 |
| 1.3 | 初始化测试环境 | **Hardhat** | 编译合约、生成合约 ABI |
| 1.4 | 准备 Fuzz 装置框架 | 无 | 为每个不变量生成 Echidna/Medusa 兼容的测试装置（harness） |

---

#### **装置生成阶段**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 2.1 | 工具可用性检测 | `echidna` 或 `medusa` | 检测是否已安装 echidna 或 medusa（自动尝试安装） |
| 2.2 | 为每个不变量生成装置 | **Claude LLM** | 将不变量转换为 Solidity 代码中的 `invariant_*()` 函数：<br/><br/>**示例**：<br/>```solidity<br/>// 不变量：总供应量 = sum(balances)<br/>function invariant_total_supply() public {<br/>  assert(token.totalSupply() == sumAllBalances());<br/>}<br/>```<br/><br/>装置特点：<br/>- 每个不变量一个独立的 invariant 函数<br/>- 函数会在每次状态变化后被 fuzzer 调用<br/>- 如果 assert 失败，说明发现了违反不变量的调用序列 |
| 2.3 | 生成 Echidna 装置（如适用） | **Claude LLM** | 生成 `echidna-harness.sol`，包含：<br/>- Solidity 代码<br/>- `invariant_*()` 函数<br/>- 必要的状态追踪和辅助函数<br/>- Echidna 配置注释 |
| 2.4 | 生成 Medusa 装置（如适用） | **Claude LLM** | 生成 `medusa-harness.sol`，Medusa 兼容格式：<br/>- 类似 Echidna 的 invariant 函数<br/>- 额外的 property 定义<br/>- Medusa 特定的钩子函数 |
| 2.5 | 装置验证 | **Hardhat** | 编译生成的装置代码，检查是否有语法错误 |

**装置生成产出**：
- `echidna-harness.sol` - Echidna 格式的测试装置
- `medusa-harness.sol` - Medusa 格式的测试装置
- 配置文件（echidna.yaml / medusa.json）

---

#### **Fuzz 长跑阶段**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 3.1 | 启动 Echidna 长跑（如启用） | **Echidna** | 对装置运行 Echidna：<br/>- **输入**：装置代码 + 不变量函数<br/>- **过程**：随机生成交易序列，调用合约函数，检查不变量<br/>- **时间预算**：由 `minutesPerRound` 指定（默认 5 分钟）<br/>- **轮数**：由 `roundsPerEngine` 指定（默认 3 轮）<br/>- **特点**：<br/>  - 使用基于覆盖率的引导（coverage-guided fuzzing）<br/>  - 保留 corpus（已探索的输入集合），跨轮复用<br/>  - 当发现违反不变量的序列时立即停止并记录反例 |
| 3.2 | Echidna 结果收集 | **Echidna** | 为每轮每个不变量记录：<br/>- 状态：`Passed`、`Falsified`、`Timeout`<br/>- 测试调用次数<br/>- 若 Falsified，记录反例交易序列<br/>- 若 Timeout，说明在时间预算内未完成 |
| 3.3 | 启动 Medusa 长跑（如启用） | **Medusa** | 对装置运行 Medusa：<br/>- 类似 Echidna，但实现不同<br/>- 可能发现 Echidna 遗漏的反例<br/>- 同样时间预算和轮数 |
| 3.4 | Medusa 结果收集 | **Medusa** | 记录同 Echidna 格式 |
| 3.5 | 反例永久保存 | 无 | 将所有 Falsified 的反例交易序列保存到 `.audit/regression/`：<br/>```<br/>.audit/regression/<br/>├── INV-01_falsified_round1.tx<br/>├── INV-02_falsified_round2.tx<br/>└── ...<br/>``` |
| 3.6 | Corpus 更新 | **Echidna** / **Medusa** | 保留最新的 corpus（已探索输入集合）以供下次运行复用 |

**Fuzz 长跑产出**：
- 每个不变量 × 每个引擎 × 每轮 = 一条结果记录
- 若有 Falsified：附带反例交易序列
- Corpus 文件（供后续增量 fuzz 复用）

---

#### **结果归档阶段**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 4.1 | 结果汇总与分类 | 无 | 收集所有 fuzz 结果：<br/>- 按不变量分组<br/>- 按引擎分组<br/>- 按轮次分组 |
| 4.2 | 阻断项识别 | 无 | 筛选所有 Falsified 的结果 = **阻断项**<br/>- 任何 Falsified 都意味着发现了组合型漏洞<br/>- 必须进一步分析和修复 |
| 4.3 | 生成 Fuzz 报告 | 无 | 创建 `.audit/reports/invariant-fuzz-latest.md`，包含：<br/>- **概览** - 运行参数（引擎、轮数、时间预算）<br/>- **统计** - 总不变量数、通过/失败分布<br/>- **阻断项** - 所有 Falsified 的不变量及反例<br/>- **逐不变量明细** - 每个不变量按引擎展开 |
| 4.4 | 报告写入磁盘 | 无 | 覆盖写入 `.audit/reports/invariant-fuzz-latest.md` |

---

### 最终产出物

```
项目目录/
├── .audit/
│   ├── invariants.md                          # 不变量定义清单（输入）
│   ├── regression/
│   │   ├── INV-01_falsified_round1.tx         # 反例 1
│   │   ├── INV-02_falsified_round2.tx         # 反例 2
│   │   └── ...
│   ├── corpus/                                # Echidna/Medusa corpus（后续复用）
│   │   ├── echidna-corpus/
│   │   └── medusa-corpus/
│   └── reports/
│       └── invariant-fuzz-latest.md           # ✨ 本轮 Fuzz 报告
```

---

---

## 2. smart-contract-audit-pipeline（四层审计流水线）

### 概述

**目的**：对 Hardhat 智能合约项目进行全面、多角度的安全审计，从确定性静态扫描到人工复核，形成完整的审计报告。

**证明力度**：⭐⭐⭐ 中等（启发式审计 + 局部 PoC 验证）

**运行成本**：中等（取决于合约数量和代码量）

**执行时间**：通常 5-15 分钟（含 L1-L4 所有阶段）

---

### 工作流程与步骤

#### **准备阶段**
| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 1.1 | 自动发现审计目标 | 无 | 遍历 `contracts/` 目录，识别核心合约（排除测试、mock、library 等） |
| 1.2 | 初始化 `.audit/` 目录结构 | 无 | 创建 `.audit/invariants.md`、`.audit/false-positives.md` 等配置文件（如不存在） |
| 1.3 | 加载已知误报与豁免 | 无 | 读取 `.audit/false-positives.md` 和 `.audit/exemptions.md`，后续 L2 阶段降噪 |

---

#### **L1 阶段 - 静态扫描**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 2.1 | 工具可用性检测 | `slither` 或 `aderyn` | 检测是否已安装 slither 或 aderyn（如未安装自动尝试安装） |
| 2.2 | 运行确定性扫描 | **slither** 或 **aderyn** | 对所有目标合约进行静态分析，检测重入、权限问题、整数溢出、未初始化变量等 |
| 2.3 | 结果收集与聚合 | 无 | 合并各工具输出，按 Severity（Critical/High/Medium/Low/Info）分类 |
| 2.4 | 误报过滤 | 无 | 对比 `.audit/false-positives.md`，移除已知误报 |
| 2.5 | 生成 L1 原始报告 | 无 | 输出 `.audit/reports/slither-report.json` 或类似格式 |

**L1 产出**：确定性发现清单（高可信度）

---

#### **L2 阶段 - LLM 语义审计**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 3.1 | 合约源码加载 | 无 | 读取目标合约的完整 Solidity 代码 |
| 3.2 | 四角色对抗审计 | **Claude LLM** | 🔵审计员 → 🔴攻击者 → 🟢修复工程师 → ⚖️裁判，逐个角色分析 |
| 3.3 | 10 大专项类别分析 | **Claude LLM** | 重入、访问控制、精度、预言机、业务逻辑等专项深度分析 |
| 3.4 | 结果去重与合并 | **Claude LLM** | 识别重复发现，合并视角，去掉已知误报 |
| 3.5 | 标记需要 PoC 验证的项 | 无 | 根据发现的确定性，标记哪些需要进入 L3 |

**L2 产出**：语义级发现清单（中等可信度）

---

#### **L3 阶段 - PoC 复现验证**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 4.1 | 收集待验证发现 | 无 | 筛选 L2 中被标记为"需要验证"的发现 |
| 4.2 | PoC 生成 | **Claude LLM** | 生成可运行的 Hardhat test 代码 |
| 4.3 | PoC 执行与验证 | **Hardhat** | 实际运行 PoC，记录执行结果 |
| 4.4 | 验证结果分类 | 无 | Confirmed / Invalid / Inconclusive |
| 4.5 | 反例永久保存 | 无 | 将有效的 PoC 保存到 `.audit/regression/`，作为回归测试 |

**L3 产出**：PoC 验证报告（已确认发现）

---

#### **L4 阶段 - 复核与归档**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 5.1 | 汇总审计发现 | 无 | 收集 L1/L2/L3 的全部发现，按合约分组 |
| 5.2 | 生成人工复核清单 | **Claude LLM** | 为每条发现生成复核清单项（必须修复/建议修复/可接受/需人工判断） |
| 5.3 | 记录豁免决策 | 无 | 对于可接受风险项，检查是否有书面豁免记录 |
| 5.4 | 生成总报告 | 无 | 创建 `.audit/reports/audit-latest.md`（门禁、概览、发现、PoC、复核清单、元信息） |
| 5.5 | 报告写入磁盘 | 无 | 覆盖写入 `.audit/reports/audit-latest.md` |

**L4 产出**：完整审计总报告 + 复核清单（AI输出，人工最终决策）

**关键原则**：
- L4 输出的是"复核清单"，**不是最终结论**
- 误报入库、书面豁免、放行测试必须由**人签字**
- AI 不代签任何决策

---

### 最终产出物

```
项目目录/
├── .audit/
│   ├── invariants.md
│   ├── false-positives.md
│   ├── exemptions.md
│   ├── regression/
│   │   ├── reentrancy_poc.js
│   │   ├── access_control_poc.js
│   │   └── ...
│   └── reports/
│       ├── slither-report.json
│       ├── aderyn-report.json
│       └── audit-latest.md           # ✨ 本轮 L1-L4 总报告
```

---

---

## 3. formal-verification-halmos（形式化验证）

### 概述

**目的**：对人工指定的"核心数学模块"（如 AMM 定价曲线、清算计算、份额舍入等）进行有界符号执行，在给定边界内穷尽验证数学正确性。

**证明力度**：⭐⭐⭐⭐⭐ 高（有界穷尽，但需声明边界）

**运行成本**：高（符号执行可能很慢）

**执行时间**：通常 10-30 分钟（取决于函数复杂度和 loopBound）

**重要限制**：Halmos 的证明是**有条件的**——"在给定边界内未发现反例"，不等于"无条件安全"

---

### 工作流程与步骤

#### **准备阶段**
| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 1.1 | 验证 modules 参数 | 无 | 确保用户显式指定了 `modules`（必填，不指定则报错） |
| 1.2 | 加载目标源码 | 无 | 读取指定模块的 Solidity 代码 |
| 1.3 | 识别核心函数 | **Claude LLM** | 根据 `focus` 描述，识别需要证明的函数 |
| 1.4 | 记录证明边界 | 无 | 根据 `loopBound` 和用户说明，记录本次验证的边界假设 |

---

#### **规格设计阶段**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 2.1 | 分析函数数学语义 | **Claude LLM** | 理解函数的数学含义、输入约束、输出关系、边界情况 |
| 2.2 | 设计形式化规格 | **Claude LLM** | 用自然语言或准形式化语言描述待验证的性质（PRE/POST/不变量） |
| 2.3 | 设计测试装置 | **Claude LLM** | 生成 Solidity 代码：symbolic wrapper + 前置条件 + assert 语句 + Halmos 钩子 |

**规格设计产出**：形式化规格 + Halmos 兼容的 Solidity 测试装置

---

#### **Halmos 证明阶段**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 3.1 | 工具可用性检测 | `halmos` | 检测是否已安装 halmos（自动尝试安装） |
| 3.2 | 编译装置代码 | **Hardhat** | 将 Solidity 装置代码编译为字节码 |
| 3.3 | 启动 Halmos 符号执行 | **Halmos** | 运行 Halmos：符号执行所有路径 → 检查 assert → 若违反则收集反例 |
| 3.4 | 处理验证结果 | 无 | 分类：Proved / Counterexample / Inconclusive / ToolUnavailable |
| 3.5 | 反例分析与记录 | **Claude LLM** | 对于 Counterexample，生成人类可读的说明（条件、违反原因、风险、修复建议） |

**Halmos 证明产出**：每个函数一条证明结果（Proved/Counterexample/Inconclusive）

---

#### **结果汇总阶段**

| 步骤 | 操作 | 工具 | 说明 |
|------|------|------|------|
| 4.1 | 收集所有模块的证明结果 | 无 | 汇总本次验证的所有函数结果 |
| 4.2 | 识别阻断项 | 无 | Counterexample 项 = **阻断项**（表示发现了数学错误，必须修复） |
| 4.3 | 验证假设完整性 | **Claude LLM** | 检查证明中使用的所有假设是否都被明确记录 |
| 4.4 | 生成验证报告 | 无 | 创建 `.audit/reports/halmos-verification-latest.md`（参数、概览、阻断项、边界假设、逐模块明细、诚实声明） |
| 4.5 | 报告写入磁盘 | 无 | 覆盖写入 `.audit/reports/halmos-verification-latest.md` |

---

### 最终产出物

```
项目目录/
├── .audit/
│   ├── regression/
│   │   ├── halmos-counterexample-1.txt
│   │   └── ...
│   └── reports/
│       └── halmos-verification-latest.md    # ✨ 本轮验证报告
```

---

## 总结对比

| 工作流 | 验证方式 | 运行时间 | 可信度 | 何时用 |
|--------|--------|---------|--------|--------|
| **generate-invariants-template** | 代码分析 + LLM 识别 | 2-5 分钟 | N/A | 项目初期，首次使用 fuzz 前 |
| **invariant-fuzz-campaign** | 随机测试 + 抽样覆盖 | 5-20 分钟 | ⭐ 低 | 核心逻辑改动后，周期性跑 |
| **smart-contract-audit-pipeline** | L1 静态 + L2 LLM + L3 PoC | 5-15 分钟 | ⭐⭐⭐ 中 | 默认入口，所有审计前 |
| **formal-verification-halmos** | 符号执行 + 穷尽验证 | 10-30 分钟 | ⭐⭐⭐⭐⭐ 高 | 数学模块需证明时，手动触发 |

### 建议工作流用法顺序

**首次使用（项目初期）**：
```
1. generate-invariants-template  ← 生成不变量清单
   ↓ （人工审核与调整 .audit/invariants.md）
2. smart-contract-audit-pipeline ← L1-L4 完整审计
   ↓ （修复发现的问题）
3. invariant-fuzz-campaign       ← 运行深度 fuzz 验证不变量
```

**常规迭代**：
```
- 代码改动后 → smart-contract-audit-pipeline（快速检查）
- 核心逻辑改动 → invariant-fuzz-campaign（fuzz 验证）
- 数学模块改动 → formal-verification-halmos（需要人工指定modules）
```

---

## 关键原则总结

1. **三个工作流是互补的**，而非替代关系
2. **AI 输出都是辅助**，最终决策必须由人签字
3. **Halmos "未发现反例" ≠ "无条件安全"**，必须声明边界
4. **工具装不上不会伪造结果**，会如实说明"不可用"
5. **所有产出物都保存在 `.audit/` 目录**，便于追踪和复用
