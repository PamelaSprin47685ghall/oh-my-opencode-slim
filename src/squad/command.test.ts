import { afterEach, describe, expect, mock, test } from 'bun:test';
import { SLIM_INTERNAL_INITIATOR_MARKER } from '../utils/internal-initiator';
import { createSquadCommandManager } from './command';
import { squadSessions } from './squad-context';

function createMockContext() {
  return {
    directory: '/tmp/test-project',
    client: {
      session: {
        create: mock(() => ({ data: { id: 'child-1' } })),
        abort: mock(() => {}),
      },
    },
  } as any;
}

function createOutput() {
  return { parts: [] as Array<{ type: string; text?: string }> };
}

describe('createSquadCommandManager', () => {
  describe('registerCommand', () => {
    test('registers the /squad command', () => {
      const manager = createSquadCommandManager(createMockContext());
      const config: Record<string, unknown> = {};

      manager.registerCommand(config);

      const commands = config.command as Record<
        string,
        { template: string; description: string }
      >;
      expect(commands.squad).toBeDefined();
      expect(commands.squad.description).toContain('squad');
    });

    test('does not overwrite existing squad command', () => {
      const manager = createSquadCommandManager(createMockContext());
      const existing = { template: 'custom', description: 'custom' };
      const config: Record<string, unknown> = {
        command: { squad: existing },
      };

      manager.registerCommand(config);

      expect((config.command as Record<string, unknown>).squad).toBe(existing);
    });
  });

  describe('handleCommandExecuteBefore', () => {
    afterEach(() => {
      squadSessions.clear();
    });

    test('ignores non-squad commands', async () => {
      const manager = createSquadCommandManager(createMockContext());
      const output = createOutput();
      output.parts.push({ type: 'text', text: 'original' });

      await manager.handleCommandExecuteBefore(
        { command: 'other', sessionID: 'ses-1', arguments: 'test' },
        output,
      );

      // Original parts should remain untouched
      expect(output.parts).toHaveLength(1);
      expect(output.parts[0].text).toBe('original');
    });

    test('returns usage hint when no arguments provided', async () => {
      const manager = createSquadCommandManager(createMockContext());
      const output = createOutput();
      output.parts.push({ type: 'text', text: 'template content' });

      await manager.handleCommandExecuteBefore(
        { command: 'squad', sessionID: 'ses-1', arguments: '  ' },
        output,
      );

      // Template should be cleared
      expect(output.parts).toHaveLength(1);
      expect(output.parts[0].text).toContain(
        'Please provide a task description',
      );
      expect(output.parts[0].text).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
    });

    test('clears template and runs squad with user intent', async () => {
      const abortMock = mock(() => {});
      const ctx = createMockContext();
      ctx.client.session.abort = abortMock;
      const manager = createSquadCommandManager(ctx);
      const output = createOutput();
      output.parts.push({ type: 'text', text: 'Call the squad tool...' });

      // runSquad will fail because the mock client doesn't properly implement
      // the full session API, but the key thing is that the template gets
      // cleared and the error is captured gracefully
      await manager.handleCommandExecuteBefore(
        {
          command: 'squad',
          sessionID: 'ses-1',
          arguments: 'Refactor auth module',
        },
        output,
      );

      // Template should be cleared
      expect(output.parts.length).toBeGreaterThanOrEqual(1);
      // Result should contain the internal initiator marker
      const textPart = output.parts.find((p) => p.text);
      expect(textPart?.text).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
    });

    test('produces output with marker on error path', async () => {
      const abortMock = mock(() => {});
      const ctx = createMockContext();
      ctx.client.session.abort = abortMock;
      const manager = createSquadCommandManager(ctx);
      const output = createOutput();

      await manager.handleCommandExecuteBefore(
        {
          command: 'squad',
          sessionID: 'ses-1',
          arguments: 'Test task',
        },
        output,
      );

      // Error path should still produce output
      const textPart = output.parts.find((p) => p.text);
      expect(textPart?.text).toContain(SLIM_INTERNAL_INITIATOR_MARKER);
    });
  });
});
