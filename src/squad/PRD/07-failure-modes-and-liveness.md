# 07 — Failure Modes & Liveness

本文档记录 squad 的不变量、故障模式、状态机和测试矩阵。

---

## 总体原则

```text
squad 的正确性 = pre-gate delivery correctness
               + gate release correctness
               + cleanup completeness
               + nudge liveness
```

gate release 正确性由原理 G 保证。pre-gate delivery 由原理 L 保证。cleanup completeness 由原理 H 保证。nudge liveness 由原理 N 保证。

---

## Child 状态机

```text
CREATED
  │
  ├─ session.create() → 得到 childSessionId
  │
  ├─ squadSessions.set(childSessionId, ctx)  ← L: 预注册
  │
  ├─ session.prompt({ agent, tools })        ← 只启用当前阶段的报告工具
  │                                            （K: LLM 只看到需要的 schema）
  │
  ▼
TOOLS_AVAILABLE    ← 子会话可用工具已确定
  │
  ▼
REPORT_CALLED      ← child 调用阶段专属报告工具
  │
  ├─ 找不到 ctx → 返回错误字符串（L: fail closed）
  ├─ schema validation failed → 返回错误字符串，LLM 修正（J+K）
  └─ schema validation passed
       ├─ structuredStore.set(childSessionId, report)
       ├─ nextReport.resolve()
       └─ 进入 gateWait
            │
            ▼
GATE_WAITING      ← gate boundary reached
  ├─ ACCEPTED      ← gate resolve({ accepted: true }) → 返回 "Report accepted. No further work is required."
  └─ REJECTED      ← gate resolve({ accepted: false, feedback }) → 返回反馈字符串
                      → nextReport 重置 → 回到 REPORT_CALLED

如果 child 在 REPORT_CALLED 之前静默结束（promptPromise resolve）：
  │
  ▼
SILENT_END
  │
  ├─ nudgeCount < maxNudges → 发送 nudge prompt → 回到 TOOLS_AVAILABLE
  └─ nudgeCount >= maxNudges → 生成 default report → nudgeExhausted = true → gateAccept（跳过审查）
```

### Nudge 机制（原理 N）

当子会话未调用报告工具就静默结束时，orchestrator 检测到 promptPromise
先于 nextReport resolve，触发 nudge 流程：

1. **检测**：`awaitReportInternal` 中 `Promise.race` 发现
   `promptPromise` 先 resolve（child 结束但未调用报告工具）。
2. **nudge**：向同一子会话发送中文提醒 prompt，要求调用对应的
   报告工具。`nudgeCount++`。
3. **重复检测**：nudge prompt 本身也有自己的 promptPromise，
   如果再次静默结束，再次 nudge。
4. **兜底**：当 `nudgeCount >= maxNudges`（默认 3），不再继续 nudge，
   而是调用 `makeDefaultReport()` 生成一个符合 schema 的最小默认报告，
   写入 structuredStore，resolve nextReport，让流程继续。

**设计决策：nudge 不基于时间，仅基于次数。** 不用 timer 超时，
而是通过 `promptPromise` 的 resolve 来检测静默结束。
这是因为子会话的执行时间不可预测（LLM 推理速度差异大），
而静默结束是确定的语义信号。

### 非法状态

| 非法状态                            | 后果                          | 防线                                                     |
| ----------------------------------- | ----------------------------- | -------------------------------------------------------- |
| REPORT_CALLED before squadSessions registered | parent `awaitReport` 永久 hang | `squadSessions.set()` 在 `session.prompt()` 之前完成 |
| session prompt 失败但 ctx 已注册     | ctx 残留在 squadSessions 中    | createChild catch 块中删除 ctx 并从 createdChildIds 移除 |
| unknown fields in schema             | ReviewSchema 误 accept        | 所有 stage schema 必须 `.strict()`                       |
| stageAgent 返回错误 agent            | 子会话使用错误角色执行任务       | stageAgent 映射由 PRD 明确定义（planner/reviewer/executor） |

---

## Liveness invariants

1. **每个 created child 最终必须**：进入 gate 并 accept/reject，或被 abort 清理，或返回明确 failure（含 nudge 兜底）。
2. **squad parent 不允许**无限等待一个已静默结束且不会报告的 child。（原理 N：nudge 机制 + default report 兜底）
3. **gate 一旦创建**，必须 release（原理 G）。
4. **pre-gate 如果失败**，必须 fail closed 或返回错误字符串，不得静默通过（原理 L）。
5. **cleanup 必须完整**：finally 块必须释放所有 gate、清理所有 squadSessions、abort 所有子会话（原理 H）。

### 保活衰退契约

- **DAG 死锁破缺**：`runNodeLoop` 检测到环依赖时抛出异常，不无限等待。
- **DAG 中止**：当 `runtime.isAborted()` 为 true 时，DAG 调度器在执行前检查并抛出 `'Squad aborted'`。
- **节点级中止**：`withReviewLoop` 每次循环开头检查 `runtime.isAborted()`，如果已中止则 gateAccept + cleanup + throw。
- **nudge 兜底**：`awaitReportInternal` 通过 `Promise.race` 检测 `promptPromise` 先于 `nextReport` resolve，最多 nudge `maxNudges` 次（默认 3），之后生成 default report 继续流程（原理 N）。
- **nudge 耗尽时跳过审查**：当 `nudgeExhausted` 标志为 true 时，`withReviewLoop` 跳过审查直接接受默认报告。orchestrator 的全局计划内层循环同样检测此标志，跳过审查直接返回。因为子会话已死亡，审查拒绝后无法修正。

