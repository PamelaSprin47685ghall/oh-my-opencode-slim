# 02 — 第一性原理推导全链条

本文档从 12 条第一性原理出发，逐条推导出 squad 的每个设计决策。每步推导均可回溯到原理编号。推导的最终产物是 [03 — 编排流程](./03-workflow.md) 中描述的工作流——**不存在其他可能的编排方式而不违反某条原理**。

---

## 原理集（完整引用）

| #   | 原理                                                                | 来源约束         |
| --- | ------------------------------------------------------------------- | ---------------- |
| A   | 子会话是独立 AI workspace，外部只能通过工具返回值通信               | 系统架构         |
| B   | 报告工具返回成功消息后 child 知道当前阶段完成                       | 工具机制         |
| C   | orchestrator 需要结构化字段做分支决策，不能靠自由文本               | 架构需求         |
| D   | review 需要双向通信（拒绝带反馈、child 可重试）                     | 功能需求         |
| E   | 绝不手工造 `ok` 回复                                                | 第一性选择       |
| F   | Session API is the only child creation mechanism                    | 工程约束         |
| G   | Gate must be released（accept or reject）                           | 工程约束         |
| H   | 主对话终止时杀所有子对话                                            | 需求             |
| I   | 子对话终止时不做任何事，等用户原地继续                              | 需求             |
| J   | 控制流中不主动 throw 任何东西                                       | 风格约定         |
| K   | LLM 所见、系统所验、我们所使，三者合一                              | 工程约束         |
| L   | 进入 gate 之前不得静默丢失 report                                   | liveness 约束    |
| N   | 整个实现与时间无关                                                  | liveness 约束    |

---

## 推导树

每条推导标注参与的原理、结论、以及代码体现。

---

### 1. 阶段专属报告工具 + gate 机制

```
A ── child 是独立 workspace，只能通过工具返回值通信
B ── 工具返回值是 child 知道阶段完成的唯一途径
  ↓
推论：如果 orchestrator 需要 child 可重试（D），必须拦截工具调用，
      在工具内部挂起一个 Promise（gate），等外部决定。
  ↓
代码：report-tools.ts → gateWait()
```

在插件架构中，我们不包装已有工具（`agent_report`），而是注册 5 个独立的阶段专属报告工具。每个工具有自己的 Zod schema，child 只看到当前阶段需要的 schema（原理 K）。

---

### 2. 两个同步原语（nextReport + gate）

```
A ── orchestrator ⟷ child 之间唯一的同步点是工具返回值
D ── orchestrator 需要先读 report 再决定（accept/reject）
  ↓
推论：需要两阶段通信：
  ① child → orchestrator: "报告已送达" → nextReport.resolve()
  ② orchestrator → child: "已决定" → gate.resolve(verdict)
  ↓
实现：Deferred<T> 是跨 async 等待的最小机制
  │ 构造时即有 promise → 无竞态
  │ resolve() 后 await promise 才会 fulfilled
  │ 谁先谁后都不会丢信号
```

#### 2c. Pre-gate / gate boundary

```
A ── child 只能通过工具返回值通信
D ── gate 需要有 accept/reject 决议
L ── 进入 gate 之前不得静默丢失
  ↓
推论：
  gate 的 accept/reject 二态只在 gate boundary 被跨越后成立。
  gate boundary = 以下动作全部完成后：
    1. 找到 SquadSession（squadSessions.get(sessionID)）
    2. stage schema 校验通过
    3. structuredStore.set(childSessionId, report)
    4. nextReport.resolve()
    5. ctx.gate = { resolve }

  在此之前的生命周期属于 pre-gate，不得被解释为 accept/reject。
```

pre-gate 阶段包括以下子阶段，每个都可能失败而不进入 gate：

| 子阶段             | 失败处理                                     |
| ------------------ | -------------------------------------------- |
| 工具未被调用       | session 结束时 orchestrator 通过 promptPromise 检测 |
| 找不到 ctx         | 返回错误字符串，LLM 可重试                     |
| Schema validation  | 返回错误字符串，LLM 修正                     |
| nextReport deliver | `structuredStore.set` + `nextReport.resolve` |

