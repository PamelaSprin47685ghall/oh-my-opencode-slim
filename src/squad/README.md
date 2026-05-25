# Squad Addon

Squad 是一个 Mux addon，通过包装 `task` 和 `agent_report` 工具实现多 agent 协作编排。用户代码无需修改，直接调用 `task` 即可。

---

## 设计基础：12 条第一性原理

全部架构决策由以下原理严格推导而来。完整推导链见 [PRD/02-wrapper-architecture.md](PRD/02-wrapper-architecture.md)。

| #   | 原理                                                          | 来源           |
| --- | ------------------------------------------------------------- | -------------- |
| A   | 子 agent 是独立 AI workspace，通道仅 tool input/output        | 系统架构       |
| B   | `agent_report` 返回 `{success: true}` 后 task system 认定完成 | task mechanism |
| C   | orchestrator 需要结构化字段做分支决策                         | 需求           |
| D   | review 需要双向通信                                           | 需求           |
| E   | 绝不手工造 `ok` 回复                                          | 第一性选择     |
| F   | 仅 task creation 能创建 workspace                             | 工程约束       |
| G   | Gate 必须被 release（accept or reject）                       | 工程约束       |
| H   | 主对话终止时杀所有子对话                                      | 需求           |
| I   | 子对话终止时不做任何事                                        | 需求           |
| J   | 不主动 throw                                                  | 风格           |
| K   | LLM 所见、系统所验、我们所使，三者合一                        | 工程约束       |
| L   | 进入 gate 之前不得静默丢失 report                             | liveness       |

---

## 三条路径

由 Global Plan 的 `size` 字段决定：

| 路径  | review                                                    | 执行方式                                                 |
| ----- | --------------------------------------------------------- | -------------------------------------------------------- |
| **S** | 无                                                        | 直接执行，plan child gate 在执行期间 hang，完成后 accept |
| **M** | Global Review + withReviewLoop（Exec Review）             | plan child gate 在执行期间 hang                          |
| **L** | Global Review + End Review + 每节点 Node Plan/Exec Review | plan child gate 在整个 DAG 期间 hang                     |

**关键约束**：plan child 的 gate 只在全部执行完成后才 accept。执行期间 child 处于挂起状态。

---

## 模块结构

```
src/addons/squad/
├── register.ts              AddonRegistration（包装 task + agent_report）
├── task-wrapper.ts          拦截 task → runSquad → finally 清理
├── agent-report-wrapper.ts  拦截 agent_report → gateWait
├── squad-context.ts         Deferred + GateVerdict + SquadContext 类型
├── context-registry.ts      ContextRegistry + globalRegistry + gate 工具函数
├── runtime.ts               createSquadRuntime 闭包工厂
├── orchestrator.ts          外层/内层 loop + S/M/L 分发
├── path-s.ts                S 路径执行
├── path-m.ts                M 路径执行（withReviewLoop）
├── path-l.ts                DAG 执行
├── dag-scheduler.ts         自驱动 DAG 调度器
├── node-executor.ts         单节点 withReviewLoop
├── state.ts                 状态持久化
├── resume.ts                断点恢复
├── prompts.ts               prompt 模板 + rejection feedback
├── schemas.ts               Zod schema + schemaForStage + describeSchema
├── report-renderer.ts       renderMarkdown + getTitle
├── context-registry.test.ts 单元测试
├── persistence.test.ts      持久化单元测试
├── PRD/                     设计文档
└── README.md                本文
```

---

## 测试

```bash
bun test src/addons/squad/
```

---

## 文档

| 文件                                                                         | 内容                               |
| ---------------------------------------------------------------------------- | ---------------------------------- |
| [PRD/01-overview.md](PRD/01-overview.md)                                     | 总览 + 12 条原理 + 架构特征表      |
| [PRD/02-wrapper-architecture.md](PRD/02-wrapper-architecture.md)             | 推导全链条（原理 → 代码约束）      |
| [PRD/03-workflow.md](PRD/03-workflow.md)                                     | S/M/L 路径描述 + pre-gate 生命周期 |
| [PRD/04-data-schema.md](PRD/04-data-schema.md)                               | Zod schema + strictness 契约       |
| [PRD/05-agent-report-shim.md](PRD/05-agent-report-shim.md)                   | agent_report wrapper 流程          |
| [PRD/06-integration.md](PRD/06-integration.md)                               | 集成契约 + stream-end settlement   |
| [PRD/07-failure-modes-and-liveness.md](PRD/07-failure-modes-and-liveness.md) | 故障模式、状态机、测试矩阵         |
| [PRD/00-changelog.md](PRD/00-changelog.md)                                   | 变更日志                           |
