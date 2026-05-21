# 06 — 集成契约

## 插件架构

squad 作为 oh-my-opencode-slim 插件实现，通过 OpenCode SDK 的 Plugin API 注册工具和 agent。OpenCode 核心只提供 session API（`client.session.create/prompt/abort`），不包含 squad 专属逻辑。

---

## 注册方式

`squad-tool.ts` 通过 `createSquadTool(ctx: PluginInput)` 导出一个 `ToolDefinition`，注册为 `/squad` 命令工具。

`agents.ts` 导出 3 个 agent 工厂函数，在插件配置钩子中注册：

| Agent            | 工厂函数                 | 角色                    |
| ---------------- | ------------------------ | ----------------------- |
| `squad_planner`  | `createSquadPlannerAgent` | 分析、规划、DAG 设计    |
| `squad_reviewer` | `createSquadReviewerAgent` | 审查计划、代码、执行报告 |
| `squad_executor` | `createSquadExecutorAgent` | 落地执行代码变更        |

`report-tools.ts` 导出 `createSquadReportTools()` 返回 5 个 `ToolDefinition`，在插件配置钩子中注册。

---

## 依赖的 PluginInput 字段

| 字段              | 用途                                                      |
| ----------------- | --------------------------------------------------------- |
| `ctx.client`      | OpenCode client，使用 `session.create/prompt/abort` API   |
| `ctx.sessionID`   | 父会话 ID，用于创建子会话的 `parentID`                    |

---

## 关键依赖接口

### OpenCode Client Session API

squad 使用 `ctx.client` 的三个 session 方法：

- `session.create({ parentID, title })` — 创建子会话，返回 `{ id: childSessionId }`。用于 `createChild`（推导 §6）。
- `session.prompt({ id: childSessionId, agent, parts, tools })` — 向子会话发送 prompt。只发送 prompt，不等待执行完成。子会话在后台独立运行。
- `session.abort({ id: childSessionId })` — 终止子会话。在 finally 块中调用，用于主对话终止时杀所有子会话（原理 H）。

### SquadSession 全局 Map（squad 内部）

`squadSessions` 是全局 `Map<string, SquadSession>`，在 `squad-context.ts` 中定义。orchestrator 在 `createChild` 中注册，报告工具在 `execute()` 中查找。

```ts
interface SquadSession {
  parentWorkspaceId: string;
  childSessionId: string;
  stage: SquadStage;
  structuredStore: Map<string, SquadReport>;
  nodeName?: string;
  nextReport: Deferred<void>;
  gate?: { resolve: (verdict: GateVerdict) => void };
  disposed?: boolean;
}
```

---

## 工具注册职责边界

| 注册方式                       | 在哪里跑         | 职责                                                                  |
| ------------------------------ | ---------------- | --------------------------------------------------------------------- |
| `/squad` 命令                  | 父会话           | 创建 structuredStore + createdChildIds → 调 `runSquad` → finally 清理 |
| 5 个报告工具                   | 子会话           | 校验 schema → 存 store → gateWait → 返回 accept/reject 字符串        |
| 3 个 squad agent               | 子会话           | 根据 prompt 执行规划/审查/执行任务                                   |

---

## 文件清单

```
src/squad/
├── squad-tool.ts           ~87行   /squad 命令工具入口
├── squad-context.ts        ~63行   SquadSession、Deferred、GateVerdict、全局 squadSessions Map
├── report-tools.ts         ~256行  5 个阶段专属报告工具 + gateWait 共享逻辑
├── runtime.ts              ~363行  createSquadRuntime 闭包工厂
├── orchestrator.ts         ~157行  外层 + 内层 loop, S/M/L 分发
├── path-s.ts               ~42行   S 路径执行
├── path-m.ts                ~23行   M 路径执行（withReviewLoop）
├── path-l.ts                ~37行   DAG 执行
├── dag-scheduler.ts         ~131行  自驱动 DAG 调度器
├── node-executor.ts         ~56行   单节点 withReviewLoop（Node Plan + Node Exec）
├── agents.ts                ~108行  3 个 squad agent 工厂函数
├── prompts.ts               ~324行  prompt 模板 + feedback 注入
├── schemas.ts                ~155行  Zod schema + 类型 + schemaForStage + describeSchema
├── report-renderer.ts       ~47行   renderMarkdown + getTitle
├── fs-utils.ts              ~7行    readAffectedFiles（路径列表，不读内容）
├── dag-scheduler.test.ts     测试
├── schemas.test.ts           测试
└── PRD/                      本组文档
```

总计约 1700 LoC（不含 PRD）。

---

## 防递归逃逸控制

创建 Squad 子会话时，通过 `tools` 参数控制可用工具：

- Planner 阶段（global_plan、node_plan、dag_design）和 Reviewer 阶段（review）禁用 `bash` 工具。
- 只启用当前阶段的报告工具，其他 4 个报告工具禁用。
- 防止非执行阶段执行任意 shell 命令或调用错误的报告工具。

---

## 禁止事项

- ❌ 不将 squad 专属逻辑写入 OpenCode 核心文件
- ❌ 不修改 OpenCode SDK 接口
- ❌ 不添加新的 tool wrapper 机制
- ❌ 不引用 `plan` agent（只用 `squad_planner`、`squad_reviewer`、`squad_executor`）
- ❌ 不搞会话间持久化、event sourcing、projection
- ❌ 不新增 UI 组件