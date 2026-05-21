# 07 — Failure Modes & Liveness

本文档记录 squad 的不变量、故障模式、状态机和测试矩阵。

---

## 总体原则

```text
squad 的正确性 = pre-gate delivery correctness
               + gate release correctness
               + cleanup completeness
```

gate release 正确性由原理 G 保证。pre-gate delivery 由原理 L 保证。cleanup completeness 由原理 H 保证。

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
  │
  ▼
TOOLS_AVAILABLE    ← 子会话可用工具已确定
  │
  ▼
REPORT_CALLED      ← child 调用阶段专属报告工具
  │
  ├─ 找不到 ctx → 返回错误字符串（L: fail closed）
  ├─ schema validation failed → 返回错误字符串（J+K）
  └─ schema validation passed
       ├─ structuredStore.set(childSessionId, report)
       ├─ nextReport.resolve()
       └─ 进入 gateWait
            │
            ▼
GATE_WAITING      ← gate boundary reached
  ├─ ACCEPTED      ← gate resolve({ accepted: true }) → 返回 "Report accepted."
  └─ REJECTED      ← gate resolve({ accepted: false, feedback }) → 返回反馈字符串
                      → nextReport 重置 → 回到 REPORT_CALLED
```

### 非法状态

| 非法状态                            | 后果                          | 防线                                                     |
| ----------------------------------- | ----------------------------- | -------------------------------------------------------- |
| REPORT_CALLED before squadSessions registered | parent `awaitReport` 永久 hang | `squadSessions.set()` 在 `session.prompt()` 之前完成 |
| session prompt 失败但 ctx 已注册     | ctx 残留在 squadSessions 中    | createChild catch 块中删除 ctx 并从 createdChildIds 移除 |
| unknown fields in schema             | ReviewSchema 误 accept        | 所有 stage schema 必须 `.strict()`                       |
| stageAgent 返回错误 agent            | 子会话使用错误角色执行任务       | stageAgent 映射由 PRD 明确定义（planner/reviewer/executor） |

---

## Liveness invariants

1. **每个 created child 最终必须**：进入 gate 并 accept/reject，或被 timeout/abort 清理，或返回明确 failure。
2. **squad parent 不允许**无限等待一个已静默结束且不会报告的 child。
3. **gate 一旦创建**，必须 release（原理 G）。
4. **pre-gate 如果失败**，必须 fail closed 或返回错误字符串，不得静默通过（原理 L）。
5. **cleanup 必须完整**：finally 块必须释放所有 gate、清理所有 squadSessions、abort 所有子会话（原理 H）。

### 最大挂起时间与保活衰退契约

- **整体超时**：`squad-tool.ts` 设置 10 分钟超时（`SQUAD_TIMEOUT_MS = 10 * 60 * 1000`），超时后 Promise.race 触发超时错误。
- **DAG 死锁破缺**：`runNodeLoop` 检测到环依赖时抛出异常，不无限等待。
- **DAG 中止**：当 `runtime.isAborted()` 为 true 时，DAG 调度器在执行前检查并抛出 `'Squad aborted'`。
- **节点级中止**：`withReviewLoop` 每次循环开头检查 `runtime.isAborted()`，如果已中止则 gateAccept + cleanup + throw。

---

## Pre-gate 故障模式

| 故障                       | 现象                              | 检测时机                                | 处理                                           |
| -------------------------- | --------------------------------- | --------------------------------------- | ---------------------------------------------- |
| ctx 未注册                 | parent `awaitReport` 永久 hang    | 报告工具 execute `!ctx`                 | `session.prompt()` 之前注册 ctx（已保证）     |
| session.prompt 失败        | createChild 抛异常                | `session.prompt()` HTTP 错误            | catch 中删除 ctx + 移除 createdChildIds + rethrow |
| schema validation failure  | LLM 看到错误 schema               | 报告工具 `safeParse`                    | 返回错误字符串 + 格式说明                      |
| 会话结束无报告             | child 未调用报告工具               | orchestrator `awaitReport` 超时          | 外层 timeout（10分钟）或 abort 触发 cleanup    |
| stageAgent 映射错误        | 子会话使用了不正确的 agent         | createChild 中 `stageAgent()` 返回值     | 映射已硬编码在 `runtime.ts` 中并有明确 PRD    |

---

## Gate 故障模式

| 故障                     | 现象                   | 处理                                       |
| ------------------------ | ---------------------- | ------------------------------------------ |
| orchestrator 异常退出    | gate 永远 resolve 不了 | `squad-tool.ts` finally 块 release gate + abort children |
| review 阶段抛异常        | gate 永远 resolve 不了 | try-catch 包裹 review，catch 中 gateAccept |
| abort 时 gate 未 release | gate 永远 resolve 不了  | abort 路径先 gateAccept 再 cleanup + throw |
| AI SDK force-kill        | gate promise 永远挂起  | squad-tool timeout 作为最终保底            |

---

## Cleanup 故障模式

| 故障                                  | 现象                                   | 处理                                           |
| ------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| `cleanupAllInternal` 遍历已清空的 Set | 子会话永远不被 abort                    | 快照所有 ID 列表后再清空，用快照遍历做 abort  |
| session.abort 失败                    | 子会话残留                              | best-effort cleanup（try-catch 吞掉错误）       |
| createdChildIds 残留                  | 结构化数据泄漏                          | finally 块遍历所有 createdChildIds 清理         |

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