# 05 — Report Tools

## 概述

`report-tools.ts` 定义 5 个阶段专属报告工具，替代原来的 `agent_report` wrapper 拦截机制。每个工具有自己的 Zod schema（strict），在子会话中只启用当前阶段对应的工具。

设计推导见 [02 — 第一性原理推导全链条](./02-architecture.md) §1（阶段专属工具）、§2（两同步原语）、§3（accept 成功字符串）、§4（reject 反馈字符串）、§14（schema 一致性）、§15（校验错误不抛异常）。

---

## 为什么不用 agent_report wrapper

原架构中，squad 作为 addon 拦截 `agent_report` 工具的 `execute()`，在内部实现 gate 机制。在 oh-my-opencode-slim 插件架构中：

1. **插件没有 wrapper 机制** — 无法拦截已有工具的 `execute()`。
2. **原理 K 要求 LLM 只看到当前阶段的 schema** — 独立工具天然保证这一点，不需要运行时 schema 替换。
3. **更简洁的同步模型** — 报告工具通过 `squadSessions` Map 按 sessionId 查找上下文，不需要 `experiments.addonLaunch.squad` 传递机制。

---

## 工具清单

| 工具名                | Zod Schema              | 启用阶段        | Agent            |
| --------------------- | ----------------------- | --------------- | ---------------- |
| `squad_global_plan`   | GlobalPlanSchema        | global_plan     | squad_planner    |
| `squad_review`        | ReviewSchema            | review          | squad_reviewer   |
| `squad_dag_design`    | DagDesignSchema         | dag_design      | squad_planner    |
| `squad_node_plan`     | NodePlanSchema          | node_plan       | squad_planner    |
| `squad_node_exec`     | NodeExecSchema          | node_exec       | squad_executor   |

所有工具共享 `gateWait()` 逻辑。

---

## 执行流程

每个工具的 `execute` 方法按以下顺序处理：

### 1. 上下文查找

工具通过 `context.sessionID` 查找 SquadSession：

```ts
const ctx = squadSessions.get(sessionId);
if (!ctx) return 'Error: Not a squad session.';
if (ctx.disposed) return 'Error: Squad session is no longer available.';
```

- 无 ctx → 返回错误字符串（原理 L: fail closed，不 pass-through）
- ctx disposed → 返回错误字符串（会话已被清理）

### 2. Schema 校验

用当前工具的 Zod schema 对 `args` 执行 `safeParse`。

校验失败时不抛异常（原理 J），而是返回错误字符串。LLM 看到后可以修正并重试。校验失败的返回不是手工造的 ok 回复（原理 E），而是协议错误消息（原理 K）。

### 3. 存入 store

校验通过后，将结构化数据包装为 `SquadReport`（含 `kind`、`childTaskId` 和解析后的字段）存入 `structuredStore`，key 为当前 child 的 session ID。

### 4. gateWait

**gate boundary**：`structuredStore.set(...)` + `nextReport.resolve()` + `ctx.gate = { resolve }` 完成后才认为进入 gate 协议。此后只有 accept/reject 两种决议。

核心函数 `gateWait()` 分三个阶段：

**阶段 a — 通知：** `nextReport.resolve()`。orchestrator 侧的 `awaitReport` 正在等待这个 `Deferred`，resolve 后 orchestrator 拿到新报告。

**阶段 b — 挂起：** 创建一个 `Promise<GateVerdict>`，将 resolve 函数挂在 `ctx.gate` 上，然后 `await` 这个 Promise。在此期间 child 的工具调用未返回，child 处于暂停等待状态。

不监听当前 stream 的 abort signal（原理 I：子对话被终止时不 reject gate，保持挂起状态）。

**阶段 c — 决议：** 外部（orchestrator）通过 `gateAccept` 或 `gateReject` 触发 gate 决议：

- **Accept：** 返回字符串 `"Report accepted."`。child 知道当前阶段完成。
- **Reject：** 重置 `nextReport`，返回反馈字符串 `"Report rejected. Feedback:\n..."`。child 据此修改后重试。

无论哪种决议，`gateWait` 返回后工具的 `execute` 即结束。

---

## 与 SquadRuntime 的协作

报告工具不直接与 orchestrator 通信。它们通过 `squadSessions` 全局 Map 与 `SquadRuntime` 同步：

| SquadRuntime 方法               | 对 gateWait 的影响                                                             |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `gateAccept(childId)`           | 查找 `children` 对应 `ctx` → `ctx.gate.resolve({ accepted: true })`            |
| `gateReject(childId, feedback)` | 查找 `children` 对应 `ctx` → `ctx.gate.resolve({ accepted: false, feedback })` |
| `cleanupChild(childId)`         | 将 `ctx.disposed` 设为 true，并清理 store 和 session Map 中的引用             |

`SquadSession` 在 `createChild` 中通过 `squadSessions.set(childSessionId, ctx)` 预注册，在子会话 prompt 之前完成（原理 L）。

---

## 方法摘要

| 方法                                         | 调用者                    | 作用                                              |
| -------------------------------------------- | ------------------------- | ------------------------------------------------- |
| `createSquadReportTools()`                   | 插件入口                  | 创建 5 个工具定义                                |
| `gateWait(sessionId, report)`                | 各工具 execute            | 存 store → 通知 → 挂起 → accept/or reject        |
| `schemaForStage(stage)`（schemas.ts）         | 各工具 execute            | 返回当前阶段的 Zod schema                         |
| `describeSchema(stage)`（schemas.ts）         | 各工具 execute            | 校验失败时返回人可读的格式描述                    |
| `renderMarkdown(report)`（report-renderer.ts）| orchestrator 输出         | 结构化 report → readable markdown                 |
| `getTitle(report, nodeName)`（report-renderer.ts）| orchestrator 输出    | 生成节点报告标题                                  |