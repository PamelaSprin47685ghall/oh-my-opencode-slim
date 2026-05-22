import type { ToolDefinition } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';

import { OLLAMA_API_KEY } from './key';

const z = tool.schema;

const OLLAMA_API_BASE = 'https://ollama.com/api';

// ── Web Search ──

export function createOllamaWebSearchTool(): ToolDefinition {
  return tool({
    description: [
      'Search the web for any topic and get clean, ready-to-use content.',
      '',
      'Best for: Finding current information, news, facts, people, companies,',
      'or answering questions about any topic.',
      'Returns: Clean text content from top search results.',
      '',
      'Query tips:',
      'describe the ideal page, not keywords. "blog post comparing React and Vue performance" not "React vs Vue".',
      'Use category:people / category:company to search through Linkedin profiles / companies respectively.',
    ].join('\n'),
    args: {
      query: z
        .string()
        .describe(
          'Natural language search query. Should be a semantically rich description of the ideal page, not just keywords.',
        ),
      numResults: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Number of search results to return (default: 10)'),
    },
    execute: async (
      args: { query: string; numResults?: number },
      context: { abort: AbortSignal },
    ) => {
      try {
        const response = await fetch(`${OLLAMA_API_BASE}/web_search`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OLLAMA_API_KEY}`,
          },
          body: JSON.stringify({
            query: args.query,
            max_results: args.numResults ?? 10,
          }),
          signal: context.abort,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return `Ollama API error (${response.status}): ${body || response.statusText}`;
        }

        const data = (await response.json()) as Record<string, unknown>;
        const results = (data.results as unknown[]) ?? [];
        return JSON.stringify(
          { success: true, results, query: args.query },
          null,
          2,
        );
      } catch (error) {
        if (context.abort.aborted) {
          return 'Request was cancelled';
        }
        return `Search failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

// ── Web Fetch ──

export function createOllamaWebFetchTool(): ToolDefinition {
  return tool({
    description: [
      'Fetch a URL with better extraction for static/docs pages. Supports llms.txt probing, content-focused HTML extraction, metadata, redirects, and an optional prompt processed by a cheap secondary model.',
    ].join(' '),
    args: {
      url: z.string().describe('The URL to fetch'),
      extract_main: z
        .boolean()
        .optional()
        .describe(
          'Extract main content from the page, removing navigation, ads, etc. (default: true)',
        ),
      prefer_llms_txt: z
        .enum(['auto', 'always', 'never'])
        .optional()
        .describe(
          'Probe for llms.txt files before fetching full page (default: auto)',
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          'Optional extraction task to run on the fetched content using a cheap secondary model',
        ),
      timeout: z.number().optional().describe('Timeout in seconds (max 120)'),
    },
    execute: async (
      args: {
        url: string;
        extract_main?: boolean;
        prefer_llms_txt?: string;
        prompt?: string;
        timeout?: number;
      },
      context: { abort: AbortSignal },
    ) => {
      try {
        const response = await fetch(`${OLLAMA_API_BASE}/web_fetch`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OLLAMA_API_KEY}`,
          },
          body: JSON.stringify({
            url: args.url,
            extract_main: args.extract_main ?? true,
            prefer_llms_txt: args.prefer_llms_txt ?? 'auto',
            prompt: args.prompt,
            timeout: args.timeout,
          }),
          signal: context.abort,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return `Ollama API error (${response.status}): ${body || response.statusText}`;
        }

        const data = (await response.json()) as Record<string, unknown>;
        const title = (data.title as string) ?? '';
        const content = (data.content as string) ?? '';
        const byline = (data.byline as string) ?? '';
        const length = typeof data.length === 'number' ? data.length : 0;

        return [
          `Title: ${title}`,
          byline ? `By: ${byline}` : null,
          `Length: ${length}`,
          '',
          content,
        ]
          .filter(Boolean)
          .join('\n');
      } catch (error) {
        if (context.abort.aborted) {
          return 'Request was cancelled';
        }
        return `Fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
