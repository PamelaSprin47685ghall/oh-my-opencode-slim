# PRD 变更日志

## 2026-05-22: 移除超时机制，新增原理 N（时间无关性）

### 1. 问题

`squad-tool.ts` 和 `command.ts` 中存在 `SQUAD_TIMEOUT_MS = 10 * 60 * 1000`（10 分钟超时），用 `Promise.race` 包裹 `runSquad`。这与 nudge 机制的设计意图矛盾——nudge 基于次数而非时间（PRD-07 原理 N），超时是多余的时间假设。

此外，nudge prompt 未携带 `agent` 和 `tools` 参数，导致子会话在 nudge 后丢失 squad 属性和阶段专属报告工具。

### 2. 代码变更

- 移除 `squad-tool.ts` 和 `command.ts` 中的 `SQUAD_TIMEOUT_MS` 常量和 `Promise.race` 超时包装，直接 `await runSquad(...)`。
- 修复 `runtime.ts` nudge prompt：补全 `agent: stageAgent(ctx.stage)` 和 `tools: stageTools(ctx.stage)`，与初始 `createChild` 行为一致。

### 3. PRD 变更

- 新增原理 N：整个实现与时间无关。liveness 完全由语义信号和次数保证。
- PRD-01：新增原理 N 定义和约束，更新架构特征表。
- PRD-02：原理表新增 N 行，"哪些设计被原理证明是多余的"表新增 `SQUAD_TIMEOUT_MS` 条目。
- PRD-04：schema 校验失败后的描述从"等待超时"改为"nudge 机制检测"。
- PRD-07：移除超时相关描述，将"最大挂起时间与保活衰退契约"改为"保活衰退契约"，移除整体超时条目；Gate 故障模式表中 AI SDK force-kill 对策从"squad-tool timeout 作为最终保底"改为"进程已死，无需处理"；Liveness invariants 中"timeout/abort 清理"改为"abort 清理"。

---

## 2026-05-21: 插件移植 — 从 addon wrapper 架构到 OpenCode plugin 架构

### 1. 架构变更

原 squad 是另一个项目的 addon wrapper，包装 `task` 和 `agent_report` 两个已有 tool。现移植为 oh-my-opencode-slim 插件，使用 OpenCode SDK 的 `client.session.create()` / `client.session.prompt()` API 创建和管理子会话，用阶段专属报告工具取代 `agent_report` 拦截。

### 2. 核心机制变更

| 原架构 | 新架构 | 原因 |
|--------|--------|------|
| `agent_report` wrapper 拦截 | 5 个阶段专属 report tool（`squad_global_plan` 等） | plugin 无 wrapper 机制，用独立工具实现 gate |
| `task` wrapper + `taskService.create()` | `client.session.create()` + `client.session.prompt()` | plugin 使用 OpenCode SDK session API |
| `experiments.addonLaunch.squad` + `pendingSquadLaunches` | `squadSessions` 全局 Map + session 预注册 | session API 无法在子 workspace 组装时注入上下文 |
| `globalRegistry` (context-registry) | `squadSessions` (squad-context.ts) | 去除 registry 抽象层，单一全局 Map |
| `SquadContext` + `SquadLaunchContext` | `SquadSession` | 简化为单一接口 |
| `addonRegistry` + `AddonRegistration` | `createSquadTool()` 返回 `ToolDefinition` | plugin 导出 tool，不是 addon wrapper |
| `run_in_background: true` task 异步 | session prompt 非阻塞 + gate 同步 | SDK session API 天然支持 |

### 3. Agent 角色变更

| 原角色 | 新角色 | 职责 |
|--------|--------|------|
| `explore` | `squad_planner` | 分析、规划、DAG 设计 |
| `explore`（review 时） | `squad_reviewer` | 审查计划、代码、执行报告 |
| `exec` | `squad_executor` | 执行代码变更 |

### 4. 新增文件

| 文件 | 职责 |
|------|------|
| `squad-tool.ts` | 主入口 `/squad` 命令工具，创建 SquadDeps 并调用 `runSquad` |
| `report-tools.ts` | 5 个阶段专属报告工具，各自 Zod 校验 + `gateWait()` |
| `agents.ts` | 3 个 squad agent 工厂函数 |
| `squad-context.ts` | `SquadSession` 接口、`Deferred`、`GateVerdict`、全局 `squadSessions` Map |

### 5. 删除文件

| 文件 | 原因 |
|------|------|
| `register.ts` | addon 注册机制不再存在 |
| `task-wrapper.ts` | 改为 `squad-tool.ts` 直接创建工具 |
| `agent-report-wrapper.ts` | 改为 `report-tools.ts` 阶段专属工具 |
| `context-registry.ts` | 合并进 `squad-context.ts` |
| `agent-report-wrapper.test.ts` | 原有测试，需重写为 session-based 测试 |
| `runtime.test.ts` | 原有测试，需重写 |

