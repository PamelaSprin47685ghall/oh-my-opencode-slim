# 03 — 编排流程

本文档是 [02 — 第一性原理推导全链条](./02-architecture.md) 的自然结论。以下所有路径均由原理 A-L 必然推导而来，不存在其他编排方式而不违反某条原理。

---

## Child 生命周期共同前置流程

每个 squad child，无论属于 global_plan、review、dag_design、node_plan、node_exec，都必须先经过以下 pre-gate 流程：

```
parent createChild(...)
  │
  ├─ client.session.create() → 得到 childSessionId
  │
  ├─ squadSessions.set(childSessionId, ctx)  ← L: 预注册
  │
  ├─ client.session.prompt({ ..., tools })   ← 只启用当前阶段的报告工具（K）
  │                                            （不 await，promptPromise 追踪静默结束）
  │
  ├─ child 调用阶段专属报告工具
  │    ├─ 找不到 ctx → 返回错误字符串（L: fail closed）
  │    ├─ schema validation failed → 返回错误字符串，LLM 修正（J+K）
  │    └─ schema validation passed
  │         ├─ structuredStore.set(childSessionId, report)
  │         ├─ nextReport.resolve()
  │         └─ 进入 gateWait
  │
  ├─ [promptPromise 先 resolve？] ← N: 检测静默结束
  │    ├─ nudgeCount < maxNudges → 发送 nudge 提醒，nudgeCount++，重试
  │    └─ nudgeCount >= maxNudges → makeDefaultReport() → 写入 structuredStore → 继续流程
  │
  └─ gateWait 后才进入 accept/reject 二态
```

图中「报告工具 → gate hang」的边隐含上面的 pre-gate 流程。只有 pre-gate 成功后，后续 accept/reject 推导才成立。

静默结束检测（原理 N）：`awaitReportInternal` 通过 `Promise.race` 竞争 `nextReport` 和 `promptPromise`。如果 `promptPromise` 先 resolve，说明子会话结束了但没调用报告工具，此时触发 nudge 机制。

---

## S 路径 — 无 review

```
外层 loop createChild(global_plan)
  │  gate hang ─── 内层 loop awaitReport ─── 读到 { size: "S", planMarkdown }
  │
  ├─ runSPath(planMarkdown)             ← plan child 的 gate 在整个执行期间 hang 住
  │    └─ createChild(node_exec, squad_executor)
  │         └─ 报告工具 → gateAccept → cleanup → return
  │
  ├─ gateAccept(planChildId)             ← 执行完成，释放 plan child 的 gate
  │
  └─ return SquadResult
```

无 review。执行中的 review 不存在。

---

## M 路径 — Global Review

```
外层 loop createChild(global_plan)
  │  gate hang ─── 内层 loop awaitReport ─── 读到 { size: "M", planMarkdown }
  │
  ├─ executeFresh(review) ─── Global Review
  │    ├─ feedbackMarkdown != null → gateReject(planChildId) → continue 内层
  │    └─ 通过
  │
  ├─ runMPath(planMarkdown)             ← plan child 的 gate 在整个执行期间 hang 住
  │    └─ withReviewLoop(node_exec, squad_executor)
  │         ├─ 报告工具 → executeFresh(review)
  │         │    ├─ feedback != null → gateReject → continue（withReviewLoop 内）
  │         │    └─ 通过 → gateAccept → cleanup
  │
  ├─ gateAccept(planChildId)
  │
  └─ return SquadResult
```

Global Review = executeFresh（一次 review child）。Exec Review = withReviewLoop（内部循环）。

---

## L 路径 — Global Review + DAG + End Review

```
外层 loop createChild(global_plan)
  │  gate hang ─── 内层 loop awaitReport ─── 读到 { size: "L", planMarkdown }
  │
  ├─ executeFresh(review) ─── Global Review
  │    ├─ feedback != null → gateReject(planChildId) → continue 内层
  │    └─ 通过
  │
  ├─ runDAGExecution(planMarkdown)      ← plan child 的 gate 在整个 DAG 期间 hang 住
  │    ├─ executeFresh(dag_design, squad_planner)  ─── DAG 图（nodes + edges）
  │    ├─ runNodeLoop(nodes, edges)
  │    │    └─ 每节点 withReviewLoop(node_plan, squad_planner) + withReviewLoop(node_exec, squad_executor)
  │    └─ executeFresh(review, squad_reviewer)       ─── End Review（feedbackMarkdown）
  │
  ├─ feedbackMarkdown != null
  │    └─ gateReject(planChildId, renderExecRejectionFeedback(...))
  │    └─ continue 内层                    ← 同一 plan child 带着执行反馈重试
  │
  ├─ gateAccept(planChildId)             ← end review 通过，释放 plan child
  │
  └─ return SquadResult（含所有 nodeResults）
```

End review 拒绝时不重建 plan child，而是 gateReject 带 feedback 让同一个 plan child 修正。

---

## 返回结构

```ts
interface SquadResult {
  taskId: string;
  reportMarkdown: string;
  status: "completed" | "cancelled";
  nodes?: Array<{
    name: string;
    status: string;
    reportMarkdown?: string;
    affectedFiles?: string[];
  }>;
}
```

S/M 路径只含 `reportMarkdown`。L 路径的 `nodes` 包含所有 DAG 节点结果。

`taskId`：
- S 路径：`execChildId`（node_exec 子会话 ID）
- M 路径：`execReport.childTaskId`（withReviewLoop 返回的报告中的子会话 ID）
- L 路径：`runtime.workspaceId`（父会话 ID）

`status` 只有 `"completed"` 和 `"cancelled"` 两种值。错误情况通过异常传播到 `squad-tool.ts` 的 catch 块处理。