# generate-invariants-template 工作流使用指南

## 概述

`generate-invariants-template` 是 smart-contract-audit-toolkit 的第一个工作流，专门用于**项目初期识别和生成系统核心不变量清单**。

在使用 `invariant-fuzz-campaign` 进行长程模糊测试前，你需要先定义"什么是系统应该始终成立的性质"。本工作流帮你自动发现合约、分析代码结构、并推荐候选不变量。

## 何时使用

- ✅ **项目初期**：首次建立审计框架时
- ✅ **合约架构大改**：核心合约逻辑有重大改动，需要重新审视不变量
- ✅ **新增核心模块**：加入新的状态管理或业务逻辑时
- ❌ **常规迭代**：日常 bug 修复通常不需要重新运行此工作流

## 工作流的四个阶段

### 1️⃣ 准备阶段
解析输入参数，确定是否指定了目标合约还是自动发现。

**输入选项**：
- 不指定 → 自动发现 `contracts/` 目录下的所有核心合约
- 指定合约列表 → 仅分析指定的合约

### 2️⃣ 合约分析
遍历合约目录，识别核心合约并提取特征：
- 合约名、文件路径、主要用途
- 核心状态变量（如 `totalSupply`, `balances`, `reserveA`, `reserveB`）
- 关键的 public/external 方法（对状态有修改的）

**排除项**：测试合约、Mock 合约、纯库合约（通常这些不是 fuzz 的直接目标）

### 3️⃣ 不变量识别
基于合约分析结果，LLM 识别系统应该始终成立的关键性质。

**四种不变量类别**：

| 类别 | 定义 | 示例 |
|------|------|------|
| **conservation** | 某种资源/总量必须守恒 | `totalSupply == sum(balances)` |
| **state-consistency** | 不同状态变量间的一致性约束 | `collateral >= debt`（清算安全） |
| **invariant-property** | 某个状态属性必须恒真 | `balance >= 0`（非负性） |
| **boundary** | 允许的最大/最小值约束 | `feeRatio <= 100%` |

### 4️⃣ 清单生成与保存
将识别到的不变量汇总成 Markdown 表格，写入 `.audit/invariants.md`。

**输出文件格式**：
```
| ID | 合约 | 描述 | 类别 | 检验方式 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| INV-01 | Token | 总供应量守恒 | conservation | invariant_total_supply | 进行中 | ... |
| INV-02 | Vault | 清算安全 | state-consistency | invariant_solvency | 进行中 | ... |
```

## 使用示例

### 基础用法：自动发现合约
```bash
/smart-contract-audit-toolkit:generate-invariants-template
```

系统会：
1. 扫描 `contracts/` 目录
2. 自动识别核心合约（通常是去掉 Mocks/Libraries 后的合约）
3. 为每个合约识别关键不变量
4. 生成 `.audit/invariants.md` 清单文件

### 高级用法：指定目标合约
```bash
/smart-contract-audit-toolkit:generate-invariants-template contracts/Token.sol,contracts/Vault.sol
```

系统只分析指定的两个合约，忽略其他合约。

## 生成的不变量清单结构

### 文件位置
`.audit/invariants.md`

### 文件内容
```markdown
# 系统不变量清单

> 本文件定义了项目核心合约中应该始终成立的系统性质...

| ID | 合约 | 描述 | 类别 | 检验方式 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| INV-01 | Token | ... | conservation | invariant_total_supply | 进行中 | ... |
| ... | ... | ... | ... | ... | ... | ... |
```

### 表格字段说明

| 字段 | 含义 | 示例 |
|------|------|------|
| **ID** | 不变量编号 | `INV-01`, `INV-02` |
| **合约** | 涉及的合约名 | `Token`, `Vault` |
| **描述** | 自然语言描述不变量 | `总代币供应量 = sum(用户余额)` |
| **类别** | 不变量类型 | `conservation`, `state-consistency`, `invariant-property`, `boundary` |
| **检验方式** | echidna 检验函数名 | `invariant_total_supply` |
| **状态** | 当前状态 | `进行中`, `跳过`, `N/A` |
| **备注** | 风险说明与 fuzz 策略 | `ERC20 标准守恒性；fuzz 策略：任意 mint/burn/transfer` |

## 生成后的工作流

### 步骤 1：AI 自动生成 ✅
运行 `generate-invariants-template` → 生成初版 `.audit/invariants.md`

### 步骤 2：人工审核与调整 👤
打开 `.audit/invariants.md`，检查：
- ✅ 是否遗漏了关键的系统性质
- ✅ 建议的不变量描述是否准确
- ✅ 检验函数是否真的能在 Solidity 中简洁实现
- ✅ 不变量的重要性和独立性

**可能的调整**：
- 删除琐碎或冗余的不变量
- 添加 AI 遗漏的关键性质
- 调整不变量描述使其更精确
- 对复杂的不变量标记为 `跳过`，并在备注中说明需要人工补充 fixture

