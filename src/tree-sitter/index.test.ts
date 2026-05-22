import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';

import * as checkerModule from './checker';
import { createSyntaxCheckHook } from './index';

function mockCheckSyntax(errors: checkerModule.SyntaxError[]) {
  spyOn(checkerModule, 'checkSyntax').mockResolvedValue({
    ok: true,
    lang: 'typescript',
    errors,
  });
}

function mockCheckSyntaxFail() {
  spyOn(checkerModule, 'checkSyntax').mockResolvedValue({
    ok: false,
    reason: 'unsupported language',
  });
}

function createMockCtx(directory: string): PluginInput {
  return {
    directory,
    worktree: directory,
    client: {} as PluginInput['client'],
    project: {} as PluginInput['project'],
    serverUrl: new URL('http://localhost:3000'),
    $: {} as PluginInput['$'],
  };
}

function createOutput(output: string) {
  return { title: 'edit', output, metadata: {} };
}

describe('createSyntaxCheckHook', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'syntax-check-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends syntax errors to edit tool output', async () => {
    writeFileSync(join(tmpDir, 'test.ts'), 'const x = 1\n');
    mockCheckSyntax([
      {
        line: 5,
        column: 1,
        endLine: 5,
        endColumn: 2,
        severity: 'error',
        message: "Expected ')'",
      },
    ]);

    const hook = createSyntaxCheckHook(createMockCtx(tmpDir));
    const output = createOutput('edited successfully');

    await hook['tool.execute.after'](
      { tool: 'edit', sessionID: 's1', args: { path: 'test.ts' } },
      output,
    );

    expect(output.output).toContain('1 syntax issue(s) in test.ts');
    expect(output.output).toContain("L5:1-5:2 [error] Expected ')'");
    expect(output.output).toContain('[syntax-check]');
  });

  it('appends syntax errors to Write tool output', async () => {
    writeFileSync(join(tmpDir, 'test.ts'), 'const x = 1\n');
    mockCheckSyntax([
      {
        line: 1,
        column: 5,
        endLine: 1,
        endColumn: 6,
        severity: 'error',
        message: 'Missing semicolon',
      },
    ]);

    const hook = createSyntaxCheckHook(createMockCtx(tmpDir));
    const output = createOutput('file written');

    await hook['tool.execute.after'](
      { tool: 'Write', sessionID: 's1', args: { path: 'test.ts' } },
      output,
    );

    expect(output.output).toContain('Missing semicolon');
  });

  it('skips when there are no syntax errors', async () => {
    writeFileSync(join(tmpDir, 'test.ts'), 'const x = 1\n');
    mockCheckSyntax([]);

    const hook = createSyntaxCheckHook(createMockCtx(tmpDir));
    const output = createOutput('edited successfully');

    await hook['tool.execute.after'](
      { tool: 'edit', sessionID: 's1', args: { path: 'test.ts' } },
      output,
    );

    expect(output.output).toBe('edited successfully');
  });

  it('skips when checkSyntax returns ok: false', async () => {
    writeFileSync(join(tmpDir, 'binary.bin'), '\x00\x01\x02');
    mockCheckSyntaxFail();

    const hook = createSyntaxCheckHook(createMockCtx(tmpDir));
    const output = createOutput('edited successfully');

    await hook['tool.execute.after'](
      { tool: 'edit', sessionID: 's1', args: { path: 'binary.bin' } },
      output,
    );

    expect(output.output).toBe('edited successfully');
  });

  it('ignores non-file-edit tools', async () => {
    const hook = createSyntaxCheckHook(createMockCtx(tmpDir));
    const output = createOutput('ok');

    await hook['tool.execute.after'](
      { tool: 'bash', sessionID: 's1', args: {} },
      output,
    );

    expect(output.output).toBe('ok');
  });

  it('ignores non-string output', async () => {
    const hook = createSyntaxCheckHook(createMockCtx(tmpDir));
    const output = { title: 'edit', output: { success: true }, metadata: {} };

    await hook['tool.execute.after'](
      { tool: 'edit', sessionID: 's1', args: { path: 'test.ts' } },
      output as any,
    );

    expect(output.output).toEqual({ success: true });
  });

  it('skips when args has no file path', async () => {
    const hook = createSyntaxCheckHook(createMockCtx(tmpDir));
    const output = createOutput('edited');

    await hook['tool.execute.after'](
      { tool: 'edit', sessionID: 's1', args: {} },
      output,
    );

    expect(output.output).toBe('edited');
  });

  it('skips when file is unreadable', async () => {
    const hook = createSyntaxCheckHook(createMockCtx(tmpDir));
    const output = createOutput('edited');

    await hook['tool.execute.after'](
      { tool: 'edit', sessionID: 's1', args: { path: 'nonexistent.ts' } },
      output,
    );

    expect(output.output).toBe('edited');
  });

  it('does not duplicate syntax check if marker already present', async () => {
    writeFileSync(join(tmpDir, 'test.ts'), 'const x = 1\n');
    mockCheckSyntax([
      {
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 2,
        severity: 'error',
        message: 'test error',
      },
    ]);

    const hook = createSyntaxCheckHook(createMockCtx(tmpDir));
    const output = createOutput('edited\n[syntax-check]\nalready here');

    await hook['tool.execute.after'](
      { tool: 'edit', sessionID: 's1', args: { path: 'test.ts' } },
      output,
    );

    // Should not append again
    expect(output.output).toBe('edited\n[syntax-check]\nalready here');
  });

  it('recognizes filePath and file_path variants', async () => {
    writeFileSync(join(tmpDir, 'test.ts'), 'const x = 1\n');
    mockCheckSyntax([
      {
        line: 1,
        column: 1,
        endLine: 1,
        endColumn: 2,
        severity: 'error',
        message: 'test error',
      },
    ]);

    const hook = createSyntaxCheckHook(createMockCtx(tmpDir));

    // filePath variant
    const out1 = createOutput('written');
    await hook['tool.execute.after'](
      { tool: 'Write', sessionID: 's1', args: { filePath: 'test.ts' } },
      out1,
    );
    expect(out1.output).toContain('syntax issue(s)');

    // file_path variant
    const out2 = createOutput('written');
    await hook['tool.execute.after'](
      { tool: 'Write', sessionID: 's1', args: { file_path: 'test.ts' } },
      out2,
    );
    expect(out2.output).toContain('syntax issue(s)');
  });
});