#### 2a. executeFresh（全新阶段）

```
推论 2 的退化情况：
  也用于确定只调一次（review、dag_design、end review）
  → createChild → awaitReport → gateAccept(immediately) → cleanup
```

#### 2b. withReviewLoop（可复用阶段）

```
推论 2 的完整情况：
  → createChild → loop { awaitReport → review → reject/accept }
  → reject: gateReject → continue（child 在 gateWait 收到 rejection 后重试）
  → accept: gateAccept → cleanup → return
```

---

### 3. Accept 侧返回成功字符串

```
B ── child 必须知道工具调用的结果
E ── 不能手工造 `{success: true}`
  ↓
推论：if (verdict.accepted) { return 'Report accepted. No further work is required.' }
  简单字符串，不违反 E（这是 gate accept 的自然结果）。
  ↓
代码：gateWait accept 分支 → return 'Report accepted. No further work is required.'
```

---

### 4. Reject 侧返回反馈字符串

```
D ── 拒绝是有效决议，child 需要 feedback 来重试
E ── `{success: true}` 不能手工造，但 reject 反馈不是 ok 回复
  ↓
推论：if (!verdict.accepted) { return `Report rejected. Feedback:\n${verdict.feedback}\n\nRevise and call the same report tool again.` }
  被拒绝 = "后面再说"的一种体现：暂时 hang 被解除，orchestrator 做出了有效决议。
  ↓
代码：gateWait reject 分支
  ctx.nextReport = new Deferred<void>();  // 重置以接收下次报告
  return `Report rejected. Feedback:\n${verdict.feedback}\n\n...`;
```

---

### 5. 阶段专属报告工具（替代 agent_report 拦截）

```
C ── orchestrator 需要 `size`、`planMarkdown`、`affectedFiles` 等 typed fields
A ── child 的工具定义在子会话中构建，与 parent 不在同一 context
K ── LLM 看到的 schema = 系统验证的 schema = 我们消费的 schema 必须一致
F ── session.create() + session.prompt() 是创建子会话的唯一方式
  ↓
推论：
  插件架构无法拦截 child workspace 中的工具。因此在插件中注册 5 个独立工具，
  每个工具有自己的 Zod schema 和描述。child 在会话 prompt 时通过 tools 参数
  指定启用哪个报告工具（只启用当前阶段的），保证 LLM 只看到需要的 schema。

  5 个工具：
    - squad_global_plan: { size: "S"|"M"|"L", planMarkdown: string }
    - squad_review: { feedbackMarkdown?: string | null }
    - squad_dag_design: { nodes: [...], edges: [...] }
    - squad_node_plan: { planMarkdown: string }
    - squad_node_exec: { reportMarkdown: string, affectedFiles: string[] }
  
  工具通过 context.sessionID 查找 SquadSession（预注册在 squadSessions Map 中）。

  ↓
代码：report-tools.ts
  - createSquadReportTools() 返回 5 个 ToolDefinition
  - gateWait() 共享逻辑：查找 ctx → 存 store → resolve nextReport → await gate

  runtime.ts createChild()
  - session.create() → session.prompt() 之间注册 squadSessions
  - tools 参数只启用当前阶段的报告工具
```

#### 5a. Context 预注册（L 原理保障）

```
L ── ctx 必须在 child 可能调用报告工具之前注册
F ── session API 在 prompt 前给了我们 sessionId
  ↓
推论：
  在 session.create() 得到 sessionId 后、session.prompt() 之前，
  必须完成 SquadSession 的注册。因为 prompt 是非阻塞的，
  child 可能在 prompt 返回后的任何时间调用报告工具。
  
  注册流程：
    1. session.create() → 得到 childSessionId
    2. squadSessions.set(childSessionId, ctx)  // L: 预注册
    3. session.prompt({ ..., tools })            // 非阻塞
  ↓
代码：runtime.ts createChild
  const sessionResponse = await client.session.create({...});
  const childSessionId = ...;
  const ctx = { stage, structuredStore, nextReport: new Deferred(), ... };
  squadSessions.set(childSessionId, ctx);  // L: 预注册
  children.set(childSessionId, ctx);
  createdChildIds.add(childSessionId);
  await client.session.prompt({...});  // 非阻塞，child 可能在接下来任何时间调用工具
```

