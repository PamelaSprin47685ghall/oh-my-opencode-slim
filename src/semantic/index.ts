/**
 * Semantic tools — AI-powered code edit and search via OpenCode sessions.
 *
 * Spins up a dedicated child session with an appropriate agent prompt,
 * waits for completion, and returns the result summary.
 */

import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import { extractSessionResult, promptWithTimeout } from '../utils/session';

const SEMANTIC_TIMEOUT_MS = 5 * 60 * 1000;

const SEMANTIC_EDIT_PROMPT = `\
You are a code editing agent. Implement the change described below. \
Analyze the workspace codebase, understand the context, and make the changes. \
When done, call agent_report with a summary of what you changed and why.`;

const SEMANTIC_FIND_PROMPT = `\
You are a code search agent. Answer the query described below. \
Search the workspace for the relevant code, examine it, and call agent_report with a \
detailed summary of what you found, including file paths and key code sections.`;

function getAbortSignal(context: unknown): AbortSignal | undefined {
  if (!context || typeof context !== 'object' || !('abort' in context)) {
    return undefined;
  }
  const signal = (context as { abort?: unknown }).abort;
  return signal &&
    typeof signal === 'object' &&
    'addEventListener' in signal &&
    'removeEventListener' in signal &&
    'aborted' in signal
    ? (signal as AbortSignal)
    : undefined;
}

/**
 * Create a semantic edit tool that delegates code changes to a child session.
 */
export function createSemanticEditTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Make code changes by describing your intent — the agent will analyze the codebase and implement the change.',
    args: {
      intent: tool.schema
        .string()
        .min(1)
        .describe(
          'Natural language description of the edit to perform. ' +
            'Must be fully self-contained: include file paths, function names, ' +
            'and enough context for an agent with no prior conversation history to act on it.',
        ),
    },
    async execute(args, context) {
      const directory =
        context &&
        typeof context === 'object' &&
        'directory' in context &&
        typeof (context as { directory?: unknown }).directory === 'string'
          ? (context as { directory: string }).directory
          : ctx.directory;
      const sessionID =
        context && typeof context === 'object' && 'sessionID' in context
          ? (context as { sessionID: string }).sessionID
          : 'unknown';
      const abortSignal = getAbortSignal(context);

      let childSessionID: string | undefined;
      try {
        const session = await client.session.create({
          responseStyle: 'data',
          throwOnError: true,
          query: { directory },
          body: {
            parentID: sessionID === 'unknown' ? undefined : sessionID,
            title: 'Semantic Edit',
          },
        });

        childSessionID =
          (session as { data?: { id?: string }; id?: string })?.data?.id ??
          (session as { data?: { id?: string }; id?: string })?.id;
        if (!childSessionID) {
          throw new Error('Semantic edit session did not return an id');
        }

        await promptWithTimeout(
          client,
          {
            responseStyle: 'data',
            throwOnError: true,
            query: { directory },
            path: { id: childSessionID },
            body: {
              agent: 'fixer',
              parts: [
                {
                  type: 'text',
                  text: `${SEMANTIC_EDIT_PROMPT}\n\nIntent: ${args.intent}\n\nInstructions:\n1. Understand the requested change and locate the relevant code.\n2. Make precise, minimal edits — do not modify unrelated code.\n3. Run the most relevant validation checks when practical.\n4. Stop when the requested task is done.\n\nReturn your final response in this format:\n\n<semantic_result>\nStatus: completed | blocked | partial\n\nChanges made:\n- ...\n\nFiles touched:\n- ...\n\nValidation:\n- ...\n\nRisks / follow-up:\n- ...\n</semantic_result>`,
                },
              ],
            },
          },
          SEMANTIC_TIMEOUT_MS,
          abortSignal,
        );

        const extraction = await extractSessionResult(client, childSessionID, {
          directory,
          includeReasoning: false,
        });

        if (extraction.empty) {
          throw new Error('Semantic edit session returned no result');
        }

        return extraction.text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Semantic edit failed: ${message}`;
      } finally {
        if (childSessionID) {
          try {
            await client.session.abort({
              path: { id: childSessionID },
              query: { directory },
            });
          } catch {
            // Best-effort cleanup
          }
        }
      }
    },
  });
}

/**
 * Create a semantic find tool that delegates code search to a child session.
 */
export function createSemanticFindTool(ctx: PluginInput): ToolDefinition {
  const client = ctx.client;

  return tool({
    description:
      'Search codebases using natural-language queries instead of regex or grep.',
    args: {
      query: tool.schema
        .string()
        .min(1)
        .describe(
          'Natural-language search query for finding relevant code. ' +
            'Must be fully self-contained: include enough context (file names, symbols, patterns) ' +
            'for an agent with no prior conversation history to locate the relevant code.',
        ),
    },
    async execute(args, context) {
      const directory =
        context &&
        typeof context === 'object' &&
        'directory' in context &&
        typeof (context as { directory?: unknown }).directory === 'string'
          ? (context as { directory: string }).directory
          : ctx.directory;
      const sessionID =
        context && typeof context === 'object' && 'sessionID' in context
          ? (context as { sessionID: string }).sessionID
          : 'unknown';
      const abortSignal = getAbortSignal(context);

      let childSessionID: string | undefined;
      try {
        const session = await client.session.create({
          responseStyle: 'data',
          throwOnError: true,
          query: { directory },
          body: {
            parentID: sessionID === 'unknown' ? undefined : sessionID,
            title: 'Semantic Find',
          },
        });

        childSessionID =
          (session as { data?: { id?: string }; id?: string })?.data?.id ??
          (session as { data?: { id?: string }; id?: string })?.id;
        if (!childSessionID) {
          throw new Error('Semantic find session did not return an id');
        }

        await promptWithTimeout(
          client,
          {
            responseStyle: 'data',
            throwOnError: true,
            query: { directory },
            path: { id: childSessionID },
            body: {
              agent: 'explorer',
              parts: [
                {
                  type: 'text',
                  text: `${SEMANTIC_FIND_PROMPT}\n\nQuery: ${args.query}\n\nInstructions:\n1. Understand the search query and identify relevant files.\n2. Examine the code carefully and summarize findings.\n3. Include file paths and key code sections.\n4. Stop when you have thoroughly answered the query.\n\nReturn your final response in this format:\n\n<semantic_result>\nStatus: completed | blocked | partial\n\nFindings:\n- ...\n\nFiles examined:\n- ...\n\nKey code sections:\n- ...\n\nRisks / follow-up:\n- ...\n</semantic_result>`,
                },
              ],
            },
          },
          SEMANTIC_TIMEOUT_MS,
          abortSignal,
        );

        const extraction = await extractSessionResult(client, childSessionID, {
          directory,
          includeReasoning: false,
        });

        if (extraction.empty) {
          throw new Error('Semantic find session returned no result');
        }

        return extraction.text;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Semantic find failed: ${message}`;
      } finally {
        if (childSessionID) {
          try {
            await client.session.abort({
              path: { id: childSessionID },
              query: { directory },
            });
          } catch {
            // Best-effort cleanup
          }
        }
      }
    },
  });
}
