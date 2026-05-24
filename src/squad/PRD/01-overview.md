# 01 — 总览

## 要做什么

squad 是 oh-my-opencode-slim 插件中的一个 S/M/L 自动编排工具，通过 `/squad` 命令触发。模型调 `squad({ intent })` 启动子会话，子会话中根据任务大小自动走 S/M/L 路径。

核心设计：每个独立的「工作阶段」（Global Plan、Node Exec 等）的子会话在同一持续对话里迭代，直到 review 通过或外部决定放弃。复用方式是阶段专属报告工具挂起在一个 Promise gate 上，orchestrator resolve 它来决定是真正提交报告结束对话，还是把 feedback 作为工具返回值推回去让子会话继续改。

## 不做什么

- 不注册通用 wrapper——模型面前有 5 个阶段专属报告工具（`squad_global_plan` 等）
- 不跟踪跨会话状态
- 不修改 OpenCode 核心
- 不使用 `plan` agent——只用 `squad_planner`（分析/规划/DAG 设计）、`squad_reviewer`（审查）、`squad_executor`（落地执行）
- 不搞 event sourcing / projection / reactor 那一套

## 术语

| 术语                   | 含义                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **squad parent**       | 用户调 `/squad` 或 `squad({ intent })` 的那个会话——squad 工具在这个会话里跑外层 while loop                                                                              |
| **squad child**        | 通过 `client.session.create()` + `client.session.prompt()` 创建的子会话                                                                                                      |
| **structured store**   | 工具作用域内的 Map，存子会话提交的结构化数据                                                                                                                           |
| **size**               | S / M / L，决定编排路径。只有 Global Plan 的报告工具带此字段                                                                                                         |
| **feedbackMarkdown**   | review 结果：`null` = 通过，非 null = 驳回理由。ReviewSchema 用 transform 把空字符串也收敛为 null                                                                           |
| **gate**               | 报告工具内创建的 Promise。orchestrator resolve 决定子会话是结束（返回成功消息）还是继续（把 feedback 作为工具返回值推回去）                                            |
| **DAG**                | L 路径的并行执行图，edges 中 child depends on parent                                                                                                                        |
| **pre-gate**           | 子会话调用报告工具之前，以及报告工具完成 schema 校验、写入 structuredStore、resolve `nextReport` 之前的阶段。pre-gate 不属于 accept/reject 二态协议                |
| **gate boundary**      | `ctx.structuredStore.set(...)` + `ctx.nextReport.resolve()` + `ctx.gate = { resolve }` 完成的时刻。此后子会话进入 accept/reject 二态                                       |
| **squadSessions**      | 全局 Map<sessionId, SquadSession>，orchestrator 在 prompt 之前注册，报告工具的 execute() 按 sessionId 查找上下文                                                          |
| **stage-specific report tool** | 5 个独立的 OpenCode plugin 工具（squad_global_plan, squad_review, squad_dag_design, squad_node_plan, squad_node_exec），每个有自己的 Zod schema，替代原来的 agent_report 拦截 |

## 可复用 vs 每次全新

| 阶段                 | agent           | 方式                                                           |
| -------------------- | --------------- | -------------------------------------------------------------- |
| **Global Plan**      | squad_planner   | **可复用**——gate 机制。Global Review 驳回时同一子会话继续对话 |
| **Global Review**    | squad_reviewer  | **全新**——每次都开新会话                                       |
| **DAG 设计**         | squad_planner   | **全新**——每次都开新会话                                       |
| **Node Plan**        | squad_planner   | **可复用**——gate 机制。Node Plan Review 驳回时同一子会话继续  |
| **Node Plan Review** | squad_reviewer  | **全新**                                                       |
| **Node Exec**        | squad_executor  | **可复用**——gate 机制。Node Exec Review 驳回时同一子会话继续  |
| **Node Exec Review** | squad_reviewer  | **全新**                                                       |
| **S/M Exec**         | squad_executor  | **可复用**——gate 机制（S 路径无 review 直接 accept）           |
| **End Review**       | squad_reviewer  | **全新**                                                       |

## 三个 agent 角色