---

### 6. Session prompt 非阻塞

```
F ── squad 通过 client.session.create() + client.session.prompt() 管理子会话
  ↓
推论：orchestrator 需要同时管理多个 child（plan、review、node_exec）
  如果 prompt 同步等待完成 → orchestrator 无法并行管理
  ∴ createChild 只 awaits session.create() 和 session.prompt() 的 HTTP 响应
    child 在子会话中独立运行
  ↓
代码：runtime.ts createChild
  await client.session.create({...});   // 得到 sessionId
  squadSessions.set(childSessionId, ctx); // 预注册
  await client.session.prompt({...});    // 发送 prompt
  return childSessionId;               // 立即返回，child 在后台运行
```

---

### 7. 注册上下文（squadSessions 全局 Map）

```
F ── session.create() 返回 childSessionId
  ↓
推论：用此 ID 在 squadSessions Map 注册 SquadSession（供报告工具按 sessionId 查找）
  同时在 structuredStore 预留位置（供报告工具写入）
  ↓
代码：runtime.ts createChild 中
  squadSessions.set(childSessionId, { ... });
  children.set(childSessionId, ctx);
  deps.createdChildIds.add(childSessionId);
```

---

### 8. Gate 必须被 release（G）→ 推导出多条代码约束

```
G ── 每个 gate 承诺最终必须被决议（accept 或 reject），不留活扣。
  ↓
每条创建 gate 的路径都必须有对应的 release 路径：
```

#### 8a. orchestrator 各路径的 try-catch

```
● S 路径：try { runSPath; gateAccept; } catch { gateAccept; throw; }
● M 路径：try { runMPath; gateAccept; } catch { gateAccept; throw; }
● L 路径：try { runDAGExecution; } catch { gateAccept; throw; }

但 review 阶段（const review = await runtime.executeFresh(...)）
如果 executeFresh 抛异常 → plan child 的 gate 永远不会被 release ❌

修复：review 阶段也须 try-catch
  let review: ReviewReport;
  try { review = await runtime.executeFresh(...); }
  catch (err) { runtime.gateAccept(planChildId); cleanup; throw err; }
```

#### 8b. withReviewLoop 的 abort 路径

```
当前：if (runtime.isAborted()) throw new Error(...)
  → child 的 gate 永远挂在 gateWait 里 ❌

修复：
  if (runtime.isAborted()) {
    runtime.gateAccept(childId);       // release gate
    await runtime.cleanupChild(childId);
    throw new Error(`${stage} aborted`);
  }
```

#### 8c. squad-tool.ts finally 块

```
finally {
  for (const childId of createdChildIds) {
    squadSessions.delete(childId);
    structuredStore.delete(childId);
    try {
      await ctx.client.session.abort({...});
    } catch { /* best-effort */ }
  }
}
```

#### 8d. cleanupChild 的调用时序保证

```
cleanupChildInternal 自身不 release gate（只删 registry/store/createdChildIds）。
所有调用点之前都已有 gateAccept/gateReject → 时序保证 ✓
```

---

### 9. 主对话终止杀所有子对话（H）

```
H ── 用户终止主对话时，所有 child 必须被清理
  ↓
推论：squad-tool.ts 的 finally 块不仅要清理 squadSessions，
  还要 abort 每个 child session。
  ↓
代码：squad-tool.ts finally 块
  finally {
    for (const childId of createdChildIds) {
      squadSessions.delete(childId);
      structuredStore.delete(childId);
      try { await ctx.client.session.abort({...}); } catch { /* best-effort */ }
    }
  }

  runtime.ts cleanupAllInternal 也做同样的事：
  快照 ID 列表 → 释放所有 gate → 清理 registry → abort 所有子会话
```

