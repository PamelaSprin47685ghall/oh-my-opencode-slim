# Squad Persistence Plan

## 一、目标

为 `/squad` 指令加入磁盘持久化。每次 `runSquad` 在当前工作目录生成 `squad/<Timestamp>/` 目录，若干 TOML 文件记录状态。任何时候掉电，执行无参数的 `/squad` 可列出可恢复任务，用户通过 `/squad resume <timestamp>` 从断点继续执行。允许 session 内部上下文丢失，但 Gate（plan review、node review、end review）通过状态是可恢复的。

---

## 二、TOML 文件结构（`squad/<timestamp>/`）

```
squad/
├── 20250525T143052/          # ISO 8601 basic format，去掉分隔符
│   ├── meta.toml              # 任务级元数据
│   ├── plan.toml              # 全局计划尝试历史
│   ├── dag.toml               # DAG 设计结果
│   └── nodes.toml             # DAG 节点执行结果
```

### `meta.toml`

```toml
timestamp = "2025-05-25T14:30:52.000Z"
intent = "Refactor auth module to use JWT"
directory = "/home/user/project"
status = "running"   # running | completed | cancelled
size = "L"           # S|M|L，首次 plan 确定后写入
```

### `plan.toml`

```toml
[[attempts]]
index = 0
size = "L"
planMarkdown = "..."
reviewFeedback = null      # null = accepted
gateAccepted = true
```

### `dag.toml`

```toml
[nodes]
names = ["parser", "lexer", "tests"]

[[edges]]
parent = "parser"
child = "lexer"

[[edges]]
parent = "lexer"
child = "tests"
```

### `nodes.toml`

记录每个节点的执行结果（plan + exec 双重 review 全部通过后写入）。

```toml
[[nodes]]
name = "parser"
status = "completed"
reportMarkdown = "..."
affectedFiles = ["src/parser.ts"]

[[nodes]]
name = "lexer"
status = "pending"      # 恢复时知道哪些需要跳过
```

---

## 三、状态机（断点恢复 Stage）

| `state` in runtime | 含义 | 恢复行为 |
|---|---|---|
| `planning` | 刚创建，尚无 accepted plan | 重新从 0 开始全局计划，复用之前失败的 attempts 作为提示 |
| `plan_reviewed` | plan 已通过 review，size 已确定 | 按 size 进入执行：S path / M path / L path（重新执行，session 可丢） |
| `dag_design` | DAG design 已提交，刚得到结果 | 直接使用已记录的 dag.toml |
| `dag_execution` | DAG 正在执行中 | 已完成节点直接复用 nodes.toml 结果，未完成节点重新执行 |
| `end_review` | 所有 DAG 节点完成，正在 end review | 自动跳过已完成节点，重做 end review |
| `completed` / `cancelled` | 已结束 | 不可恢复（或作为查看历史） |

---

## 四、需要修改的源代码文件

| 文件 | 改动点 |
|---|---|
| `src/squad/state.ts` | **新增**。TOML 读写、目录创建、序列化/反序列化。 |
| `src/squad/resume.ts` | **新增**。恢复逻辑、状态机跳转、从磁盘重建 partial 执行上下文。 |
| `src/squad/command.ts` | `/squad` 无参数时扫描目录输出列表；支持 `/squad resume <timestamp>`。 |
| `src/squad/orchestrator.ts` | 每次 plan review gate 通过后写入 `plan.toml`；接受 `resumeState` 参数跳过已完成阶段。 |
| `src/squad/runtime.ts` | `createSquadRuntime` 增加 `snapshot` 回调，child create/cleanup/accept 时触发写盘。 |
| `src/squad/path-s.ts` | 正常路径无特殊改动。 |
| `src/squad/path-m.ts` | 正常路径无特殊改动。 |
| `src/squad/path-l.ts` | DAG design 完成后写 `dag.toml`；end review 前写 `state`；执行完成后写 `nodes.toml`。 |
| `src/squad/dag-scheduler.ts` | 调度前从 nodes.toml 加载已完成节点结果，跳过已 completed 的节点。 |
| `src/squad/schemas.ts` | **可能新增**：ResumeState 类型定义。 |
| `package.json` | `dependencies` 增加 `smol-toml`。 |

