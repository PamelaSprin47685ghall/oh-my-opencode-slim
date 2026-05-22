# Ollama Web — 设计文档

## 用途

通过 Ollama 云 API（`ollama.com/api`）提供网络搜索和网页抓取能力，以插件工具 `webfetch` / `websearch` 覆盖 OpenCode 内置同名工具。

## 工具注册

| 工具名 | 工厂函数 | 覆盖对象 |
|--------|----------|----------|
| `websearch` | `createOllamaWebSearchTool()` | 内置 `websearch` |
| `webfetch` | `createOllamaWebFetchTool()` | 内置 `webfetch` |

插件工具与内置同名时自动优先。

## API 契约

### `POST https://ollama.com/api/web_search`

- **Headers**: `Authorization: Bearer <key>` / `Content-Type: application/json`
- **Request**: `{ query, max_results? }`
- **Response**: `{ results: [...] }`

### `POST https://ollama.com/api/web_fetch`

- **Headers**: `Authorization: Bearer <key>` / `Content-Type: application/json`
- **Request**: `{ url, extract_main?, prefer_llms_txt?, prompt?, timeout? }`
- **Response**: `{ title, content, byline, length }`

## 错误处理

统一返回纯字符串错误信息：
- 取消 → `"Request was cancelled"`
- HTTP 错误 → `"Ollama API error (status): body"`
- 异常 → `"Search/Fetch failed: message"`

## 零配置

API key 存放在 `key.ts`，被 `.gitignore` 排除。首次使用时用户需拷贝 `key.ts.example` 填写真实 key。

## 文件结构

```
src/ollama-web/
├── index.ts        # 工厂函数，使用 @opencode-ai/plugin tool API
├── key.ts          # API key（已 .gitignore）
├── key.ts.example  # 示例 key
└── PRD.md          # 本文档
```