---

### 10. 子对话终止不做任何事（I）

```
I ── 子对话被终止时 child 应保持挂起状态；用户点 continue 后重新调报告工具
  ↓
推论：
  ● gate Promise 不应监听子对话自己的 abort signal
  ● 外层 catch 可能的异常时吞掉
  ↓
代码约束：
  // gateWait 中不添加 abort listener
  ctx.gate = { resolve };  // 不监听 abortSignal
```

---

### 11. 不主动 throw（J）

```
J ── 不依赖异常做控制流，每个路径返回有意义的结果
  ↓
推论：
  ● isAborted() 不 throw → kill children + return cancelled status
  ● review 失败也 return 而非 throw

豁免（允许 throw 的场景）：
  ● 前置条件 violation（session.create 返回空 ID 等初始化错误）
  ● gate release 后的错误传播（catch → gateAccept → rethrow），
    此时 gate 已安全 release，rethrow 让上层感知失败
  ● 内部一致性 violation（registry 中找不到 context、store 中找不到 report）
    这些表示内部 bug，不应静默处理
```

---

#### 11a. gateWait 中缺 ctx 时返回错误

```
L ── pre-gate 不得静默丢失
A ── child 只能通过工具返回值通信
D ── squad parent 仍等不到 structured report
J ── 不抛异常
  ↓
推论：
  对普通非 squad 会话，报告工具不会被启用（不在 tools 列表中）。
  对 squad child，如果 sessionID 查不到 ctx，
  返回错误字符串让 LLM 知道并重试。
  ↓
代码：report-tools.ts gateWait()
  if (!ctx) {
    return 'Error: Not a squad session. This tool is only available inside squad orchestration.';
  }
```

---

### 12. SquadRuntime 闭包工厂

```
F ── 所有依赖都通过 deps 注入
A ── createChild 需要 deps.client、deps.directory 等
  ↓
推论：createSquadRuntime(deps: SquadDeps) 返回一个富领域 runtime 对象，
  将底层 deps 闭包化，暴露高级 API（createChild/awaitReport/executeFresh/...）。
  核心模块依赖 runtime，不逐层透传 deps。
```

---

### 13. 拒绝作为"后面再说"的决议

```
D ── review 可能多轮，gate 可能被 reject 多次
  ↓
推论：
  ● After rejection → child 收到反馈字符串 → 修改 → 重调同一报告工具
  ● 报告工具再次被调用 → 新的 gateWait → 新的 nextReport + gate
  ● awaitReport 在外层 loop 中重置 nextReport = new Deferred()
  ↓
关键：structuredStore.set 用 childSessionId 覆盖旧值
  → 重试后新的 report 覆盖旧的 report
  → awaitReport 读到的是最新 report
```

---

### 14. LLM 所见、系统所验、我们所使，三者合一（K）

```
C ── 需要结构化字段
A ── child 的工具定义在子会话中
K ── LLM 看到的 schema = 系统验证的 schema = 我们消费的 schema 必须一致
  ↓
推论：每个阶段只有一个可用的报告工具，由 createChild 的 tools 参数控制。
  LLM 只看到当前阶段的 schema，不可能发错格式的数据。
  
  这比原来的 experiments.addonLaunch.squad 机制更简洁——
  不需要在 child workspace 组装时做 schema 替换。
  ↓
代码约束：
  // runtime.ts createChild — tools 参数控制启用哪个报告工具
  function stageTools(stage):
    switch (stage) {
      case 'global_plan': tools.squad_global_plan = true; break;
      case 'review':      tools.squad_review = true; break;
      case 'dag_design':  tools.squad_dag_design = true; break;
      case 'node_plan':   tools.squad_node_plan = true; break;
      case 'node_exec':   tools.squad_node_exec = true; break;
    }
  
  // report-tools.ts — 每个工具有自己的 Zod schema
  // 校验失败返回错误字符串，不抛异常
  const parsed = GlobalPlanSchema.safeParse(args);
  if (!parsed.success) {
    return `Validation failed: ${parsed.error.message}. Expected: ...`;
  }
```

