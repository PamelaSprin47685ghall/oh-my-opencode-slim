import { describe, expect, it } from 'bun:test';
import {
  formatFindOutput,
  formatGrepOutput,
  getFindCursor,
  getGrepCursor,
  storeFindCursor,
  storeGrepCursor,
} from './format';
import { resolveExternalBasePath } from './index';
import {
  buildQuery,
  normalizeExcludes,
  normalizePathConstraint,
} from './query';

// ── index.ts ──

describe('resolveExternalBasePath', () => {
  it('treats path with extension as file → parent dir + filename', () => {
    const result = resolveExternalBasePath('/home/user/docs/readme.txt');
    expect(result.basePath).toBe('/home/user/docs');
    expect(result.pathConstraint).toBe('readme.txt');
  });

  it('treats path without extension as directory → self + null', () => {
    const result = resolveExternalBasePath('/home/user/project');
    expect(result.basePath).toBe('/home/user/project');
    expect(result.pathConstraint).toBeNull();
  });

  it('treats dot-prefixed path as file → parent dir + filename', () => {
    const result = resolveExternalBasePath('/home/user/.gitignore');
    expect(result.basePath).toBe('/home/user');
    expect(result.pathConstraint).toBe('.gitignore');
  });

  it('normalizes relative paths', () => {
    const result = resolveExternalBasePath('/tmp/../home/user/file.ts');
    expect(result.basePath).toBe('/home/user');
    expect(result.pathConstraint).toBe('file.ts');
  });
});

// ── query.ts ──

describe('normalizePathConstraint', () => {
  it('returns null for empty path', () => {
    expect(normalizePathConstraint('')).toBe('');
  });

  it('returns null for current directory', () => {
    expect(normalizePathConstraint('.')).toBeNull();
    expect(normalizePathConstraint('./')).toBeNull();
  });

  it('strips leading ./', () => {
    expect(normalizePathConstraint('./src')).toBe('src/');
  });

  it('adds trailing slash for bare directory', () => {
    expect(normalizePathConstraint('src/components')).toBe('src/components/');
  });

  it('keeps trailing slash', () => {
    expect(normalizePathConstraint('src/')).toBe('src/');
  });

  it('keeps glob patterns unchanged', () => {
    expect(normalizePathConstraint('*.ts')).toBe('*.ts');
    expect(normalizePathConstraint('src/**/*.ts')).toBe('src/**/*.ts');
  });

  it('returns null for external absolute paths', () => {
    expect(normalizePathConstraint('/outside/repo')).toBeNull();
  });

  it('normalizes absolute path inside cwd', () => {
    const cwd = '/home/user/project';
    expect(normalizePathConstraint('/home/user/project/src', cwd)).toBe('src/');
  });
});

describe('normalizeExcludes', () => {
  it('returns empty array for null/undefined', () => {
    expect(normalizeExcludes(null)).toEqual([]);
    expect(normalizeExcludes(undefined)).toEqual([]);
  });

  it('normalizes comma-separated excludes', () => {
    const result = normalizeExcludes('test/,*.min.js');
    expect(result).toContain('!test/');
    expect(result).toContain('!*.min.js');
  });

  it('preserves negation prefix from input', () => {
    const result = normalizeExcludes('!dist/');
    expect(result).toContain('!dist/');
  });
});

describe('buildQuery', () => {
  it('builds simple pattern query', () => {
    expect(buildQuery(null, 'main.ts', null)).toBe('main.ts');
  });

  it('builds query with path constraint', () => {
    const q = buildQuery('src', 'main.ts', null);
    expect(q).toContain('src/');
    expect(q).toContain('main.ts');
  });

  it('builds query with excludes', () => {
    const q = buildQuery(null, 'TODO', 'test/');
    expect(q).toContain('!test/');
    expect(q).toContain('TODO');
  });

  it('allows external absolute paths with allowExternal=true', () => {
    const q = buildQuery('/tmp/other', 'file.txt', null, '/home/proj', true);
    expect(q).toContain('/tmp/other');
  });
});

// ── format.ts ──