### 步骤 3：后续使用 🚀
确认清单无误后，用于：
- **`invariant-fuzz-campaign`** → 读取清单，生成 fuzz 装置，运行模糊测试
- **人工代码审核** → 参考清单理解系统的关键不变量

## 常见问题

### Q: AI 识别的不变量不准确怎么办？
**A**: 完全正常！AI 生成的只是初稿。打开 `.audit/invariants.md` 直接编辑：
- 删除不合适的行
- 修改不变量描述
- 添加新的不变量

不需要重新运行工作流。

### Q: 如果我后来修改了合约，需要重新运行吗？
**A**: 不必要。只需要在 `.audit/invariants.md` 中手工更新：
- 如果新增了状态变量或改动了核心逻辑 → 补充新的不变量行
- 如果删除了某个功能 → 删除对应的不变量行
- 更新"状态"列（从 `进行中` → `跳过` 或反之）

### Q: 什么情况下需要重新运行 `generate-invariants-template`？
**A**: 仅在以下情况考虑：
- 项目架构完全重构，几乎没有可复用的不变量
- 新增了一个全新的核心合约模块，想快速生成候选
- 清单文件丢失或损坏，需要重新生成骨架

### Q: 我想在特定的"非恶意"假设下检验不变量，怎么处理？
**A**: 在不变量的"备注"字段中明确说明。例如：
```
| INV-07 | AMM | 滑点 <= 5% | boundary | invariant_slippage | 进行中 | 假设：用户输入合法费率，无 oracle 闪现攻击 |
```

## 与其他工作流的协作

### invariant-fuzz-campaign（不变量模糊测试）
**依赖关系**：`generate-invariants-template` → `invariant-fuzz-campaign`
- `generate-invariants-template` 生成 `.audit/invariants.md`
- `invariant-fuzz-campaign` 读取该清单，生成 fuzz 装置并测试

### smart-contract-audit-pipeline（L1-L4 审计）
**独立关系**：两个工作流各自运行
- `generate-invariants-template` 帮助识别系统关键性质
- `smart-contract-audit-pipeline` 做 L1 静态扫描和 L2 语义审计

## 工作流输出物

### 返回值（Workflow 返回的结构化结果）
```javascript
{
  contracts: [
    {
      name: 'Token',
      path: 'contracts/Token.sol',
      description: 'ERC20 代币实现',
      primaryStateVars: ['totalSupply', 'balances', 'allowances'],
      publicFunctions: ['transfer', 'approve', 'mint', 'burn']
    },
    // ...
  ],
  invariants: [
    {
      id: 'INV-01',
      description: '总供应量 = sum(所有用户余额)',
      category: 'conservation',
      contract: 'Token',
      testEntry: 'invariant_total_supply',
      rationale: 'ERC20 标准守恒性，防止代币凭空增减',
      suggestedFuzzStrategy: '任意 mint/burn/transfer 操作'
    },
    // ...
  ],
  archive: {
    status: 'Written' 或 'Failed',
    path: '.audit/invariants.md',
    invariantCount: 8
  }
}
```

### 生成的文件
- **`.audit/invariants.md`** ← 清单文件（输出）
- **`.audit/`** 目录（自动创建）

## 最佳实践

1. **及时审核** → 生成清单后立即审核，而不是几周后再看
2. **增量更新** → 合约改动时直接编辑清单，不需要重新运行工作流
3. **备注详细** → 在"备注"字段清晰说明不变量的风险背景和 fuzz 策略
4. **状态清晰** → 用"进行中"、"跳过"、"N/A" 标记每条不变量的验证状态
5. **版本控制** → 将 `.audit/invariants.md` 提交到 git，追踪不变量的演变

## 技术细节

### 合约自动发现逻辑
- 扫描 `contracts/` 目录（递归）
- 排除：`test/`, `mocks/`, 名称包含 `Mock` 或 `Library` 的文件
- 优先级：按文件名和目录位置启发式判断"核心程度"

### 不变量识别策略
- 分析合约的状态变量和方法签名
- 识别"多个变量间的守恒关系"→ **conservation**
- 识别"单个变量必须恒真的属性"→ **invariant-property**
- 识别"跨变量的一致性约束"→ **state-consistency**
- 识别"参数的合理范围"→ **boundary**

### 检验函数命名约定
遵循 Echidna 标准：
- 前缀：`invariant_`
- 返回类型：`bool`
- 无参数：`public view`
- 示例：`function invariant_total_supply() public view returns (bool)`

## 更多资源

- 📖 详细工作流说明：见 `docs/workflow-details.md` 第 0 节
- 📋 不变量清单模板：见 `.audit/invariants.md.template`
- 🧪 后续 Fuzz 运行：见 README.md 的 `invariant-fuzz-campaign` 部分
