# Semantic Tools

## Overview

AI-powered code edit and search tools that delegate to dedicated OpenCode child sessions. The `semantic_edit` tool creates a fixer agent session to implement changes, while `semantic_find` creates an explorer agent session to search code.

## Tools

### `semantic_edit`

- **Input:** `intent` — natural language description of the edit to perform
- **Behavior:** Spawns a child session with the `fixer` agent, sends a structured prompt, waits for completion, and returns the extracted result
- **Output:** Plain text summary of changes made

### `semantic_find`

- **Input:** `query` — natural language search query
- **Behavior:** Spawns a child session with the `explorer` agent, sends a structured prompt, waits for completion, and returns the extracted result
- **Output:** Plain text summary of findings

## Architecture

Both tools use the OpenCode plugin session API (`client.session.create` + `client.session.prompt` + `client.session.abort`) to create isolated child sessions. Key design:

- **Session isolation:** Each semantic operation gets its own OpenCode session with clean context
- **Agent selection:** `semantic_edit` uses `fixer` agent, `semantic_find` uses `explorer` agent
- **Timeout:** 5 minutes per operation, with abort signal propagation
- **Cleanup:** Sessions are always aborted in `finally` blocks
- **Context extraction:** Uses `extractSessionResult` from shared session utilities

## File Structure

```
src/semantic/
  index.ts       — createSemanticEditTool, createSemanticFindTool
  index.test.ts  — tests (placeholder)
  PRD.md         — this document
```

## Registration

Registered in `src/index.ts` as `semantic_edit` and `semantic_find` in the `tool` object. Takes `PluginInput` (ctx) as constructor parameter.