### 6. Bug 修复（代码审查发现）

| Bug | 修复 |
|-----|------|
| `cleanupAllInternal` 先 `createdChildIds.clear()` 再遍历 → 子会话永远不被 abort | 快照 ID 列表后再清除，用快照遍历做 abort |
| `stageAgent` 将 `global_plan`/`dag_design`/`node_plan` 映射到 `squad_reviewer` | 修正映射：planning 阶段 → `squad_planner` |
| `SquadResult.status` 包含从不产生的 `'failed'` | 移除 `'failed'`，保留 `'completed' | 'cancelled'` |
| `squad-tool.ts` 输出 `Size: ${taskId}` 误导 | 改为 `Task: ${taskId}` |
| unused imports（`SquadReport`、`OpencodeClient`、`SquadSession` type） | 清除 |
| non-null assertions (`!`) | 改为 `?.` / `?? 0` / throw |

### 7. PRD 重写

由于架构根本性变更（wrapper → plugin tool），全组 PRD 文档需要重写以反映新实现：

- PRD-01：更新术语、agent 角色、文件清单、架构特征表
- PRD-02：推导链条中的代码体现全部更新为新实现
- PRD-03：S/M/L 路径描述更新为新 API
- PRD-04：schema 通过阶段专属 report tool 传达，不再通过 `experiments.addonLaunch`
- PRD-05：从 "Agent Report Wrapper" 重写为 "Report Tools"
- PRD-06：集成方式从 addon wrapper 改为 plugin tool
- PRD-07：failure modes 更新为新 session 模型

### 8. 原理集更新

| 变更 | 原因 |
|------|------|
| 原理 F 从 "Task creation is the only workspace creation mechanism" 更新为 "Session API is the only child creation mechanism" | 不再使用 task tool，改用 `client.session` API |
| 原理中引用的代码文件路径全部更新 | 文件名变更 |

---

## 2026-05-19: 修复 pre-gate liveness 与 stream-end settlement bug

### 1. 问题

M 模式 global_plan/review 循环中，某轮 review child 结束后未触发 global_plan 继续，最终 global_plan 无限等待。

根因不是 gate accept/reject 二态错误，而是 pre-gate 生命周期存在静默丢失：

1. stale `toolExecutionNote` 被当作 successful agent_report 的存在性证据，导致 no-report stream 不 nudge。
2. `ReviewSchema` 非 strict，错误 schema 可能被误判为 accept。
3. ctx 在 `originalExecute` 返回后才注册，存在 child 先调用 `agent_report` 的 race。
4. squad child `!ctx` 时 pass-through 到真实 agent_report，绕过 gate 协议。

### 2. 修复

- `toolExecutionNote` 只作为参数补丁，不作为存在性证据。
- `ReviewSchema` 增加 `.strict()`。
- `SquadLaunchContext` 在 tool assembly 阶段提前注册 ctx。
- squad child `!ctx` fail closed，不 pass-through。

### 3. PRD 升级：pre-gate 生命周期契约

- 新增原理 L：进入 gate 之前不得静默丢失 report
- PRD-01 新增 pre-gate/gate boundary 术语 + 修正原理 G 范围
- PRD-02 新增 5 个推导章节（pre-gate 边界、launch context、!ctx 行为、stream-end settlement、schema strict 互补）
- PRD-03 新增 child 共同生命周期前置流程
- PRD-04 新增 strictness 契约 + validation failure ↔ nudge 关系
- PRD-05 新增构造阶段 + workspace 分类
- PRD-06 新增 stream-end settlement contract + toolExecutionNote 说明
- PRD-07 新增 failure modes & liveness 文档

## 2026-05-19: 完成 PRD-02 全部 7 个 G+J 违规修复

### 1. 修复清单（对应 PRD-02 §不足）

| #   | 违规                                                  | 文件                      | 修复                                                                 |
| --- | ----------------------------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| 1   | 审查阶段无 try-catch，plan child gate 可能泄漏        | `orchestrator.ts`         | M 和 L 路径 `executeFresh(review)` 包裹 try-catch                    |
| 2   | `withReviewLoop` abort 不 release gate                | `runtime.ts`              | abort 时先 `gateAccept` + `cleanupChild` 再 throw                    |
| 3   | `task-wrapper.ts` finally 不 release gate / terminate | `task-wrapper.ts`         | finally 遍历 children：release gate + `terminateDescendantAgentTask` |
| 4   | `isAborted()` 抛出异常                                | `orchestrator.ts`         | 改为 return `{status: "cancelled"}` SquadResult                      |
| 5   | `gateWait` 监听子对话 abort signal                    | `agent-report-wrapper.ts` | 移除 abort listener，Promise 只接收 `resolve`                        |
| 6   | AI SDK force-kill 未 catch                            | `agent-report-wrapper.ts` | 新增 `catch` 块                                                      |
| 7   | gate 类型包含未使用的 `reject`                        | `squad-context.ts`        | 从 `SquadContext.gate` 接口移除 `reject`                             |

