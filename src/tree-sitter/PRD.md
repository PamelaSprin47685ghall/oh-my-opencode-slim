# addons/syntax-check — Tree-sitter Syntax Checking

## 问题

Agent 使用 `file_edit_replace_string` / `file_edit_insert` 写文件后，如果产生语法错误（括号不匹配、少分号等），这些错误要等到后续代码执行或编译时才能被发现，反馈延迟。

## 方案

作为 traffic-sidecar（旁路），在成功的文件编辑工具调用后，自动对写入的文件做 tree-sitter 语法检查，将错误信息作为 `syntax_check` 字段附加到工具结果中。LLM 在后续推理中可以读到这些错误并主动修复。

## 架构

```
Tool call
  → withSyntaxCheck (outermost wrapper for file_edit tools)
    → original execute (file read → edit → write → return result)
      → if success: read file from disk → checkSyntax()
        → (optional) add syntax_check field
      → return result
```

## 依赖

- `@kreuzberg/tree-sitter-language-pack` (^1.6.2) — NAPI 原生模块，305 语言支持，按需下载 parser

## 设计决策

| 决策         | 选择                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| 错误信息位置 | `result.syntax_check` 额外字段，而非修改 `warning`（后者已被 path correction 占用） |
| 失败处理     | 静默跳过——无法读取文件、语言不支持、parser 下载失败均不阻塞工具执行                 |
| 初始化       | 惰性初始化——首次使用时下载 parser，后续缓存                                         |
| 耦合度       | 零耦合——wrapper 模式，无需修改原始 Tool 定义、Zod schema、事件系统或 IPC            |
| 端口         | 纯后端 addon，不涉及前端改动                                                        |

### 异常分类隔离契约

为了防止环境异常（如 NAPI 加载、IO 错误）干扰 LLM 对代码语法的判断，静态检查的环境错误和代码真实的语法错误（Syntax Diagnostics）显式隔离：

- **代码语法故障 (Code Diagnostics)**：例如括号不匹配。输出格式为 `{ syntax_check: { lang: string, errors: SyntaxError[] } }`。
- **环境/系统故障 (Infrastructure Warning)**：例如 Parser 加载失败、非 UTF-8 编码。输出格式必须映射为 `system_warning`（如 `{ syntax_check: { system_warning: string } }`），防止 LLM 将环境依赖加载失败误判为自己的代码书写错误而引发死循环。

## 风险

- NAPI 原生模块在 Electron 构建管线中的兼容性需要验证
- 首次解析某语言时有 ~100ms 下载延迟
- 部分 language grammar 质量较低，可能产生误报

### Node.js v25+ 原生库加载兼容性对策

在 Linux x64/arm64 宿主环境上运行 Node.js v25+ 时，原生包可能会因为环境检测报告缺失而误判 musl。系统在标准加载失败后，必须提供旁路物理重定位能力，绕过 `require` 查找链，直接通过相对路径强行动态加载预编译的 `*-gnu.node` 二进制文件。

## 非目标

- ❌ 不提供 LSP 级别的诊断
- ❌ 不修改 bash 工具（bash 中文件写入无法可靠检测）
- ❌ 不添加配置开关或用户设置
- ❌ 不做代码格式化
