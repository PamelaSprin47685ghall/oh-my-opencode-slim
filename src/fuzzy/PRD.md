# Fuzzy Search — 设计文档

## 用途

将 [@ff-labs/fff-node](https://www.npmjs.com/package/@ff-labs/fff-node) 的模糊搜索能力注册为 `glob` / `grep` 插件工具，覆盖 OpenCode 内置同名工具。FFF 提供 frecency 排序、git 感知、SIMD 加速的模糊搜索。

## 工具注册

| 工具名 | 工厂函数 | 覆盖对象 |
|--------|----------|----------|
| `glob` | `createFuzzyGlobTool()` | 内置 `glob` |
| `grep` | `createFuzzyGrepTool()` | 内置 `grep` |

插件工具与内置同名时自动优先。

## 数据流

```
工具调用 → createFuzzyGlobTool / createFuzzyGrepTool
                 ↓
           FinderManager.get(cwd)
                 ↓
           FileFinder.create({ basePath: cwd, aiMode: true })
                 ↓
           fileSearch() / grep()
                 ↓
           formatFindOutput / formatGrepOutput
                 ↓
           返回文本结果
```

## 零配置

FFF 始终启用。`@ff-labs/fff-node` 不可用时静默降级，工具返回错误提示。

## 外部绝对路径

绝对路径绕过 `FinderManager` 缓存，即时创建临时 `FileFinder`，调用完毕后立即销毁。

## 文件结构

```
src/fuzzy/
├── index.ts        # 工厂函数，使用 @opencode-ai/plugin tool API
├── finder.ts       # FinderManager — 惰性 FileFinder 管理
├── format.ts       # 格式化输出 + CursorStore 分页
├── query.ts        # 查询构建（路径约束、排除规则）
├── index.test.ts   # 测试
└── PRD.md          # 本文档
```