### 2. 额外清理

- `path-m.ts` 删除重复的 `SquadResult` 接口定义（由 `path-s.ts` 提供）

### 3. 文档更新

- `PRD-02` 删除 "不足 / 需要 follow-up" 章节

## 2026-05-19: 基于第一性原理重构架构

### 1. 确立 11 条第一性原理（A-K）

从系统约束（A）、task system 机制（B）、架构需求（C、D、F）、风格约定（E、J）、工程约束（G、K）、用户行为（H、I）中提取 11 条不可约原理。所有设计决策必须能回溯到这些原理。

PRD-01 新增原理章节，PRD-02 重写为推导全链条（原理 → 推论 → 代码约束），PRD-03~06 重写为推导的自然结论。

### 2. 删除冗余机制

| 删除项                                               | 原理检验                                           | 后果                                                   |
| ---------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------ |
| `forwarding` 标志                                    | A ⊨ 模型不能并发调工具，此标志不可达               | 删除 `SquadContext.forwarding`、wrapper 中所有相关检查 |
| 墓碑机制（`isDeadChild`/`markDead`）                 | G + H 已保证 gate release 和 terminate，不需要墓碑 | 删除 `context-registry.ts` 中相关接口                  |
| `errors.ts` / `SquadRejectError`                     | J 禁止依赖异常做控制流                             | 删除整个文件                                           |
| 手工 `{success: true, message: "Report submitted."}` | E 禁止手工造 ok 回复                               | 改为 `return await originalExecute(...)`               |

### 3. 修正 gate 时序（S/M 路径）

之前 S/M 路径 gateAccept 发生在执行之前。修正后 gate 在整个执行期间 hang 住，执行完成才 accept。L 路径不变。

### 4. Schema 校验整合

`ReviewSchema` 增加 `"null"` 字面量收敛。新增 `schemaForStage` / `describeSchema` 工具函数。校验错误返回不再违反原理 J（不抛异常）和 K（LLM 看见的 = 系统验证的）。

### 5. 新增 try-catch 路径保护

所有 gate 创建路径新增 try-catch 确保 gate 被 release（原理 G）。包括 S、M、L 路径和 withReviewLoop 的 abort 路径。

### 6. 重写全部 PRD 文档

| 文件                       | 变化                                |
| -------------------------- | ----------------------------------- |
| 01-overview.md             | 新增 11 条原理 + 架构特征表         |
| 02-architecture.md（原 02-wrapper-architecture.md 重命名） | 完全重写为推导全链条，反映插件架构 |
| 03-workflow.md             | 重写为 S/M/L 路径纯描述             |
| 04-data-schema.md          | 重写为 schema 引用手册              |
| 05-report-tools.md（原 05-agent-report-shim.md 重命名） | 完全重写为阶段专属报告工具说明 |
| 06-integration.md          | 重写为集成契约（零代码块）          |
| 07-pseudo-code.md          | 删除（不再需要）                    |

## 2026-05-18: 修复关键 Bug 和设计缺陷

### 1. 修复 splice(-1, 1) 的数组突变 Bug

**问题**：

```typescript
// ❌ 危险：indexOf 返回 -1 时会删除数组最后一个元素
params.createdChildIds.splice(params.createdChildIds.indexOf(childTaskId), 1);
```

**修复**：

```typescript
// ✅ 使用 Set，O(1) 时间复杂度且绝对安全
createdChildIds: Set<string>; // 改用 Set
params.createdChildIds.delete(childTaskId);
```

### 2. DAG 调度器的并发取消机制

**问题**：节点 A 失败时，节点 B 仍在运行，可能触发 Unhandled Promise Rejection。

**修复**：

```typescript
// runNodeLoop 内部创建 AbortController
const dagAbort = new AbortController();
params.abortSignal?.addEventListener("abort", () => dagAbort.abort());

async function executeNodeSafely(name: string) {
  try {
    const report = await executeSingleNode({
      nodeName: name,
      abortSignal: dagAbort.signal, // 传递 DAG 级别的 abort
      ...params,
    });
    // ...
  } catch (err) {
    hasError = true;
    dagAbort.abort(); // 立即取消所有并行节点
    reject(err);
  }
}
```