| 角色           | agent_id       | 何时用                                                                                          |
| -------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| squad_planner  | `squad_planner` | Global Plan、DAG 设计、Node Plan                                                               |
| squad_reviewer | `squad_reviewer`| Global Review、Node Plan Review、Node Exec Review、End Review                                  |
| squad_executor | `squad_executor`| Node Exec、S/M 路径的直接执行                                                                  |

## 插件架构

squad 不拦截任何已有工具。它注册一个新工具 `squad`（通过 `/squad` 命令触发）和 5 个阶段专属报告工具。子会话通过 `client.session.create()` + `client.session.prompt()` 创建和管理。报告工具通过 `squadSessions` 全局 Map 与 orchestrator 同步。

OpenCode 核心（SDK）只提供 `session.create()`、`session.prompt()`、`session.abort()` 等 API，不包含 squad 专属逻辑。

## 第一性原理

squad 架构由以下 14 条第一性原理严格推导而来。任何设计决策必须能回溯到这些原理之一或组合。

### A. 子会话是独立 AI workspace

每个 child 有独立 context、tool policy、stream。外部无法中断或注入指令，只能通过工具返回值通信。

**约束**：orchestrator ↔ child 唯一的同步点是工具调用的返回。

### B. 报告工具的完成门票

当报告工具返回 "Report accepted. No further work is required." 时，child 知道可以停止当前阶段。返回反馈字符串时，child 继续修改。

**约束**：gate 机制是 orchestrator 控制 child 的唯一方式。

### C. orchestrator 需要结构化字段做分支决策

orchestrator 根据 typed fields（`size`、`planMarkdown`、`affectedFiles` 等）决定 S/M/L、review 等分支，不能靠自由文本。

**约束**：child 的报告工具必须能接受并传递 stage 对应的结构化的 schema。

### D. review 需要双向通信

orchestrator 审查后如果拒绝，child 必须知道**为什么**并有机会修改。

**约束**：gate 不能无限 hang ——必须以有效决议（accept 或 reject）结束。拒绝 = 暂时 hang 被解除，orchestrator 做出有效决议。

### E. 绝不手工造 ok 回复

"Report accepted. No further work is required." 只能由 gate accept 产生。

**约束**：accept 分支返回成功字符串。reject 分支的反馈不是 ok 回复，是被拒绝的决议。

### F. Session API is the only child creation mechanism

squad 通过 `client.session.create()` + `client.session.prompt()` 创建子会话，不使用其他机制。

**约束**：`createChild` 必须先创建会话、注册上下文、然后发送 prompt；orchestrator 无法绕过工具返回值通信。

### G. Gate must be released（accept or reject）

每个已经创建的 gate 承诺最终必须被决议。不留活扣。

**范围**：G 只约束已经进入 `gateWait` 的 child。尚未进入 gate 的 pre-gate 生命周期由原理 L 约束。

**约束**：每条路径必须有 error handling 确保 gate 被 release。`withReviewLoop` 的 abort 路径、review 阶段、`squad-tool.ts` finally 块都必须 release gate。

### H. 在用户强行终止主对话的时候杀所有子对话

主对话被终止 → 主动 abort 所有 child 会话。

**约束**：`squad-tool.ts` 在 finally 块中不仅要 release gate 和清理 squadSessions，还要 `client.session.abort()` 每个 child。

### I. 在用户强行终止子对话的时候什么都不做，等用户原地继续

子对话被终止 → child 应保持挂起状态；用户点 continue 后报告工具继续执行。

**约束**：gate Promise 不应监听子对话自己的 abort signal。

### J. 控制流中不主动 throw 任何东西

不依赖异常做控制流。每个路径都返回有意义的结果。

**约束**：`isAborted()` 不 throw；`catch + rethrow` 改为 return error result；review 失败也 return 而非 throw。

### K. LLM 所见、系统所验、我们所使，三者合一

LLM 看到的报告工具 schema 和描述、系统执行的 Zod 核验、orchestrator 实际消费的结构化字段——三者必须一致。

**约束**：每个阶段专属报告工具有独立的 Zod schema（`.strict()`），LLM 只看到当前阶段的 schema。

### L. 进入 gate 之前不得静默丢失 report

squad 的二态 gate 协议只在 child 的报告工具成功执行到 `gateWait` 后成立。在此之前，child 可能尚未调用报告工具、调用了错误 schema、ctx 尚未注册、或 stream 被中断。

**约束**：

