import { describe, expect, it } from 'bun:test';
import { createHeadTailStrippingHook, stripHeadTailPipes } from './index';

describe('stripHeadTailPipes', () => {
  it('strips | head -n <N> (long form)', () => {
    const { script, stripped } = stripHeadTailPipes('cat file | head -n 50');
    expect(script).toBe('cat file');
    expect(stripped).toEqual([
      { pipe: '| head -n 50', name: 'head', count: 50 },
    ]);
  });

  it('strips | head -n<N> (no space)', () => {
    const { script, stripped } = stripHeadTailPipes('ls -la | head -n10');
    expect(script).toBe('ls -la');
    expect(stripped).toEqual([
      { pipe: '| head -n10', name: 'head', count: 10 },
    ]);
  });

  it('strips | tail -n <N> (long form)', () => {
    const { script, stripped } = stripHeadTailPipes('dmesg | tail -n 20');
    expect(script).toBe('dmesg');
    expect(stripped).toEqual([
      { pipe: '| tail -n 20', name: 'tail', count: 20 },
    ]);
  });

  it('strips | tail -n<N> (no space)', () => {
    const { script, stripped } = stripHeadTailPipes('git log | tail -n5');
    expect(script).toBe('git log');
    expect(stripped).toEqual([{ pipe: '| tail -n5', name: 'tail', count: 5 }]);
  });

  it('strips | tail -<N> (short form)', () => {
    const { script, stripped } = stripHeadTailPipes('dmesg | tail -3');
    expect(script).toBe('dmesg');
    expect(stripped).toEqual([{ pipe: '| tail -3', name: 'tail', count: 3 }]);
  });

  it('strips | head -<N> (short form)', () => {
    const { script, stripped } = stripHeadTailPipes('cat file | head -5');
    expect(script).toBe('cat file');
    expect(stripped).toEqual([{ pipe: '| head -5', name: 'head', count: 5 }]);
  });

  it('strips large multi-digit N', () => {
    const { script, stripped } = stripHeadTailPipes(
      'journalctl -u nginx | tail -100',
    );
    expect(script).toBe('journalctl -u nginx');
    expect(stripped).toEqual([
      { pipe: '| tail -100', name: 'tail', count: 100 },
    ]);
  });

  it('strips both pipes in multi-pipe chain (head then tail)', () => {
    const { script, stripped } = stripHeadTailPipes(
      'cat big.log | head -n 100 | tail -n 10',
    );
    expect(script).toBe('cat big.log');
    expect(stripped).toEqual([
      { pipe: '| head -n 100', name: 'head', count: 100 },
      { pipe: '| tail -n 10', name: 'tail', count: 10 },
    ]);
  });

  it('strips head before tail in multi-pipe chain (tail then head)', () => {
    const { script, stripped } = stripHeadTailPipes(
      'cmd | tail -n 5 | head -n 1',
    );
    expect(script).toBe('cmd');
    expect(stripped).toEqual([
      { pipe: '| tail -n 5', name: 'tail', count: 5 },
      { pipe: '| head -n 1', name: 'head', count: 1 },
    ]);
  });

  it('preserves leading whitespace before the main command', () => {
    const { script } = stripHeadTailPipes('  grep foo bar | tail -n  5');
    expect(script).toBe('  grep foo bar');
  });

  it('handles multiple spaces around pipe and command', () => {
    const { script } = stripHeadTailPipes('ps aux  |    head -n 30');
    expect(script).toBe('ps aux');
  });

  it('handles multiple spaces between -n and number', () => {
    const { script } = stripHeadTailPipes(
      'journalctl -u nginx | tail -n   100',
    );
    expect(script).toBe('journalctl -u nginx');
  });

  it('passes through commands without pipes', () => {
    const { script, stripped } = stripHeadTailPipes('ls -la');
    expect(script).toBe('ls -la');
    expect(stripped).toEqual([]);
  });

  it('passes through | Head (uppercase H)', () => {
    const { script, stripped } = stripHeadTailPipes('cat file | Head -n 50');
    expect(script).toBe('cat file | Head -n 50');
    expect(stripped).toEqual([]);
  });

  it('passes through standalone head (no pipe)', () => {
    const { script, stripped } = stripHeadTailPipes('head -n 5 file.txt');
    expect(script).toBe('head -n 5 file.txt');
    expect(stripped).toEqual([]);
  });

  it('passes through standalone tail (no pipe)', () => {
    const { script, stripped } = stripHeadTailPipes('tail -n 20 file.txt');
    expect(script).toBe('tail -n 20 file.txt');
    expect(stripped).toEqual([]);
  });

  it('passes through grep -n (not a pipe truncation)', () => {
    const { script, stripped } = stripHeadTailPipes('grep -n pattern file');
    expect(script).toBe('grep -n pattern file');
    expect(stripped).toEqual([]);
  });

  it('passes through grep -n in a pipe (still not a truncation)', () => {
    const { script, stripped } = stripHeadTailPipes(
      'cat file | grep -n pattern',
    );
    expect(script).toBe('cat file | grep -n pattern');
    expect(stripped).toEqual([]);
  });

  it('passes through empty string', () => {
    const { script, stripped } = stripHeadTailPipes('');
    expect(script).toBe('');
    expect(stripped).toEqual([]);
  });

  it('passes through HEAD (all caps)', () => {
    const { script, stripped } = stripHeadTailPipes('cat file | HEAD -10');
    expect(script).toBe('cat file | HEAD -10');
    expect(stripped).toEqual([]);
  });

  it('strips tail from real-world docker logs command', () => {
    const cmd = 'docker logs myapp 2>&1 | tail -n 50';
    const { script, stripped } = stripHeadTailPipes(cmd);
    expect(script).toBe('docker logs myapp 2>&1');
    expect(stripped).toEqual([
      { pipe: '| tail -n 50', name: 'tail', count: 50 },
    ]);
  });

  it('strips head from real-world find command', () => {
    const cmd = "find / -name '*.log' | head -n 99999";
    const { script, stripped } = stripHeadTailPipes(cmd);
    expect(script).toBe("find / -name '*.log'");
    expect(stripped).toEqual([
      { pipe: '| head -n 99999', name: 'head', count: 99999 },
    ]);
  });

  it('strips tail from real-world git log command', () => {
    const cmd = 'git log --oneline | tail -n 200';
    const { script, stripped } = stripHeadTailPipes(cmd);
    expect(script).toBe('git log --oneline');
    expect(stripped).toEqual([
      { pipe: '| tail -n 200', name: 'tail', count: 200 },
    ]);
  });
});

