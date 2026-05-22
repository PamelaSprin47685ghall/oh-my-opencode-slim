// Type-only import from @ff-labs/fff-node — erased at build time.
// The package is an optional dependency; types are used for internal
// cursor/result shapes only.
import type { GrepCursor, GrepResult, SearchResult } from '@ff-labs/fff-node';

// ── Line truncation ──

const GREP_MAX_LINE_LENGTH = 500;

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
  const trimmed = line.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

// ── File annotation ──

const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;

interface FileAnnotationItem {
  gitStatus: string;
  totalFrecencyScore: number;
  accessFrecencyScore: number;
}

function fffFileAnnotation(item: FileAnnotationItem): string {
  try {
    const git = item.gitStatus;
    if (git && git !== 'clean' && git !== 'unknown' && git !== '') {
      return `  [${git} in git]`;
    }
    const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
    if (frecency >= HOT_FRECENCY) return '  [VERY often touched file]';
    if (frecency >= WARM_FRECENCY) return '  [often touched file]';
  } catch {
    // best effort
  }
  return '';
}

// ── Grep output formatting ──

export function formatGrepOutput(result: Pick<GrepResult, 'items'>): string {
  try {
    if (!result?.items?.length) return 'No matches found';
    const lines: string[] = [];
    let currentFile = '';
    for (const match of result.items) {
      if (!match) continue;
      if (match.relativePath !== currentFile) {
        if (lines.length > 0) lines.push('');
        currentFile = match.relativePath;
        lines.push(`${currentFile}${fffFileAnnotation(match)}`);
      }
      match.contextBefore?.forEach((line: string, i: number) => {
        const ctxLen = match.contextBefore?.length ?? 0;
        const lineNum = match.lineNumber - ctxLen + i;
        lines.push(` ${lineNum}- ${truncateLine(line)}`);
      });
      lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);
      match.contextAfter?.forEach((line: string, i: number) => {
        const lineNum = match.lineNumber + 1 + i;
        lines.push(` ${lineNum}- ${truncateLine(line)}`);
      });
    }
    return lines.join('\n');
  } catch {
    return '(error formatting grep output)';
  }
}

// ── Find output formatting ──

const FIND_WEAK_SAMPLE_SIZE = 5;

function weakScoreThreshold(pattern: string): number {
  const perfect = (pattern || '').length * 12;
  return Math.floor((perfect * 50) / 100);
}

export interface FormattedFindOutput {
  output: string;
  weak: boolean;
  shownCount: number;
}

export function formatFindOutput(
  result: Pick<SearchResult, 'items' | 'scores'>,
  limit: number,
  pattern: string,
): FormattedFindOutput {
  try {
    if (!result?.items?.length) {
      return {
        output: 'No files found matching pattern',
        weak: false,
        shownCount: 0,
      };
    }
    const topScore = result.scores?.[0]?.total ?? 0;
    const weak = topScore < weakScoreThreshold(pattern);
    const effective = weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit;
    const shown = result.items.slice(0, effective);
    return {
      output: shown
        .map((p: { relativePath?: string } | null) =>
          p
            ? `${p.relativePath}${fffFileAnnotation(p as FileAnnotationItem)}`
            : '',
        )
        .filter(Boolean)
        .join('\n'),
      weak,
      shownCount: shown.length,
    };
  } catch {
    return {
      output: '(error formatting find output)',
      weak: false,
      shownCount: 0,
    };
  }
}

// ── Grep cursor store ──

const grepCursorCache = new Map<string, GrepCursor>();
let grepCursorCounter = 0;

export function storeGrepCursor(cursor: GrepCursor): string {
  const id = `fff_c${++grepCursorCounter}`;
  grepCursorCache.set(id, cursor);
  if (grepCursorCache.size > 200) {
    const first = grepCursorCache.keys().next().value;
    if (first) grepCursorCache.delete(first);
  }
  return id;
}

export function getGrepCursor(id: string): GrepCursor | undefined {
  return grepCursorCache.get(id);
}

// ── Find cursor store ──

export interface FindCursorData {
  query: string;
  pattern: string;
  pageSize: number;
  nextPageIndex: number;
  externalBasePath?: string | null;
}

const findCursorCache = new Map<string, FindCursorData>();
let findCursorCounter = 0;

export function storeFindCursor(data: FindCursorData): string {
  const id = `${++findCursorCounter}`;
  findCursorCache.set(id, data);
  if (findCursorCache.size > 200) {
    const first = findCursorCache.keys().next().value;
    if (first) findCursorCache.delete(first);
  }
  return id;
}

export function getFindCursor(id: string): FindCursorData | undefined {
  return findCursorCache.get(id);
}
