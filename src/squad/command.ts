import type { PluginInput } from '@opencode-ai/plugin';
import { createInternalAgentTextPart } from '../utils/internal-initiator';
import { runSquad } from './orchestrator';
import {
  renderCancelledResult,
  renderFailedResult,
  renderSquadResult,
} from './report-renderer';
import { getResumeState } from './resume';
import type { SquadReport } from './schemas';
import { squadSessions } from './squad-context';
import { listCheckpoints } from './state';

const COMMAND_NAME = 'squad';

export function createSquadCommandManager(ctx: PluginInput) {
  /**
   * Register the /squad command in the OpenCode config.
   *
   * The template is intentionally minimal — the command.execute.before hook
   * intercepts and bypasses it, so the LLM never sees this template.
   * The template exists only so OpenCode recognizes /squad as a valid command.
   */
  function registerCommand(opencodeConfig: Record<string, unknown>): void {
    const configCommand = opencodeConfig.command as
      | Record<string, unknown>
      | undefined;
    if (!configCommand?.[COMMAND_NAME]) {
      if (!opencodeConfig.command) {
        opencodeConfig.command = {};
      }
      (opencodeConfig.command as Record<string, unknown>)[COMMAND_NAME] = {
        template: 'Direct squad execution (hook-intercepted).',
        description:
          'Execute a self-orchestrated S/M/L squad workflow for complex multi-step tasks',
      };
    }
  }

  /**
   * Handle /squad command from command.execute.before hook.
   *
   * Intercepts /squad before the template reaches the LLM, runs
   * runSquad() directly with the user's arguments as the intent,
   * and injects the result as an internal agent text part.
   * This eliminates the LLM round-trip for intent interpretation.
   */
  async function handleCommandExecuteBefore(
    input: {
      command: string;
      sessionID: string;
      arguments: string;
    },
    output: { parts: Array<{ type: string; text?: string }> },
  ): Promise<void> {
    if (input.command !== COMMAND_NAME) {
      return;
    }

    // Clear the template so OpenCode doesn't send it to the LLM
    output.parts.length = 0;

    const args = input.arguments.trim();
    if (!args) {
      const checkpoints = listCheckpoints(ctx.directory);
      if (checkpoints.length === 0) {
        output.parts.push(
          createInternalAgentTextPart(
            'Please provide a task description after /squad.\nExample: /squad Refactor the auth module to use JWT',
          ),
        );
        return;
      }

      let text = 'Available squad checkpoints:\n';
      checkpoints.forEach((c, i) => {
        const stepInfo =
          c.totalNodes > 0
            ? `, ${c.completedNodes}/${c.totalNodes} nodes done`
            : '';
        text += `${i + 1}. ${c.timestamp} — ${c.intent} (${c.size || 'unknown'}, ${c.status}${stepInfo})\n   ➜ /squad resume ${c.timestamp}\n`;
      });
      output.parts.push(createInternalAgentTextPart(text));
      return;
    }

    let intent = args;
    let resumeState: ReturnType<typeof getResumeState> | undefined;

    if (args.startsWith('resume ')) {
      const timestamp = args.slice(7).trim();
      const loadedState = getResumeState(ctx.directory, timestamp);
      if (!loadedState) {
        output.parts.push(
          createInternalAgentTextPart(
            `Error: Squad checkpoint not found or already completed/cancelled: "${timestamp}"`,
          ),
        );
        return;
      }
      resumeState = loadedState;
      intent = resumeState.meta.intent;
    }

    const parentSessionId = input.sessionID;
    const directory = ctx.directory;

    const structuredStore = new Map<string, SquadReport>();
    const createdChildIds = new Set<string>();

    try {
      const result = await runSquad({
        client: ctx.client,
        directory,
        parentSessionId,
        structuredStore,
        createdChildIds,
        intent,
        resumeState,
      });

      if (result.status === 'cancelled') {
        output.parts.push(
          createInternalAgentTextPart(
            renderCancelledResult(result.reportMarkdown),
          ),
        );
        return;
      }

      output.parts.push(createInternalAgentTextPart(renderSquadResult(result)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output.parts.push(
        createInternalAgentTextPart(renderFailedResult(message)),
      );
    } finally {
      // Defensive cleanup: runSquad's cleanupAll() already clears
      // createdChildIds and aborts sessions in its own finally block.
      // This loop is a no-op on the happy path but ensures cleanup
      // if runSquad throws before cleanupAll runs.
      for (const childId of createdChildIds) {
        squadSessions.delete(childId);
        structuredStore.delete(childId);
      }
    }
  }

  return { registerCommand, handleCommandExecuteBefore };
}

export type SquadCommandManager = ReturnType<typeof createSquadCommandManager>;
