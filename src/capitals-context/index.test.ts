import { beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildCapitalsContext,
  createCapitalsContextHook,
  findCapsFiles,
} from './index';

let testDir: string;

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(tmpdir(), 'caps-test-'));
});

function write(relPath: string, content: string): string {
  const full = path.join(testDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
  return full;
}

describe('findCapsFiles', () => {
  it('returns empty array for empty project root', () => {
    expect(findCapsFiles(testDir)).toEqual([]);
  });

  it('returns empty array for non-existent directory', () => {
    expect(findCapsFiles('/nonexistent/path')).toEqual([]);
  });

  it('discovers ALL_CAPS.md files at root', () => {
    write('STATUS.md', 'active');
    write('CONFIG.md', 'debug: true');
    write('README.md', 'should be excluded');

    const result = findCapsFiles(testDir);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.label).sort()).toEqual([
      'CONFIG.md',
      'STATUS.md',
    ]);
  });

  it('excludes AGENTS.md, CLAUDE.md, and README.md', () => {
    write('AGENTS.md', 'agent instructions');
    write('CLAUDE.md', 'claude config');
    write('README.md', 'readme content');
    write('BUILD.md', 'build instructions');

    const result = findCapsFiles(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('BUILD.md');
  });

  it('skips files that do not match ALL_CAPS regex', () => {
    write('Status.md', 'mixed case');
    write('status.md', 'lowercase');
    write('my-build.md', 'kebab case');
    write('TODO.md', 'valid caps');

    const result = findCapsFiles(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('TODO.md');
  });

  it('skips empty/whitespace-only files', () => {
    write('STATUS.md', '   ');
    write('TODO.md', '  \n  ');
    write('BUILD.md', 'valid content');

    const result = findCapsFiles(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('BUILD.md');
  });

  it('discovers ALL files inside ALL_CAPS directories recursively', () => {
    write('ARCHITECTURE/design.md', '# Design doc');
    write('ARCHITECTURE/db/schema.md', '# Schema');
    write('ARCHITECTURE/notes.txt', 'not md but included');
    write('ARCHITECTURE/styles/main.css', 'body { margin: 0 }');
    write('TOOLS/hammer.md', '# Hammer tool');

    const result = findCapsFiles(testDir);
    expect(result).toHaveLength(5);
    const labels = result.map((f) => f.label).sort();
    expect(labels).toEqual([
      'ARCHITECTURE/db/schema.md',
      'ARCHITECTURE/design.md',
      'ARCHITECTURE/notes.txt',
      'ARCHITECTURE/styles/main.css',
      'TOOLS/hammer.md',
    ]);
  });

  it('excludes AGENTS, CLAUDE, NODE_MODULES directories', () => {
    write('AGENTS/rules.md', 'should be excluded');
    write('CLAUDE/setup.md', 'should be excluded');
    write('NODE_MODULES/pkg/readme.md', 'should be excluded');
    write('BUILD/guide.md', 'valid');

    const result = findCapsFiles(testDir);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('BUILD/guide.md');
  });

  it('handles both root files and directory files together', () => {
    write('STATUS.md', 'active');
    write('ARCHITECTURE/overview.md', '# Overview');
    write('TODO.md', 'items');

    const result = findCapsFiles(testDir);
    expect(result).toHaveLength(3);
  });
});

describe('buildCapitalsContext', () => {
  it('returns empty string when no caps files exist', () => {
    expect(buildCapitalsContext(testDir)).toBe('');
  });

  it('wraps each file in <caps-context> tags', () => {
    write('STATUS.md', 'active');
    write('BUILD.md', 'passing');

    const result = buildCapitalsContext(testDir);
    expect(result).toContain('<caps-context file="STATUS.md">');
    expect(result).toContain('<caps-context file="BUILD.md">');
    expect(result).toContain('active');
    expect(result).toContain('passing');
  });

  it('separates multiple files with blank lines', () => {
    write('A.md', 'first');
    write('B.md', 'second');

    const result = buildCapitalsContext(testDir);
    const parts = result.split('\n\n');
    expect(parts.length).toBeGreaterThanOrEqual(2);
  });

  it('uses relative path label for nested files', () => {
    write('ARCHITECTURE/design.md', '# Design');

    const result = buildCapitalsContext(testDir);
    expect(result).toContain('file="ARCHITECTURE/design.md"');
  });
});

describe('createCapitalsContextHook', () => {
  it('injects context into system prompt', () => {
    write('STATUS.md', 'project is active');

    const hook = createCapitalsContextHook(testDir);
    const output = { system: ['existing prompt'] };
    hook.handleSystemTransform({ sessionID: 'ses_1' }, output);

    expect(output.system).toHaveLength(2);
    expect(output.system[1]).toContain('<caps-context file="STATUS.md">');
    expect(output.system[1]).toContain('project is active');
  });

  it('does not inject when no caps files exist', () => {
    const hook = createCapitalsContextHook(testDir);
    const output = { system: ['existing prompt'] };
    hook.handleSystemTransform({ sessionID: 'ses_1' }, output);

    expect(output.system).toHaveLength(1);
  });

  it('does not duplicate injection on repeated calls', () => {
    write('CONFIG.md', 'debug: true');

    const hook = createCapitalsContextHook(testDir);
    const output = { system: ['existing prompt'] };
    hook.handleSystemTransform({ sessionID: 'ses_1' }, output);
    hook.handleSystemTransform({ sessionID: 'ses_1' }, output);

    expect(output.system).toHaveLength(2);
  });

  it('does not inject when system already contains caps-context marker', () => {
    write('STATUS.md', 'active');

    const hook = createCapitalsContextHook(testDir);
    const output = {
      system: ['<caps-context file="STATUS.md">old</caps-context>'],
    };
    hook.handleSystemTransform({ sessionID: 'ses_1' }, output);

    expect(output.system).toHaveLength(1);
  });
});