describe('createHeadTailStrippingHook', () => {
  it('strips head/tail pipes from bash tool args', async () => {
    const hook = createHeadTailStrippingHook();
    const output = { args: { command: 'cat file | head -n 50' } };
    await hook['tool.execute.before']({ tool: 'bash' }, output);
    expect(output.args?.command).toBe('cat file');
  });

  it('ignores non-bash tools', async () => {
    const hook = createHeadTailStrippingHook();
    const output = { args: { command: 'cat file | head -n 50' } };
    await hook['tool.execute.before']({ tool: 'read' }, output);
    expect(output.args?.command).toBe('cat file | head -n 50');
  });

  it('ignores when args.command is missing', async () => {
    const hook = createHeadTailStrippingHook();
    const output: { args?: Record<string, unknown> } = {};
    await hook['tool.execute.before']({ tool: 'bash' }, output);
    expect(output.args?.command).toBeUndefined();
  });

  it('ignores when args is missing', async () => {
    const hook = createHeadTailStrippingHook();
    const output: Record<string, unknown> = {};
    await hook['tool.execute.before']({ tool: 'bash' }, output);
    expect(output.args).toBeUndefined();
  });

  it('does not modify clean bash commands', async () => {
    const hook = createHeadTailStrippingHook();
    const output = { args: { command: 'ls -la /tmp' } };
    await hook['tool.execute.before']({ tool: 'bash' }, output);
    expect(output.args?.command).toBe('ls -la /tmp');
  });
});
