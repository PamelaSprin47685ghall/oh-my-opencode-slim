import path from 'node:path';

import { type ToolDefinition, tool } from '@opencode-ai/plugin';

import { FinderManager } from './finder';
import {
  formatFindOutput,
  formatGrepOutput,
  getFindCursor,
  getGrepCursor,
  storeFindCursor,
  storeGrepCursor,
} from './format';
import { buildQuery } from './query';

const z = tool.schema;

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;

// Lazy loader — avoids CJS require() of ESM-only package (@ff-labs/fff-node has no "require" export)
// Uses Function constructor so TypeScript CJS compilation doesn't transform import() to require()
const fffImport = new Function('spec', 'return import(spec)') as (
  spec: string,
) => Promise<typeof import('@ff-labs/fff-node')>;

export function resolveExternalBasePath(absPath: string): {
  basePath: string;
  pathConstraint: string | null;
} {
  const normalized = path.resolve(absPath);
  const lastSegment = normalized.split(path.sep).pop() ?? '';
  if (
    lastSegment.startsWith('.') ||
    /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)
  ) {
    return {
      basePath: path.dirname(normalized),
      pathConstraint: lastSegment,
    };
  }
  return { basePath: normalized, pathConstraint: null };
}

async function createExternalFinder(basePath: string) {
  const { FileFinder } = await fffImport('@ff-labs/fff-node');
  const result = FileFinder.create({ basePath, aiMode: true });
  if (!result.ok) {
    throw new Error(`Failed to create FFF file finder: ${result.error}`);
  }
  const finder = result.value;
  try {
    await finder.waitForScan(15000);
  } catch {
    // scan timeout is non-fatal
  }
  return finder;
}

// ── Fuzzy Glob tool (overrides built-in glob) ──

const GLOB_DESCRIPTION = `Fast file path search supporting glob patterns and fuzzy matching. Works with any codebase size.

Returns matching file paths ranked by frecency (usage frequency × recency). Git-aware: annotates git-modified and frequently-touched files.

**Usage patterns:**
- Fuzzy search: pattern="index" finds index.ts, src/index.ts, pages/index.tsx
- Glob-like filter: path="src/**/*.ts" constrains to TypeScript files under src/
- Exclude noise: exclude="test/,*.min.js"
- List directory: path="src/components/**"

Default limit 30. Use cursor for pagination when results are truncated.`;

