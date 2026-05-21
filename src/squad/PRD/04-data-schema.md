# 04 — 数据 Schema

本文档描述 squad 的 schema 定义、类型、校验错误处理和 Markdown 渲染。设计推导见 [02 — 第一性原理推导全链条](./02-architecture.md)（尤其是原理 C + K）。

---

## Strictness 契约

所有 squad stage schema 必须 strict。未知字段必须导致 validation failure。

原因：

- LLM 所见 schema、系统所验 schema、orchestrator 所用字段必须一致（原理 K）。
- 如果未知字段被 strip，错误输入可能被误解释为合法输入（原理 L）。
- ReviewSchema 尤其危险：`{ reportMarkdown, title }` 被 strip 后会变成 accept。

代码约束：

```ts
// ✅ 必须
const ReviewSchema = z.object({ feedbackMarkdown: ... }).strict();
// ❌ 禁止
const ReviewSchema = z.object({ feedbackMarkdown: ... }); // 无 strict
```

### 校验失败与重试的关系

schema validation failure **不会进入 gate**，不会 `nextReport.resolve()`。它返回错误字符串给 LLM 修正。

若 LLM 未修正而会话结束，orchestrator 的 `awaitReport` 将持续等待直到超时或外部中止。

---

## SquadStage

```ts
type SquadStage = "global_plan" | "review" | "dag_design" | "node_plan" | "node_exec";
```

每个 `createChild` 调用携带一个 stage，通过 `tools` 参数控制子会话启用哪个报告工具。

---

## 各阶段 Schema

### Global Plan（唯一带 size 的阶段）

```ts
const GlobalPlanSchema = z
  .object({
    size: z.enum(["S", "M", "L"]),
    planMarkdown: z.string().min(1),
  })
  .strict();
```

`size` 驱动 orchestrator 的 S/M/L 路径分发（推导 §16）。

### Review

```ts
const ReviewSchema = z
  .object({
    feedbackMarkdown: z
      .string()
      .optional()
      .nullable()
      .transform((v) => {
        if (v == null) return null;
        const trimmed = v.trim();
        if (trimmed.length === 0) return null;
        if (trimmed.toLowerCase() === "null") return null; // LLM 有时输出字面 "null"
        return v;
      }),
  })
  .strict();
```

**语义：**

| 收敛结果 | LLM 输入                                 | 含义   |
| -------- | ---------------------------------------- | ------ |
| `null`   | `null` / `""` / `"  "` / `"null"` / 缺失 | Accept |
| 字符串   | 非空、非空白、非字面 "null" 的任意内容   | Reject |

### DAG 设计

```ts
const EdgeSchema = z.object({ child: z.string().min(1), parent: z.string().min(1) }).strict();

const DagDesignSchema = z
  .object({
    nodes: z.array(z.object({ name: z.string().min(1) }).strict()).min(1),
    edges: z.array(EdgeSchema),
  })
  .strict()
  .refine(
    (data) => {
      const nodeNames = new Set(data.nodes.map((n) => n.name));
      if (nodeNames.size !== data.nodes.length) return false;
      for (const edge of data.edges) {
        if (!nodeNames.has(edge.child)) return false;
        if (!nodeNames.has(edge.parent)) return false;
        if (edge.child === edge.parent) return false;
      }
      return true;
    },
    { message: "Invalid DAG: duplicate names, unknown nodes, or self-dependency" }
  );
```

校验通过 `.refine()` 拦截重复节点名、未知节点引用、自依赖。环路检测在 `schemas.ts` 中的 `isAcyclic` 深度优先排序算法进行同步、静态校验。

### Node Plan

```ts
const NodePlanSchema = z.object({ planMarkdown: z.string().min(1) }).strict();
```

### Node Exec

```ts
const NodeExecSchema = z
  .object({
    reportMarkdown: z.string().min(1),
    affectedFiles: z.array(z.string()),
  })
  .strict();
```

`affectedFiles`：

- 缺失或类型不对 → 校验错误，child 修正重试
- `[]` 合法（没有修改任何文件）

---

## 阶段专属报告工具

squad 不包装或拦截 `agent_report`。而是在插件中注册 5 个独立工具，每个工具有自己的 Zod schema。子会话通过 `createChild` 的 `tools` 参数只启用当前阶段的报告工具。

| 工具名                | Schema 来源              | 启用阶段                                  |
| --------------------- | ------------------------ | ----------------------------------------- |
| `squad_global_plan`   | `GlobalPlanSchema`       | global_plan                               |
| `squad_review`        | `ReviewSchema`           | review                                    |
| `squad_dag_design`    | `DagDesignSchema`        | dag_design                                |
| `squad_node_plan`     | `NodePlanSchema`         | node_plan                                 |
| `squad_node_exec`     | `NodeExecSchema`         | node_exec                                 |

