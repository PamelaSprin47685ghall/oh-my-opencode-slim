import type { PluginInput } from '@opencode-ai/plugin';
import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import { runSquad } from './orchestrator';
import {
  getTitle,
  renderCancelledResult,
  renderFailedResult,
  renderSquadResult,
} from './report-renderer';
import type { SquadReport } from './schemas';
import { squadSessions } from './squad-context';

/**
 * Find the last report from the structured store to use for metadata.
 * Returns undefined if no reports were collected.
 */
function lastReportFromStore(
  store: Map<string, SquadReport>,
): SquadReport | undefined {
  let last: SquadReport | undefined;
  for (const report of store.values()) {
    last = report;
  }
  return last;
}

/**
 * Create the main squad tool.
 *
 * The orchestrator calls `squad({ intent })` to start a S/M/L workflow.
 * The tool creates child sessions, runs the orchestration loop, and returns
 * a summary of the result.
 */
export function createSquadTool(ctx: PluginInput): ToolDefinition {
  return tool({
    description:
      'Execute a self-orchestrated S/M/L squad workflow for complex multi-step tasks. Automatically determines task size and runs planning, review, and execution loops.',
    args: {
      intent: tool.schema
        .string()
        .min(1)
        .describe('The task description or user intent to execute'),
    },
    async execute(
      args: { intent: string },
      context: {
        sessionID: string;
        directory: string;
        abort: AbortSignal;
        metadata?: (input: {
          title?: string;
          metadata?: { [key: string]: unknown };
        }) => void;
      },
    ) {
      const parentSessionId = context.sessionID;
      const directory = context.directory;

      const structuredStore = new Map<string, SquadReport>();
      const createdChildIds = new Set<string>();

      try {
        const result = await runSquad({
          client: ctx.client,
          directory,
          parentSessionId,
          structuredStore,
          createdChildIds,
          abortSignal: context.abort,
          intent: args.intent,
        });

        // Set metadata for the tool result display
        const lastReport = lastReportFromStore(structuredStore);
        context.metadata?.({
          title: lastReport
            ? (getTitle(lastReport) ?? 'Squad Complete')
            : 'Squad Complete',
          metadata: {
            taskId: result.taskId,
            status: result.status,
            nodeCount: result.nodes?.length ?? 0,
          },
        });

        if (result.status === 'cancelled') {
          return renderCancelledResult(result.reportMarkdown);
        }

        return renderSquadResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        context.metadata?.({
          title: 'Squad Failed',
          metadata: { error: message },
        });
        return renderFailedResult(message);
      } finally {
        // Clean up all child sessions (H: kill children on main dialog termination)
        // NOTE: runtime.cleanupAll() already runs in orchestrator's finally block,
        // clearing createdChildIds and aborting sessions. This block is a redundant
        // safety net — if cleanupAll runs first, createdChildIds is already empty
        // and this loop is a no-op. If runSquad throws before cleanupAll, this
        // ensures cleanup still happens via the outer finally.
        for (const childId of createdChildIds) {
          squadSessions.delete(childId);
          structuredStore.delete(childId);
        }
      }
    },
  });
}