#### 14a. K 排除的方案

```
❌ 允许 LLM 先发 {reportMarkdown, title} 再通过 error message 纠正
   → 违反 K：LLM 看到的 ≠ 系统验证的
❌ 在 execute 中同时接受两种格式（generic + stage-specific）
   → 违反 K：LLM 看到的 generic ≠ 我们实际消费的 stage-specific
❌ 手工构造 success 回复绕过报告工具
   → 违反 E（不是 K），但也破坏了 K 的一致性
```

#### 14b. 阶段专属工具保障 schema 一致性

```
K ── 传递机制必须可靠工作
  ↓
推论：
  ● 每个阶段只启用一个报告工具（通过 tools 参数）
  ● 报告工具的 description 和 schema 对 LLM 完全可见
  ● LLM 不可能看到其他阶段的 schema
  ● 校验在 report-tools.ts 中用同一 schema 的 safeParse 执行
  → 三者合一是天然保证的，无需额外机制
```

#### 14c. 所有 stage schema 必须 strict（K + L）

```
K ── LLM 所见 = 系统所验 = 我们所使
L ── pre-gate 不得静默丢失
  ↓
推论：
  如果 schema 不 strict，未知字段被 Zod strip 后可能产生虚假的合法输入。
  ReviewSchema 尤其危险：LLM 发 {reportMarkdown, title} 会被 strip 成 {},
  再被 transform 成 feedbackMarkdown: null → 错误地解释为 accept。
  ↓
代码约束：所有 squad stage schema 必须：
  z.object({ ... }).strict()
  任何不在 schema 中的字段 → validation failure
```

---

### 15. Schema validation 失败时返回错误字符串（J + K）

```
J ── 不主动 throw
K ── LLM 看到的 schema ≠ 系统验证的 schema 违反一致性
  ↓
推论：当 LLM 发送的 args 不符 stage-specific schema 时：
  ● 不能 throw（违反 J）
  ● 不能静默接受（违反 K）
  ● 必须返回错误字符串（LLM 看到后可以修正并重试）
```

---

### 16. S/M/L 路径分发由结构化 plan 的 size 字段决定（C + D）

```
C ── orchestrator 需要结构化字段做分支决策
D ── 不同路径需要不同程度的 review
↓
推论：
● planReport.size === "S" → 无 review，直接执行（gate hang → runSPath → gateAccept）
● planReport.size === "M" → Global Review（pre-exec）+ withReviewLoop 执行
● planReport.size === "L" → Global Review + DAG + End Review
↓
三种路径共享同一结构：
gate hang → [review?] → [execution] → gateAccept/gateReject
```

---

### 17. 外层 while(true) 和内层 while(true) 的双层结构（F + D）

```
F ── 创建新 child 的唯一方式是 session API（一次调用一个）
D ── review 可能在 gate reject 后多轮
↓
推论：
● 外层：createChild(global_plan) → 内层 loop → 完成 → return
如果内层因为不可恢复错误退出 → continue 创建新 plan child
● 内层：awaitReport → review → reject/accept
如果 gateReject → continue 内层（同一 plan child 重试）
如果 gateAccept → break 内层 → cleanup → return
```

---

### 18. review 阶段必须被 try-catch 包裹（G + J）

```
G ── gate 必须被 release
J ── 不主动 throw
  ↓
推论：
  const review = await runtime.executeFresh({ stage: "review", ... })
  // 如果 executeFresh 抛出异常 → plan child gate 没 release → 违反 G
  // 同时异常传播 → 违反 J

修正：
  let review: ReviewReport;
  try {
    review = await runtime.executeFresh({ stage: "review", ... });
  } catch (err) {
    runtime.gateAccept(planChildId);    // G: release gate
    await runtime.cleanupChild(planChildId);
    throw err;                          // 此处 throw 不可避免（上层需要知道异常）
  }
```