export function createFuzzyGlobTool(): ToolDefinition {
  return tool({
    description: GLOB_DESCRIPTION,
    args: {
      pattern: z
        .string()
        .min(1)
        .describe(
          'Fuzzy filename search query (1-2 terms; extra words narrow results)',
        ),
      path: z
        .string()
        .optional()
        .describe(
          'Path constraint (repo-relative or absolute path outside workspace)',
        ),
      exclude: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Exclude paths (e.g. 'test/,*.min.js')"),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Maximum results per page'),
      cursor: z
        .string()
        .optional()
        .describe(
          'Pagination cursor from a previous result, to continue where you left off',
        ),
    },
    execute: async (args, context) => {
      if (!args.pattern) {
        return 'pattern is required';
      }

      const external: { f: { destroy(): void } | null } = { f: null };
      try {
        const resumed = args.cursor ? getFindCursor(args.cursor) : undefined;
        let externalBasePath: string | null = null;
        let externalPathConstraint: string | null = null;

        if (resumed) {
          externalBasePath = resumed.externalBasePath ?? null;
        } else if (args.path && path.isAbsolute(args.path)) {
          const info = resolveExternalBasePath(path.resolve(args.path));
          externalBasePath = info.basePath;
          externalPathConstraint = info.pathConstraint;
        }

        const activeCwd = context.directory;
        const f = externalBasePath
          ? await (async () => {
              const finder = await createExternalFinder(externalBasePath);
              external.f = finder;
              return finder;
            })()
          : await FinderManager.get(activeCwd);

        const effectiveLimit = resumed
          ? resumed.pageSize
          : Math.max(1, args.limit ?? DEFAULT_FIND_LIMIT);
        const query = resumed
          ? resumed.query
          : buildQuery(
              externalBasePath ? externalPathConstraint : args.path,
              args.pattern,
              args.exclude,
              externalBasePath ?? activeCwd,
              !!externalBasePath,
            );
        const searchPattern = resumed ? resumed.pattern : args.pattern;
        const pageIndex = resumed?.nextPageIndex ?? 0;

        const searchResult = f.fileSearch(query, {
          pageIndex,
          pageSize: effectiveLimit,
        });
        if (!searchResult?.ok) {
          throw new Error(searchResult?.error || 'find failed');
        }

        const result = searchResult.value;
        const formatted = formatFindOutput(
          result,
          effectiveLimit,
          searchPattern,
        );
        let output = formatted.output;
        const shownSoFar =
          pageIndex * effectiveLimit + (result?.items?.length ?? 0);
        const hasMore =
          (result?.items?.length ?? 0) >= effectiveLimit &&
          (result?.totalMatched ?? 0) > shownSoFar;
        const notices: string[] = [];
        if (formatted.weak && formatted.shownCount > 0) {
          notices.push(
            `Query "${searchPattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result?.totalMatched ?? 0}.`,
          );
        }
        if (!formatted.weak && hasMore) {
          const remaining = (result?.totalMatched ?? 0) - shownSoFar;
          const cursorId = storeFindCursor({
            query,
            pattern: searchPattern,
            pageSize: effectiveLimit,
            nextPageIndex: pageIndex + 1,
            externalBasePath: externalBasePath ?? undefined,
          });
          notices.push(
            `${remaining} more match${remaining === 1 ? '' : 'es'} available. cursor="${cursorId}" to continue`,
          );
        }
        if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;

        return output;
      } catch (err) {
        return `glob error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        if (external.f) {
          try {
            external.f.destroy();
          } catch {
            // cleanup best-effort
          }
        }
      }
    },
  });
}

// ── Fuzzy Grep tool (overrides built-in grep) ──

const GREP_DESCRIPTION = `Search file contents using fuzzy-aware content search. Smart-case, auto-detects regex vs literal, git-aware, frecency-ranked.

- Smart-case: case-insensitive when pattern is all lowercase
- Auto-detects regex vs literal matching
- Fuzzy fallback when no exact matches found
- Context lines: use context parameter for surrounding lines

Default limit 20. Use cursor for pagination. Supports constraint syntax in pattern: '*.ts pattern' or 'src/ pattern'.`;

export function createFuzzyGrepTool(): ToolDefinition {
  return tool({
    description: GREP_DESCRIPTION,
    args: {
      pattern: z
        .string()
        .min(1)
        .describe('Search pattern (literal text or regex)'),
      path: z
        .string()
        .optional()
        .describe(
          "Path constraint (repo-relative or absolute path outside workspace). Use 'src/', '*.ts' for include, and exclude for noise.",
        ),
      exclude: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Exclude paths (e.g. 'test/,*.min.js')"),
      caseSensitive: z
        .boolean()
        .optional()
        .describe(
          'Force case-sensitive matching (smart-case by default — case-insensitive when pattern is all lowercase)',
        ),
      context: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Number of context lines before and after each match'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Maximum number of matches to return'),
      cursor: z
        .string()
        .optional()
        .describe(
          'Pagination cursor from a previous result, to continue where you left off',
        ),
    },
    execute: async (args, context) => {
      if (!args.pattern) {
        return 'pattern is required';
      }

      const external: { f: { destroy(): void } | null } = { f: null };
      try {
        let externalBasePath: string | null = null;
        let externalPathConstraint: string | null = null;
        if (args.path && path.isAbsolute(args.path)) {
          const info = resolveExternalBasePath(path.resolve(args.path));
          externalBasePath = info.basePath;
          externalPathConstraint = info.pathConstraint;
        }

        const activeCwd = context.directory;
        const f = externalBasePath
          ? await (async () => {
              const finder = await createExternalFinder(externalBasePath);
              external.f = finder;
              return finder;
            })()
          : await FinderManager.get(activeCwd);

        const effectiveLimit = Math.max(1, args.limit ?? DEFAULT_GREP_LIMIT);
        const query = buildQuery(
          externalBasePath ? externalPathConstraint : args.path,
          args.pattern,
          args.exclude,
          externalBasePath ?? activeCwd,
          !!externalBasePath,
        );

        const hasRegexSyntax =
          args.pattern !== args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let mode: 'plain' | 'regex' | 'fuzzy' = hasRegexSyntax
          ? 'regex'
          : 'plain';
        if (mode === 'regex') {
          try {
            new RegExp(args.pattern);
          } catch {
            mode = 'plain';
          }
        }

        const trimmed = args.pattern.trim();
        const isWildcardOnly =
          hasRegexSyntax &&
          /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(
            trimmed,
          );
        if (isWildcardOnly) {
          return `Pattern '${args.pattern}' matches everything — grep needs a concrete substring or identifier.`;
        }

        const smartCase = args.caseSensitive !== true;
        const grepResult = f.grep(query, {
          mode,
          smartCase,
          maxMatchesPerFile: Math.min(effectiveLimit, 50),
          cursor: args.cursor ? (getGrepCursor(args.cursor) ?? null) : null,
          beforeContext: args.context ?? 0,
          afterContext: args.context ?? 0,
          classifyDefinitions: true,
        });
        if (!grepResult?.ok) {
          throw new Error(grepResult?.error || 'grep failed');
        }

        let result = grepResult.value;
        let fuzzyNotice: string | null = null;
        if (!result?.items?.length && !args.cursor && mode !== 'regex') {
          try {
            const fuzzy = f.grep(query, {
              mode: 'fuzzy',
              smartCase,
              maxMatchesPerFile: Math.min(effectiveLimit, 50),
              cursor: null,
              beforeContext: 0,
              afterContext: 0,
              classifyDefinitions: true,
            });
            if (fuzzy?.ok && fuzzy.value?.items?.length) {
              fuzzyNotice = '0 exact matches. Maybe you meant this?';
              result = fuzzy.value;
            }
          } catch {
            // fuzzy fallback best-effort
          }
        }

        let isGrepGlobalTruncated = false;
        if (result?.items && result.items.length > effectiveLimit) {
          result = {
            ...result,
            items: result.items.slice(0, effectiveLimit),
          };
          isGrepGlobalTruncated = true;
        }

        let output = formatGrepOutput(result);
        const notices: string[] = [];
        if (result?.regexFallbackError) {
          notices.push(
            `Invalid regex: ${result.regexFallbackError}, used literal match`,
          );
        }
        if (isGrepGlobalTruncated) {
          notices.push(`Output truncated to ${effectiveLimit} matches`);
        }
        if (result?.nextCursor) {
          notices.push(
            `Continue with cursor="${storeGrepCursor(result.nextCursor)}"`,
          );
        }
        if (notices.length > 0) output += `\n\n[${notices.join('. ')}]`;
        if (fuzzyNotice) output = `[${fuzzyNotice}]\n${output}`;

        return output;
      } catch (err) {
        return `grep error: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        if (external.f) {
          try {
            external.f.destroy();
          } catch {
            // cleanup best-effort
          }
        }
      }
    },
  });
}
