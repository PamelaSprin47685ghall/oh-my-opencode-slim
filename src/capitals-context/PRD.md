# capitals-context — Project ALL_CAPS Context Injection

## 目的

将项目根目录下的 `ALL_CAPS.md` 文件和 `ALL_CAPS/` 目录内所有文件注入到系统提示词中，让 AI 助手自动感知项目级配置文档（如 `STATUS.md`、`ARCHITECTURE/` 等），无需用户手动搬运。

## 架构（插件模式）

```
experimental.chat.system.transform
  ├── orchestrator prompt injection
  ├── sessionGoalHook.handleSystemTransform()
  ├── capitalsContextHook.handleSystemTransform()  ← caps 自动注入
  └── collapseSystemInPlace()
```

### 注入点

通过 `experimental.chat.system.transform` 插件钩子注入，与 session-goal、orchestrator prompt 等共享同一个 system 数组。内容以 `<caps-context>` XML 标签推入 `output.system`。

## 扫描规则

| 类别   | 模式                      | 排除项                          |
| ------ | ------------------------- | ------------------------------- |
| 根文件 | `/^[A-Z][A-Z0-9_]*\.md$/` | AGENTS.md, CLAUDE.md, README.md |
| 根目录 | `/^[A-Z][A-Z0-9_]*$/`     | AGENTS/, CLAUDE/, NODE_MODULES/ |

- 扫描仅在项目根目录的单层 Entry 触发。若 Entry 为符合正则的大写目录，则深度递归扫描其内部各层级子目录，搜集**所有格式文件**（不仅 .md）。
- 跳过空文件/纯空白文件
- 不可读目录/文件静默跳过

## 输出格式

```xml
<caps-context file="STATUS.md">
active
</caps-context>

<caps-context file="ARCHITECTURE/overview.md">
# Overview
</caps-context>

<caps-context file="ARCHITECTURE/styles/main.css">
body { margin: 0 }
</caps-context>
```

多个文件以空行分隔。

## 设计决策

1. **零配置** — 无 toggle、无配置文件、无持久化状态
2. **全自动包含** — 所有匹配文件无条件注入，排除项通过重命名即可解决
3. **无 `/caps` 命令** — Toggle UI 需要 React 组件 + IPC + 持久化，违背零配置约束
4. **纯同步文件扫描** — `findCapsFiles` 使用 `readdirSync`/`readFileSync`，在 `buildCapitalsContext` 中一次性同步完成，避免异步竞争
5. **XML 标签包裹** — 每个文件用 `<caps-context>` 标签包裹，便于模型区分多个文件来源
6. **跳过空文件** — 空白/纯空白文件不输出，减少 token 浪费
7. **根文件仅 .md，目录包含所有格式** — 根目录 ALL_CAPS.md 限定 markdown；ALL_CAPS/ 目录内递归包含所有文件类型（.css, .txt, .json 等）
8. **插件钩子注入** — 通过 `experimental.chat.system.transform` 钩子注入，与旧的 addon/contextInjector 架构完全解耦

## 文件结构

```
src/capitals-context/
├── index.ts         — 扫描、读取、拼装 CAPS 内容 + handleSystemTransform 钩子
├── index.test.ts    — 单元测试
└── PRD.md           — 设计文档
```

集成到插件：在 `src/index.ts` 中创建 `createCapitalsContextHook(ctx.directory)` 并在 `experimental.chat.system.transform` 中调用。

## LoC

| 文件                | 行数 |
| ------------------- | ---- |
| `index.ts`          | ~165 |
| `index.test.ts`     | ~195 |
| `PRD.md`            | ~75  |
| `src/index.ts` 修改 | +4  |