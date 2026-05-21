import { describe, expect, spyOn, test } from 'bun:test';
import { type NodeLoopParams, runNodeLoop } from './dag-scheduler';
import * as nodeExecutor from './node-executor';
import type { SquadRuntime } from './runtime';

describe('runNodeLoop DAG Scheduler', () => {
  const createMockRuntime = (isAbortedFn?: () => boolean): SquadRuntime => {
    const executionOrder: string[] = [];
    return {
      workspaceId: 'test-ws',
      cwd: '/tmp/test-ws',
      isAborted: isAbortedFn ?? (() => false),
      createChild: async () => 'child-id',
      awaitReport: async () => ({}) as any,
      executeFresh: async () => ({}) as any,
      gateAccept: () => {},
      gateReject: () => {},
      cleanupChild: async () => {},
      cleanupAll: async () => {},
      withReviewLoop: async (
        stage,
        _agentId,
        _prompt,
        _buildReviewPrompt,
        nodeName,
      ) => {
        if (nodeName) {
          executionOrder.push(`${nodeName}-${stage}`);
        }
        if (stage === 'node_plan') {
          return { planMarkdown: 'mocked plan' } as any;
        } else {
          return {
            reportMarkdown: 'mocked report',
            affectedFiles: [] as string[],
          } as any;
        }
      },
    };
  };

  test('runs simple independent nodes', async () => {
    const params: NodeLoopParams = {
      nodes: [{ name: 'A' }, { name: 'B' }],
      edges: [],
      planMarkdown: 'test plan',
    };

    const runtime = createMockRuntime();
    const result = await runNodeLoop(params, runtime);

    expect(result.length).toBe(2);
    expect(result.find((r) => r.name === 'A')).toBeDefined();
    expect(result.find((r) => r.name === 'B')).toBeDefined();
  });

  test('respects dependencies (A -> B)', async () => {
    const params: NodeLoopParams = {
      nodes: [{ name: 'A' }, { name: 'B' }],
      edges: [{ child: 'B', parent: 'A' }],
      planMarkdown: 'test plan',
    };

    // We can spy on executeSingleNode to record execution ordering and timestamps
    const order: string[] = [];
    const spy = spyOn(nodeExecutor, 'executeSingleNode').mockImplementation(
      async (nodeParams, _runtime) => {
        order.push(nodeParams.nodeName);
        return {
          kind: 'node_exec' as const,
          childTaskId: 'mock-task-id',
          reportMarkdown: `done ${nodeParams.nodeName}`,
          affectedFiles: [] as string[],
        };
      },
    );

    try {
      const runtime = createMockRuntime();
      const result = await runNodeLoop(params, runtime);

      expect(order).toEqual(['A', 'B']);
      expect(result.length).toBe(2);
      expect(result.find((r) => r.name === 'B')?.reportMarkdown).toBe('done B');
    } finally {
      spy.mockRestore();
    }
  });

  test('detects cyclic DAG at initiation', async () => {
    const params: NodeLoopParams = {
      nodes: [{ name: 'A' }, { name: 'B' }],
      edges: [
        { child: 'B', parent: 'A' },
        { child: 'A', parent: 'B' },
      ],
      planMarkdown: 'test plan',
    };

    const runtime = createMockRuntime();
    await expect(runNodeLoop(params, runtime)).rejects.toThrow(
      'Invalid DAG: Cycle detected or no entry nodes available.',
    );
  });

  test('propagates node errors and aborts execution', async () => {
    const params: NodeLoopParams = {
      nodes: [{ name: 'A' }, { name: 'B' }],
      edges: [{ child: 'B', parent: 'A' }],
      planMarkdown: 'test plan',
    };

    const spy = spyOn(nodeExecutor, 'executeSingleNode').mockImplementation(
      async (nodeParams, _runtime) => {
        if (nodeParams.nodeName === 'A') {
          throw new Error('Node A crashed');
        }
        return {
          kind: 'node_exec' as const,
          childTaskId: 'mock-task-id',
          reportMarkdown: 'done',
          affectedFiles: [] as string[],
        };
      },
    );

    try {
      const runtime = createMockRuntime();
      await expect(runNodeLoop(params, runtime)).rejects.toThrow(
        'Node A crashed',
      );
    } finally {
      spy.mockRestore();
    }
  });

  test('respects isAborted before execution starts', async () => {
    const params: NodeLoopParams = {
      nodes: [{ name: 'A' }],
      edges: [],
      planMarkdown: 'test plan',
    };

    const runtime = createMockRuntime(() => true);

    await expect(runNodeLoop(params, runtime)).rejects.toThrow('Squad aborted');
  });
});
