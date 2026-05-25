import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getResumeState } from './resume';
import {
  listCheckpoints,
  saveDag,
  saveMeta,
  saveNodes,
  savePlan,
} from './state';

const TEMP_DIR = path.join(__dirname, 'temp-squad-test');

describe('Squad Persistence', () => {
  beforeEach(() => {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  });

  it('should save and load meta, plan, dag, nodes and list checkpoints correctly', () => {
    const timestamp = '20260525T143052';
    const realTimestamp = '2026-05-25T14:30:52.000Z';

    saveMeta(TEMP_DIR, realTimestamp, {
      timestamp: realTimestamp,
      intent: 'Refactor auth module',
      directory: TEMP_DIR,
      status: 'running',
    });

    savePlan(TEMP_DIR, realTimestamp, {
      attempts: [
        {
          index: 0,
          size: 'L',
          planMarkdown: 'My Plan',
          reviewFeedback: null,
          gateAccepted: true,
        },
      ],
    });

    saveDag(TEMP_DIR, realTimestamp, {
      nodes: { names: ['parser', 'lexer'] },
      edges: [{ parent: 'parser', child: 'lexer' }],
    });

    saveNodes(TEMP_DIR, realTimestamp, {
      nodes: [
        {
          name: 'parser',
          status: 'completed',
          reportMarkdown: 'Parser done',
          affectedFiles: ['src/parser.ts'],
        },
        {
          name: 'lexer',
          status: 'pending',
          reportMarkdown: '',
          affectedFiles: [],
        },
      ],
    });

    const resumeState = getResumeState(TEMP_DIR, timestamp);
    expect(resumeState).not.toBeNull();
    expect(resumeState?.stage).toBe('dag_execution');
    expect(resumeState?.meta.intent).toBe('Refactor auth module');
    expect(resumeState?.plan?.attempts[0].planMarkdown).toBe('My Plan');
    expect(resumeState?.dag?.nodes.names).toEqual(['parser', 'lexer']);
    expect(resumeState?.nodes?.nodes[0].status).toBe('completed');

    const checkpoints = listCheckpoints(TEMP_DIR);
    expect(checkpoints.length).toBe(1);
    expect(checkpoints[0].timestamp).toBe(timestamp);
    expect(checkpoints[0].intent).toBe('Refactor auth module');
    expect(checkpoints[0].completedNodes).toBe(1);
    expect(checkpoints[0].totalNodes).toBe(2);
  });
});