### stageTools 映射

```ts
function stageTools(stage, additionalTools?): Record<string, boolean> {
  const tools = { /* 默认启用 read/glob/grep/ast_grep_search/ast_grep_replace/edit/write, 禁用所有报告工具 */ };
  
  // 只启用当前阶段的报告工具
  switch (stage) {
    case 'global_plan': tools.squad_global_plan = true; break;
    case 'review':      tools.squad_review = true; break;
    case 'dag_design':  tools.squad_dag_design = true; break;
    case 'node_plan':   tools.squad_node_plan = true; break;
    case 'node_exec':   tools.squad_node_exec = true; break;
  }
  
  // planner 和 reviewer 阶段禁用 bash（防止非执行阶段执行 shell 命令）
  if (stage === 'global_plan' || stage === 'node_plan' || stage === 'dag_design' || stage === 'review') {
    tools.bash = false;
  }
  
  return tools;
}
```

---

## gateWait 共享逻辑

所有 5 个工具共享 `gateWait()` 函数：

```ts
async function gateWait(sessionId: string, report: SquadReport): Promise<string> {
  const ctx = squadSessions.get(sessionId);
  if (!ctx) return 'Error: Not a squad session.';
  if (ctx.disposed) return 'Error: Squad session is no longer available.';
  
  ctx.structuredStore.set(ctx.childSessionId, report);  // 存入 store
  ctx.nextReport.resolve();                                // 通知 orchestrator
  const verdict = await new Promise<GateVerdict>((resolve) => {
    ctx.gate = { resolve };                                // 挂起等决议
  });
  
  if (verdict.accepted) return 'Report accepted.';
  
  ctx.nextReport = new Deferred<void>();  // 重置以接收下次报告
  return `Report rejected. Feedback:\n${verdict.feedback}\n\n...`;
}
```

每个工具的 `execute` 方法做 Zod 校验后调用 `gateWait()`，无需关心 gate 机制细节。

---

## 派生类型

```ts
type GlobalPlanReport = { kind: "global_plan"; childTaskId: string } & z.infer<typeof GlobalPlanSchema>;
type ReviewReport = { kind: "review" } & z.infer<typeof ReviewSchema>;
type DagDesignReport = { kind: "dag_design" } & z.infer<typeof DagDesignSchema>;
type NodePlanReport = { kind: "node_plan"; childTaskId: string } & z.infer<typeof NodePlanSchema>;
type NodeExecReport = { kind: "node_exec"; childTaskId: string } & z.infer<typeof NodeExecSchema>;

type SquadReport =
  | GlobalPlanReport
  | ReviewReport
  | DagDesignReport
  | NodePlanReport
  | NodeExecReport;
```

可复用阶段（global_plan、node_plan、node_exec）的 Report 带 `childTaskId`，供外部通过此 ID 调用 gate API。

---

## 校验错误

当 child 发送的 args 不符合 stage-specific schema 时：

```ts
return `Validation failed: ${parsed.error.message}. Expected: ...`;
```

此返回不是手工造的 ok 回复，不违反原理 E。它符合原理 K（LLM 看到错误信息后可以理解并修正）和原理 J（不抛异常，返回错误让 LLM 重试）。

---

## Markdown 渲染 + Title

用于 `gateWait` accept 分支不需要（accept 直接返回字符串），但 `renderMarkdown` 和 `getTitle` 仍用于构建 orchestrator 输出中的节点报告。

```ts
function renderMarkdown(report: SquadReport): string;
function getTitle(report: SquadReport, nodeName?: string): string | undefined;
```

| stage       | renderMarkdown 头部                                       | getTitle                            |
| ----------- | --------------------------------------------------------- | ----------------------------------- |
| global_plan | `## Squad Global Plan (Size: S/M/L)`                      | `"Squad Global Plan"`               |
| review      | `## Squad Review\n**Verdict: ACCEPTED/REJECTED**`         | `"Squad Review: Accepted/Rejected"` |
| dag_design  | `## Squad DAG Design\n### Nodes\n### Edges`               | `"Squad DAG Design"`                |
| node_plan   | `## Squad Node Plan`                                      | `"Squad Node Plan: {nodeName}"`     |
| node_exec   | `## Squad Node Exec Report\n\n{report}\n\nAffected Files` | `"Squad Node Exec: {nodeName}"`     |