1. squad child 的上下文必须在它可能调用报告工具之前注册（`squadSessions.set()` 在 `session.prompt()` 之前）。
2. squad child 如果缺失 ctx，报告工具返回错误消息，避免死锁。
3. 没有 successful report 的 stream 必须保留重试机会。
4. schema validation failure 不进入 gate，返回错误消息让 LLM 修正。

### N. 整个实现与时间无关

squad 的正确性不依赖任何超时、定时器或时间假设。LLM 推理时间不可预测，静默结束通过 `promptPromise` resolve 检测（语义信号），而非超时推断（时间假设）。nudge 机制基于次数而非时间。

**约束**：

1. 不使用 `setTimeout`/`setInterval` 做超时控制。
2. 不依赖 wall-clock 时间做决策。
3. liveness 完全由语义信号（`promptPromise` resolve、`nextReport` resolve、`gate` resolve）和次数（`nudgeCount`/`maxNudges`）保证。
4. 唯一的外部终止机制是用户主动取消（`abortSignal`），属于语义动作而非时间条件。

## 从原理推导的架构特征

| 特征                                       | 推导来源           | 代码体现                                                       |
| ------------------------------------------ | ------------------ | -------------------------------------------------------------- |
| 报告工具拦截并 hang                        | A+B                | `gateWait()`                                                     |
| 两个同步原语（nextReport + gate）          | A+D                | `Deferred` + `GateVerdict`                                     |
| Accept 侧返回成功字符串                    | B+E                | `return 'Report accepted. No further work is required.'`                                    |
| Reject 侧返回反馈字符串                    | D+E                | `return 'Report rejected. Feedback:\n...'`                     |
| Stage-specific 工具 + schema               | C+A+K              | 5 个报告工具，各自 Zod schema `.strict()`                      |
| `client.session.create()` + `prompt()`     | F                  | `createChild`                                                   |
| Gate 必须被 release                        | G                  | try-catch 包裹所有执行路径                                     |
| 主对话终止 → abort children                | H                  | `squad-tool.ts` finally 块 session.abort                       |
| 子对话终止 → 不做任何事                    | I                  | gate Promise 不监听 abort signal                               |
| 不主动 throw                               | J                  | 错误路径返回 error result                                      |
| Context 在 session.prompt() 之前注册       | A+F+L              | `squadSessions.set()` 在 `session.prompt()` 之前               |
| Squad session 缺 ctx 时返回错误            | L                  | `gateWait()` 中 `if (!ctx)` 返回错误字符串                      |
| Schema 必须 strict                          | K+L                | 所有 stage schema 加 `.strict()`                               |
| 无超时、无定时器                            | N                  | nudge 基于次数不是时间，liveness 由语义信号保证               |

## 文件清单

```
src/squad/
├── squad-tool.ts           # 主入口：/squad 命令工具（~87 行）
├── squad-context.ts        # SquadSession、Deferred、GateVerdict、全局 squadSessions Map（~63 行）
├── report-tools.ts         # 5 个阶段专属报告工具 + gateWait 共享逻辑（~256 行）
├── runtime.ts              # 闭包式 SquadRuntime：createChild/awaitReport/gateAccept 等（~363 行）
├── orchestrator.ts         # 外层 while loop + S/M/L 路径分发（~157 行）
├── path-s.ts               # S 路径执行（~42 行）
├── path-m.ts               # M 路径执行（withReviewLoop）（~23 行）
├── path-l.ts               # L 路径：DAG 执行 + End Review（~37 行）
├── dag-scheduler.ts        # 自驱动 DAG 调度器（~131 行）
├── node-executor.ts        # 单节点 Node Plan + Node Exec withReviewLoop（~56 行）
├── agents.ts               # 3 个 squad agent 工厂函数（~108 行）
├── prompts.ts              # 所有阶段的 prompt 模板（~324 行）
├── schemas.ts               # Zod schema + 类型（~155 行）
├── schemas.test.ts          # Schema 测试
├── report-renderer.ts      # renderMarkdown + getTitle（~47 行）
├── fs-utils.ts              # readAffectedFiles（路径列表，不读内容）（~7 行）
├── dag-scheduler.test.ts    # DAG 调度器测试
└── PRD/                     # 本组 PRD 文件
```

预计 ~1600 LoC（不含 PRD）。