---

## 五、关键实现细节

### 1. 状态快照频率

**仅在大 gate 通过后写盘**，避免碎片化：
- 全局 plan review gate **accept** 后 → 写 `meta.toml` + `plan.toml`，`state = plan_reviewed`
- DAG design 成功后 → 写 `dag.toml`，`state = dag_design`
- 每个 DAG node 的 exec review gate **accept** 后 → 追加/更新 `nodes.toml`，`state = dag_execution`
- End review **accept** 后 → `state = completed`，写 `meta.toml`
- 任何时候 `cancelled`/`exhausted` → `state = cancelled`

这样保证"大节点 Gate 可恢复"——plan review、每个 node review、end review 的 accept 状态全部记录。

### 2. `/squad` 无参数输出

利用 `command.execute.before` 的 `output.parts` 返回 Markdown，每条 checkpoint 同时展示 **可立即复制粘贴的 resume 命令**：

```markdown
Available squad checkpoints:
1. 20250525T143052 — Refactor auth module to use JWT (L, running, 2/5 nodes done)
   ➜ /squad resume 20250525T143052
2. 20250524T101103 — Fix login bug (S, completed)
   ➜ /squad resume 20250524T101103
```

Resume 参数严格与列表中显示的 timestamp 一致（ISO 8601 basic 格式去掉分隔符），用户可直接复制整行粘贴执行。

### 3. 恢复时子 session 丢失的处理

恢复逻辑**不尝试恢复 child session 的内部上下文**。对于 `plan_reviewed` 之后的状态：
- 如果是 S/M path：直接重新创建 child session 跑 `node_exec`（或 M path 的 review loop）
- 如果是 L path：DAG design 复用磁盘记录的 DAG；已完成的 nodes 复用 nodes.toml 的结果；未完成的 nodes 用新的 child session 重新执行 `node_plan` + `node_exec`

### 4. `/squad resume` 处理

在 `command.ts` 的 `handleCommandExecuteBefore` 中：
- 如果 `arguments` 以 `resume ` 开头，解析出 `<timestamp>`
- 查找 `squad/<timestamp>/meta.toml`
- 如果存在且 `status !== completed / cancelled`：
  - 读取 `plan.toml`、`dag.toml`、`nodes.toml`
  - 调用 `runSquad({ ...params, resumeState: { timestamp, stage, ...data } })`
- `orchestrator.ts` 入口判断 `resumeState`，决定从哪个 stage 开始

---

## 六、依赖新增

`smol-toml`（TOML v1.0.0，TypeScript，零依赖，parse + stringify）。

```json
"dependencies": {
  "smol-toml": "^1.3.4"
}
```

---

## 七、风险与规避

| 风险 | 规避 |
|---|---|
| `smol-toml` 未安装 | 计划第一步即 `bun add smol-toml` |
| TOML 文件并发写入 | 所有写操作都在 orchestrator 主循环中，单线程，无并发 |
| 恢复时 DAG 节点结果丢失准确性 | nodes.toml 中节点名是 primary key，恢复时严格按 name 匹配 |
| `command.execute.before` 无法阻塞 | 使用两轮交互（已确认），天然支持 |

---

## 八、执行顺序

1. `bun add smol-toml`
2. 新增 `state.ts`
3. 新增 `resume.ts`
4. 修改 `command.ts`
5. 修改 `runtime.ts`（注入 snapshot）
6. 修改 `orchestrator.ts`（接受 resumeState）
7. 修改 `path-l.ts` + `dag-scheduler.ts`（DAG 节点级快照）
8. `bun run check:ci` + `bun test`