describe('formatGrepOutput', () => {
  it('returns no matches message for empty result', () => {
    expect(formatGrepOutput({ items: [] })).toBe('No matches found');
  });

  it('formats grep matches grouped by file', () => {
    const result = {
      items: [
        {
          relativePath: 'src/index.ts',
          fileName: 'index.ts',
          gitStatus: 'clean',
          size: 100,
          modified: 1000,
          isBinary: false,
          totalFrecencyScore: 0,
          accessFrecencyScore: 0,
          modificationFrecencyScore: 0,
          lineNumber: 10,
          col: 0,
          byteOffset: 0,
          lineContent: '  const x = 1;',
          matchRanges: [[8, 9] as [number, number]],
          contextBefore: [],
          contextAfter: ['const y = 2;'],
        },
        {
          relativePath: 'src/index.ts',
          fileName: 'index.ts',
          gitStatus: 'clean',
          size: 100,
          modified: 1000,
          isBinary: false,
          totalFrecencyScore: 0,
          accessFrecencyScore: 0,
          modificationFrecencyScore: 0,
          lineNumber: 12,
          col: 0,
          byteOffset: 0,
          lineContent: 'useEffect(() => {});',
          matchRanges: [[0, 9] as [number, number]],
          contextBefore: [],
          contextAfter: [],
        },
      ],
    };

    const output = formatGrepOutput(result);
    expect(output).toContain('src/index.ts');
    expect(output).toContain('10:');
    expect(output).toContain('const x = 1;');
    expect(output).toContain('11-');
    expect(output).toContain('const y = 2;');
  });
});

describe('formatFindOutput', () => {
  it('returns no files message for empty result', () => {
    const result = formatFindOutput({ items: [], scores: [] }, 10, 'test');
    expect(result.output).toBe('No files found matching pattern');
    expect(result.weak).toBe(false);
  });

  it('formats file paths', () => {
    const result = formatFindOutput(
      {
        items: [
          {
            relativePath: 'src/main.ts',
            fileName: 'main.ts',
            size: 500,
            modified: 1000,
            accessFrecencyScore: 0,
            modificationFrecencyScore: 0,
            totalFrecencyScore: 10,
            gitStatus: 'clean',
          },
        ],
        scores: [
          {
            total: 100,
            baseScore: 80,
            filenameBonus: 10,
            specialFilenameBonus: 0,
            frecencyBoost: 10,
            distancePenalty: 0,
            currentFilePenalty: 0,
            comboMatchBoost: 0,
            exactMatch: false,
            matchType: 'fuzzy',
          },
        ],
      },
      10,
      'main',
    );
    expect(result.output).toContain('src/main.ts');
    expect(result.weak).toBe(false);
  });

  it('detects weak matches with low score', () => {
    const result = formatFindOutput(
      {
        items: [
          {
            relativePath: 'src/unrelated.ts',
            fileName: 'unrelated.ts',
            size: 200,
            modified: 1000,
            accessFrecencyScore: 0,
            modificationFrecencyScore: 0,
            totalFrecencyScore: 0,
            gitStatus: 'clean',
          },
        ],
        scores: [
          {
            total: 5,
            baseScore: 5,
            filenameBonus: 0,
            specialFilenameBonus: 0,
            frecencyBoost: 0,
            distancePenalty: 0,
            currentFilePenalty: 0,
            comboMatchBoost: 0,
            exactMatch: false,
            matchType: 'fuzzy',
          },
        ],
      },
      10,
      'veryLongQueryPattern',
    );
    expect(result.weak).toBe(true);
    // Weak matches are capped at FIND_WEAK_SAMPLE_SIZE
    expect(result.shownCount).toBeLessThanOrEqual(5);
  });
});

describe('grep cursor store', () => {
  it('stores and retrieves cursors', () => {
    const cursor = { __brand: 'GrepCursor' as const, _offset: 42 };
    const id = storeGrepCursor(cursor);
    expect(id).toMatch(/^fff_c\d+$/);
    expect(getGrepCursor(id)?._offset).toBe(42);
  });

  it('returns undefined for unknown cursor id', () => {
    expect(getGrepCursor('nonexistent')).toBeUndefined();
  });
});

describe('find cursor store', () => {
  it('stores and retrieves find cursor data', () => {
    const data = {
      query: 'src/main',
      pattern: 'main',
      pageSize: 20,
      nextPageIndex: 1,
    };
    const id = storeFindCursor(data);
    expect(id).toBeDefined();
    const retrieved = getFindCursor(id);
    expect(retrieved?.query).toBe('src/main');
    expect(retrieved?.nextPageIndex).toBe(1);
  });

  it('returns undefined for unknown find cursor id', () => {
    expect(getFindCursor('99999')).toBeUndefined();
  });
});
