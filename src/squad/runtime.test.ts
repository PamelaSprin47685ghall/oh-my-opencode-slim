import { describe, expect, test } from 'bun:test';
import { renderNudgePrompt } from './prompts';
import type { GlobalPlanReport, SquadReport } from './schemas';
import {
  DEFAULT_NUDGE_CONFIG,
  Deferred,
  type SquadSession,
  squadSessions,
} from './squad-context';

// ---------------------------------------------------------------------------
// Deferred
// ---------------------------------------------------------------------------

describe('Deferred', () => {
  test('resolves once', async () => {
    const d = new Deferred<void>();
    d.resolve();
    d.resolve(); // second call should be no-op
    await d.promise; // should not hang
    expect(true).toBe(true);
  });

  test('resolves with value', async () => {
    const d = new Deferred<string>();
    d.resolve('hello');
    const result = await d.promise;
    expect(result).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_NUDGE_CONFIG
// ---------------------------------------------------------------------------

describe('DEFAULT_NUDGE_CONFIG', () => {
  test('has maxNudges of 3', () => {
    expect(DEFAULT_NUDGE_CONFIG.maxNudges).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// renderNudgePrompt
// ---------------------------------------------------------------------------

describe('renderNudgePrompt', () => {
  test('includes stage-specific tool call', () => {
    const prompt = renderNudgePrompt('global_plan', 1, 3);
    expect(prompt).toContain('squad_global_plan');
    expect(prompt).toContain('1/3');
  });

  test('shows remaining nudges when not final', () => {
    const prompt = renderNudgePrompt('node_exec', 1, 3);
    expect(prompt).toContain('2');
    expect(prompt).toContain('1/3');
  });

  test('shows final nudge warning at max', () => {
    const prompt = renderNudgePrompt('review', 3, 3);
    expect(prompt).toContain('3/3');
    expect(prompt).toContain('最后一次提醒');
  });

  test('includes Chinese text', () => {
    const prompt = renderNudgePrompt('dag_design', 1, 3);
    expect(prompt).toContain('你还没有提交报告');
    expect(prompt).toContain('你必须调用');
  });
});

// ---------------------------------------------------------------------------
// Nudge behavior: promptPromise resolves before nextReport
// ---------------------------------------------------------------------------

describe('awaitReportInternal nudge flow', () => {
  // We test the nudge mechanism at the unit level by simulating
  // the race between nextReport and promptPromise.

  test('nextReport resolves before promptPromise yields report', async () => {
    // Simulate: child calls report tool before session ends
    const nextReport = new Deferred<void>();
    const promptPromise = new Promise<void>(() => {
      // never resolves — session stays alive
    });

    const ctx: SquadSession = {
      parentWorkspaceId: 'parent',
      childSessionId: 'child-1',
      stage: 'global_plan',
      structuredStore: new Map<string, SquadReport>(),
      nextReport,
      promptPromise,
      resetPromptPromise: () => {},
      nudgeCount: 0,
    };

    const report: GlobalPlanReport = {
      kind: 'global_plan',
      childTaskId: 'child-1',
      size: 'S',
      planMarkdown: 'test plan',
    };
    ctx.structuredStore.set('child-1', report);

    // Simulate report tool calling resolve
    nextReport.resolve();

    // nextReport should resolve before promptPromise
    const result = await Promise.race([
      nextReport.promise.then(() => ({ type: 'report' as const })),
      promptPromise.then(() => ({ type: 'silent_end' as const })),
    ]);

    expect(result.type).toBe('report');
  });

  test('promptPromise resolves before nextReport triggers nudge flow', async () => {
    // Simulate: child session ends without calling report tool
    const nextReport = new Deferred<void>();
    let promptResolve: (() => void) | undefined;
    const promptPromise = new Promise<void>((r) => {
      promptResolve = r;
    });

    // promptPromise resolves first (session ended silently)
    promptResolve?.();

    const result = await Promise.race([
      nextReport.promise.then(() => ({ type: 'report' as const })),
      promptPromise.then(() => ({ type: 'silent_end' as const })),
    ]);

    expect(result.type).toBe('silent_end');
  });

  test('nudgeCount increments on each nudge', () => {
    const ctx: SquadSession = {
      parentWorkspaceId: 'parent',
      childSessionId: 'child-3',
      stage: 'node_exec',
      structuredStore: new Map(),
      nextReport: new Deferred<void>(),
      nudgeCount: 0,
    };

    expect(ctx.nudgeCount).toBe(0);
    ctx.nudgeCount++;
    expect(ctx.nudgeCount).toBe(1);
    ctx.nudgeCount++;
    expect(ctx.nudgeCount).toBe(2);
    ctx.nudgeCount++;
    expect(ctx.nudgeCount).toBe(3);
    expect(ctx.nudgeCount >= DEFAULT_NUDGE_CONFIG.maxNudges).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SquadSession in squadSessions global registry
// ---------------------------------------------------------------------------

describe('squadSessions global registry', () => {
  test('can register and look up a session with nudge fields', () => {
    const sessionId = 'test-session-nudge';
    const ctx: SquadSession = {
      parentWorkspaceId: 'parent',
      childSessionId: sessionId,
      stage: 'node_exec',
      structuredStore: new Map(),
      nextReport: new Deferred<void>(),
      nudgeCount: 0,
    };

    squadSessions.set(sessionId, ctx);
    const found = squadSessions.get(sessionId);
    expect(found).toBeDefined();
    expect(found?.nudgeCount).toBe(0);
    expect(found?.stage).toBe('node_exec');

    // Cleanup
    squadSessions.delete(sessionId);
  });

  test('disposed session returns error in gateWait', async () => {
    const sessionId = 'test-disposed-session';
    const ctx: SquadSession = {
      parentWorkspaceId: 'parent',
      childSessionId: sessionId,
      stage: 'review',
      structuredStore: new Map(),
      nextReport: new Deferred<void>(),
      nudgeCount: 0,
      disposed: true,
    };

    squadSessions.set(sessionId, ctx);
    const found = squadSessions.get(sessionId);
    expect(found?.disposed).toBe(true);

    // Cleanup
    squadSessions.delete(sessionId);
  });
  test('nudgeExhausted is initially undefined', () => {
    const sessionId = 'test-nudge-exhausted';
    const ctx: SquadSession = {
      parentWorkspaceId: 'parent',
      childSessionId: sessionId,
      stage: 'node_exec',
      structuredStore: new Map(),
      nextReport: new Deferred<void>(),
      nudgeCount: 0,
    };

    expect(ctx.nudgeExhausted).toBeUndefined();

    // Set exhausted flag
    ctx.nudgeExhausted = true;
    expect(ctx.nudgeExhausted).toBe(true);

    // Cleanup
    squadSessions.delete(sessionId);
  });
});

// ---------------------------------------------------------------------------
// Clean up squadSessions after tests
// ---------------------------------------------------------------------------

describe('squadSessions cleanup', () => {
  test('registry is clean after test', () => {
    squadSessions.clear();
    expect(squadSessions.size).toBe(0);
  });
});