---

## Pre-gate 故障模式

| 故障                       | 现象                              | 检测时机                                | 处理                                           |
| -------------------------- | --------------------------------- | --------------------------------------- | ---------------------------------------------- |
| ctx 未注册                 | parent `awaitReport` 永久 hang    | 报告工具 execute `!ctx`                 | `session.prompt()` 之前注册 ctx（已保证）     |
| session.prompt 失败        | createChild 抛异常                | `session.prompt()` HTTP 错误            | catch 中删除 ctx + 移除 createdChildIds + rethrow |
| schema validation failure  | LLM 看到错误 schema               | 报告工具 `safeParse`                    | 返回错误字符串 + 格式说明                      |
| 会话结束无报告（nudge 可恢复） | child 未调用报告工具               | `awaitReportInternal` 中 `promptPromise` 先 resolve | nudge 提醒 → 重发 prompt → 等待下次报告 |
| 会话结束无报告（nudge 耗尽） | nudge 达到 maxNudges 仍无报告      | `nudgeCount >= maxNudges`               | `makeDefaultReport()` 生成默认空报告，继续流程 |
| stageAgent 映射错误        | 子会话使用了不正确的 agent         | createChild 中 `stageAgent()` 返回值     | 映射已硬编码在 `runtime.ts` 中并有明确 PRD    |

---

## Gate 故障模式

| 故障                     | 现象                   | 处理                                       |
| ------------------------ | ---------------------- | ------------------------------------------ |
| orchestrator 异常退出    | gate 永远 resolve 不了 | `squad-tool.ts` finally 块 release gate + abort children |
| review 阶段抛异常        | gate 永远 resolve 不了 | try-catch 包裹 review，catch 中 gateAccept |
| abort 时 gate 未 release | gate 永远 resolve 不了  | abort 路径先 gateAccept 再 cleanup + throw |
| AI SDK force-kill        | gate promise 永远挂起  | 进程已死，无需处理                         |

---

## Cleanup 故障模式

| 故障                                  | 现象                                   | 处理                                           |
| ------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| `cleanupAllInternal` 遍历已清空的 Set | 子会话永远不被 abort                    | 快照所有 ID 列表后再清空，用快照遍历做 abort  |
| session.abort 失败                    | 子会话残留                              | best-effort cleanup（try-catch 吞掉错误）       |
| createdChildIds 残留                  | 结构化数据泄漏                          | finally 块遍历所有 createdChildIds 清理         |

---

## Nudge 默认报告

当 `nudgeCount >= maxNudges` 且子会话仍未提交报告时，`makeDefaultReport()`
为每个阶段生成符合 schema 的最小默认报告：

| 阶段           | 默认报告内容                                                                      |
| -------------- | --------------------------------------------------------------------------------- |
| `global_plan`  | `{ size: "S", planMarkdown: "(未提交计划 — 子会话未调用报告工具。)" }`            |
| `review`       | `{ feedbackMarkdown: "评审跳过：子会话未调用报告工具。" }`                         |
| `dag_design`   | `{ nodes: [{ name: "default-node" }], edges: [] }`                                |
| `node_plan`    | `{ planMarkdown: "(未提交计划 — 子会话未调用报告工具。)" }`                        |
| `node_exec`    | `{ reportMarkdown: "(未提交报告 — 子会话未调用报告工具。)", affectedFiles: [] }`  |

这些默认报告确保下游编排不会因缺少字段而崩溃，同时通过内容明确标记为未提交。

---

## 测试矩阵

| Case                                                          | 期望                               |
| ------------------------------------------------------------- | ---------------------------------- |
| 报告工具在非 squad 会话中调用                                  | 返回 "Not a squad session" 错误字符串 |
| 报告工具 schema validation 失败                                | 返回错误字符串 + 期望格式描述       |
| ReviewSchema 收到 `{ reportMarkdown, title }`                  | validation failure，不进入 gate    |
| squad child 缺 ctx（squadSessions 中无 sessionId）              | 返回错误字符串，不 pass-through    |
| session.prompt() 立即失败                                      | ctx 被清理，createdChildIds 移除，异常传播 |
| orchestrator 异常退出                                          | finally 块释放所有 gate + abort 所有子会话 |
| cleanupAllInternal 调用顺序                                    | 先快照 ID → 清空 Set → 用快照 abort |
| DAG 环依赖检测                                                 | 抛出 "Invalid DAG: Cycle detected"   |
| DAG 中止检测                                                   | 抛出 "Squad aborted"               |
| withReviewLoop 中止检测                                        | gateAccept + cleanup + throw       |
| stageAgent 映射                                                | global_plan/dag_design/node_plan → squad_planner, review → squad_reviewer, node_exec → squad_executor |
| 子会话静默结束（promptPromise 先 resolve）                     | 发送 nudge 提醒，nudgeCount++     |
| nudge 达到 maxNudges 仍无报告                                  | makeDefaultReport() 生成默认报告继续流程 |
| nudge 后子会话正常提交报告                                     | 正常流程继续，nudgeCount 不影响报告内容 |
| nudgeExhausted 会话在 withReviewLoop 中                        | 跳过审查直接接受默认报告，避免无限拒绝循环 |
| nudgeExhausted 会话在 orchestrator 全局计划中                  | 跳过审查直接返回默认计划结果 |