---

## 完整控制流（推导的合成）

以下控制流是以上所有推导的必然合成。每步标注对应的推导编号。这些步骤构成 PRD-03 中具体路径（S/M/L）的骨架。

```

用户调 /squad 或 squad({ intent })
│
▼
squad tool execute() 被调用 [§12]
│ 创建 structuredStore、createdChildIds、abortSignal
│
▼
orchestrator runSquad(params)
│
├─ 外 while(true) ───────────────────────────┐ [§17]
│ ↑ │
│ ├─ runtime.createChild(...) │ [§6+§7]
│ │ client.session.create() → sessionId │
│ │ squadSessions.set(sessionId, ctx) │ [§5a]
│ │ client.session.prompt({..., tools}) │
│ │ │
│ ├─ 内 while(true) ────────────────┐ │ [§17]
│ │ ↑ │ │
│ │ runtime.awaitReport(childId) │ │ [§2]
│ │ → await ctx.nextReport.promise │ │
│ │ → reset nextReport = new Deferred │
│ │ → read structuredStore.get(id) │
│ │ │ │
│ │ 分支 planReport.size: │ │ [§16]
│ │ │ │
│ │ S: runSPath → gateAccept │ │
│ │ M: review → runMPath → gateAccept │
│ │ L: review → DAG → gateAccept/reject │
│ │ review 必包 try-catch │ │ [§18]
│ │ │ │
│ │ reject → continue 内层 ──────┘ │ [§4+§13]
│ │ gateWait → feedback string │
│ │ child 修改 → 重调报告工具 │
│ │ → 新 gateWait → 新 nextReport │
│ │ │
│ └─ accept → gateAccept → cleanupChild ───────┘ [§3]
│ gateWait → return 'Report accepted. No further work is required.' │
│ → child 永久完成 │
│
└─ return SquadResult ───────────────────────────┘
│
▼
squad tool finally: [§8c+§9]
for each createdChildId:
  squadSessions.delete(id)
  structuredStore.delete(id)
  try { await client.session.abort({...}); } catch { /* best-effort */ }

```

**此控制流的 S/M/L 具体展开见 [03 — 编排流程](./03-workflow.md)。**

---

## 哪些设计被原理证明是多余的

| 曾存在的设计                     | 原理检验                                                                 | 结论                                     |
| -------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| `agent_report` wrapper 拦截       | 插件架构无 wrapper 机制，用阶段专属工具替代                                | 已替换为 report-tools.ts                  |
| `task` wrapper 拦截               | 插件不拦截已有工具，注册独立的 `/squad` 命令                              | 已替换为 squad-tool.ts                    |
| `forwarding` flag                | 无原理支撑：A ⊨ 模型不能并发调工具，此标志不可能命中                     | 已删除 ✅                                  |
| 墓碑机制                         | 不再需要：G 保证 gate 在 cleanup 前被 release；H 保证 abort 时 cleanup  | 已删除                                   |
| `errors.ts` / `SquadRejectError` | 违反 J（依赖异常做控制流）                                               | 已删除                                   |
| 手工 `{success: true}`           | 违反 E                                                                   | 改为 gate accept 返回字符串 ✅            |
| `experiments.addonLaunch.squad`   | 不再需要：插件架构下工具定义通过 tools 参数控制                           | 删除，改用 tools 参数                     |
| `SquadLaunchContext`              | 不再需要：上下文通过 squadSessions Map 按 sessionId 查找                 | 删除，改用 SquadSession 预注册            |
| `globalRegistry` (context-registry)| 合并进 squadSessions                                                   | 删除，单一全局 Map                        |
| `SQUAD_TIMEOUT_MS` 超时机制      | 违反 N：liveness 由语义信号保证（promptPromise resolve + nudge 次数），不依赖时间 | 已删除 ✅                                  |