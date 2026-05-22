/**
 * Tree-sitter syntax check hook — appends diagnostics to file edit/write
 * tool output. Works alongside LSP diagnostics for real-time syntax
 * verification.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';
import { log } from '../utils/logger';
import { checkSyntax } from './checker';

const FILE_EDIT_TOOLS = new Set(['edit', 'Write', 'write', 'ast_grep_replace']);

const SYNTAX_CHECK_MARKER = '[syntax-check]';

interface ToolExecuteAfterInput {
  tool: string;
  sessionID?: string;
  callID?: string;
  args?: {
    path?: string;
    file_path?: string;
    filePath?: string;
    [key: string]: unknown;
  };
}

interface ToolExecuteAfterOutput {
  title?: string;
  output?: unknown;
  metadata?: unknown;
}

function extractFilePath(args: ToolExecuteAfterInput['args']): string | null {
  if (!args || typeof args !== 'object') return null;
  const candidate = args.path ?? args.file_path ?? args.filePath;
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : null;
}

export function createSyntaxCheckHook(_ctx: PluginInput) {
  return {
    'tool.execute.after': async (
      input: ToolExecuteAfterInput,
      output: ToolExecuteAfterOutput,
    ): Promise<void> => {
      if (!FILE_EDIT_TOOLS.has(input.tool)) return;
      if (typeof output.output !== 'string') return;
      if (output.output.includes(SYNTAX_CHECK_MARKER)) return;

      const filePath = extractFilePath(input.args);
      if (!filePath) return;

      const resolvedPath = path.resolve(_ctx.directory, filePath);
      let content: string;
      try {
        content = await fs.readFile(resolvedPath, 'utf-8');
      } catch {
        return;
      }

      const result = await checkSyntax(content, filePath);
      if (!result.ok) return;

      if (result.errors.length === 0) return;

      const lines = [
        '',
        `${SYNTAX_CHECK_MARKER}`,
        `${result.errors.length} syntax issue(s) in ${filePath} (${result.lang}):`,
        ...result.errors.map(
          (e) =>
            `  L${e.line}:${e.column}-${e.endLine}:${e.endColumn} [${e.severity}] ${e.message}`,
        ),
      ];
      output.output += lines.join('\n');

      log('[syntax-check] appended diagnostics', {
        file: filePath,
        lang: result.lang,
        errors: result.errors.length,
      });
    },
  };
}

export type { SyntaxCheckResult, SyntaxError } from './checker';
export { checkSyntax } from './checker';