### 3. 移除冗余的 Tool 实例化

**问题**：

```typescript
// ❌ 多此一举
const real = createAgentReportTool(config);
await (real.execute as Function)(...);
```

**修复**：

```typescript
// ✅ 直接使用闭包捕获的原始函数
await originalExecute({ reportMarkdown: ... }, options);
```

### 4. 关于模块拆分的反思

**问题**：教条式的"单文件 150 行"导致逻辑碎化，DAG 相关逻辑被强行拆成多个文件。

**调整**：

- 保留模块化原则，但**按领域语义拆分，而非按行数拆分**
- DAG 相关逻辑（scheduler + node executor）可以合并为 `dag-execution.ts`（~180 行）
- 高内聚比低行数重要

## 2026-05-18: 消除 re-plan/re-exec 的上下文冗余

### 问题

原设计在 gate reject 后重新调用时，会把整个 planMarkdown 复制到 prompt：

```ts
// ❌ 冗余
currentIntent = `${originalIntent}

=== Previous Plan ===
${planMarkdown}  // child 上下文已有，重复传递浪费 token

=== Review Feedback ===
${feedbackMarkdown}

Please revise...`;
```

### 优化

利用可复用 child 的对话上下文，只传 feedback：

```ts
// ✅ 优化
currentIntent = `${originalIntent}

=== Review Feedback ===
${feedbackMarkdown}

Please revise...`;
```

**原理**：可复用阶段（Global Plan、Node Plan、Node Exec）使用 gate 机制，同一 child 的多轮对话天然共享上下文。child 已经看到自己之前生成的内容，只需要 feedback 即可修改。

### 收益

- 减少 token 消耗（尤其是多轮迭代时）
- 避免上下文污染
- 更符合自然对话模式

## 2026-05-18: 模块化重构

### 目标

- 单文件不超过 200 行（实际控制在 150 行以内）
- 单函数不超过 40 行
- 提升可测试性

### 主要变更

#### 1. 文件拆分（6 → 15 个模块）

**原架构（attempt-0）：**

- task-wrapper.ts: 400 行（包含所有编排逻辑）
- agent-report-wrapper.ts: 140 行
- squad-context.ts: 40 行（全局 registry + 墓碑）
- schemas.ts: 130 行（schema + 渲染）
- prompts.ts: 150 行

**新架构：**

集成层（管理全局状态）：

- context-registry.ts: 80 行 - registry 接口 + gate API + 墓碑
- task-wrapper.ts: 60 行 - 拦截 task，委托给 orchestrator
- agent-report-wrapper.ts: 100 行 - 拦截 agent_report，gate 机制

核心层（纯函数 + 依赖注入）：

- orchestrator.ts: 120 行 - 外层 while loop + 路径分发
- path-s.ts: 40 行 - S 路径执行
- path-m.ts: 80 行 - M 路径执行
- path-l.ts: 100 行 - L 路径执行
- dag-scheduler.ts: 80 行 - 自驱动 DAG 调度器
- node-executor.ts: 100 行 - 单节点内部 loop
- child-manager.ts: 80 行 - child 创建/清理 helpers

工具层（无状态）：

- schemas.ts: 80 行 - Zod schema + 类型定义
- report-renderer.ts: 60 行 - Markdown 渲染
- prompts.ts: 150 行 - Prompt 模板

类型层：

- squad-context.ts: 50 行 - Deferred + SquadContext 类型

#### 2. 依赖注入设计

**原设计：**

```ts
// 直接访问全局状态
const ctx = squadContextRegistry.get(childTaskId);
deadSquadChildIds.add(id);
```

**新设计：**

```ts
// 通过接口注入
export interface ContextRegistry {
  get(id: string): SquadContext | undefined;
  set(id: string, ctx: SquadContext): void;
  delete(id: string): void;
  isDeadChild(id: string): boolean;
  markDead(id: string): void;
}

// 核心函数接收 registry 参数
export async function runSquad(params: SquadParams): Promise<SquadResult>;
// params 包含 registry: ContextRegistry

// 测试时可注入隔离实例
const testRegistry = createContextRegistry();
await runSquad({ ...params, registry: testRegistry });
```

#### 3. 函数长度控制

所有核心函数控制在 40 行以内：

- `runSquad`: 35 行（外层 while loop）
- `runSPath`: 25 行
- `runNodeLoop`: 35 行（自驱动 DAG）
- `executeSingleNode`: 分两段各 30 行（Node Plan + Node Exec）
- `gateWait`: 35 行