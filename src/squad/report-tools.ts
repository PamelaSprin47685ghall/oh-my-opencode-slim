import { type ToolDefinition, tool } from '@opencode-ai/plugin';
import {
  type DagDesignReport,
  DagDesignSchema,
  type GlobalPlanReport,
  GlobalPlanSchema,
  type NodeExecReport,
  NodeExecSchema,
  type NodePlanReport,
  NodePlanSchema,
  type ReviewReport,
  ReviewSchema,
  type SquadReport,
} from './schemas';
import { type GateVerdict, squadSessions } from './squad-context';

/**
 * Create the 5 stage-specific report tools for squad.
 *
 * Each tool validates against its stage-specific Zod schema (strict!),
 * stores the validated report in the shared structuredStore, resolves
 * nextReport to notify the orchestrator, then hangs on the gate
 * awaiting the orchestrator's accept/reject verdict.
 *
 * On accept: returns { success: true } and the orchestrator continues.
 * On reject: returns { success: false, message } with feedback for the child.
 */
export function createSquadReportTools(): Record<string, ToolDefinition> {
  return {
    squad_global_plan: createGlobalPlanTool(),
    squad_review: createReviewTool(),
    squad_dag_design: createDagDesignTool(),
    squad_node_plan: createNodePlanTool(),
    squad_node_exec: createNodeExecTool(),
  };
}

/**
 * Common gate-wait logic shared by all report tools.
 *
 * 1. Look up SquadSession by sessionID.
 * 2. Store the validated report in structuredStore.
 * 3. Resolve nextReport (notifies orchestrator).
 * 4. Hang on gate Promise (await orchestrator verdict).
 * 5. On accept: return success string.
 * 6. On reject: return feedback string; child can retry.
 *
 * If the session is disposed or not a squad session, returns an error message
 * that the child model can understand and potentially retry from.
 */
async function gateWait(
  sessionId: string,
  report: SquadReport,
): Promise<string> {
  const ctx = squadSessions.get(sessionId);

  if (!ctx) {
    return 'Error: Not a squad session. This tool is only available inside squad orchestration.';
  }

  if (ctx.disposed) {
    return 'Error: Squad session is no longer available.';
  }

  // Store the validated report
  ctx.structuredStore.set(ctx.childSessionId, report);

  // Notify orchestrator that a report is ready
  ctx.nextReport.resolve();

  // Hang on gate — wait for orchestrator verdict
  const verdict = await new Promise<GateVerdict>((resolve) => {
    ctx.gate = { resolve };
  });

  if (verdict.accepted) {
    return 'Report accepted.';
  }

  return `Report rejected. Feedback:\n${verdict.feedback}\n\nRevise and call the same report tool again.`;
}

function createGlobalPlanTool(): ToolDefinition {
  return tool({
    description:
      'Submit a global plan for squad orchestration. Determine the task size (S/M/L) and provide a detailed plan.',
    args: {
      size: tool.schema
        .enum(['S', 'M', 'L'])
        .describe(
          'Task size: S (simple, single-file), M (medium, needs review), L (large, needs DAG + review)',
        ),
      planMarkdown: tool.schema
        .string()
        .min(1)
        .describe('Detailed plan in markdown format'),
    },
    async execute(
      args: { size: 'S' | 'M' | 'L'; planMarkdown: string },
      context: { sessionID: string },
    ) {
      const parsed = GlobalPlanSchema.safeParse(args);
      if (!parsed.success) {
        return `Validation failed: ${parsed.error.message}. Expected: { size: "S"|"M"|"L", planMarkdown: string }`;
      }

      const report: GlobalPlanReport = {
        kind: 'global_plan',
        childTaskId: context.sessionID,
        ...parsed.data,
      };

      return gateWait(context.sessionID, report);
    },
  });
}

function createReviewTool(): ToolDefinition {
  return tool({
    description:
      'Submit a review verdict. Pass with null feedbackMarkdown, or reject with specific feedback.',
    args: {
      feedbackMarkdown: tool.schema
        .string()
        .nullable()
        .optional()
        .describe('null or empty = accept. Non-empty = reject with feedback.'),
    },
    async execute(
      args: { feedbackMarkdown?: string | null },
      context: { sessionID: string },
    ) {
      const parsed = ReviewSchema.safeParse(args);
      if (!parsed.success) {
        return `Validation failed: ${parsed.error.message}. Expected: { feedbackMarkdown?: string | null }`;
      }

      const report: ReviewReport = {
        kind: 'review',
        ...parsed.data,
      };

      return gateWait(context.sessionID, report);
    },
  });
}

function createDagDesignTool(): ToolDefinition {
  return tool({
    description:
      'Submit a DAG design for L-path squad orchestration. Define parallel execution nodes and their dependencies.',
    args: {
      nodes: tool.schema
        .array(
          tool.schema.object({
            name: tool.schema.string().min(1),
          }),
        )
        .min(1)
        .describe('Array of DAG nodes with unique names'),
      edges: tool.schema
        .array(
          tool.schema.object({
            parent: tool.schema.string().min(1),
            child: tool.schema.string().min(1),
          }),
        )
        .describe('Array of edges. parent must complete before child starts.'),
    },
    async execute(
      args: {
        nodes: Array<{ name: string }>;
        edges: Array<{ parent: string; child: string }>;
      },
      context: { sessionID: string },
    ) {
      const parsed = DagDesignSchema.safeParse(args);
      if (!parsed.success) {
        return `Validation failed: ${parsed.error.message}. Expected: { nodes: [{name}], edges: [{parent, child}] }`;
      }

      const report: DagDesignReport = {
        kind: 'dag_design',
        ...parsed.data,
      };

      return gateWait(context.sessionID, report);
    },
  });
}

function createNodePlanTool(): ToolDefinition {
  return tool({
    description:
      'Submit a node plan for the current DAG node in squad orchestration.',
    args: {
      planMarkdown: tool.schema
        .string()
        .min(1)
        .describe('Detailed node plan in markdown format'),
    },
    async execute(
      args: { planMarkdown: string },
      context: { sessionID: string },
    ) {
      const parsed = NodePlanSchema.safeParse(args);
      if (!parsed.success) {
        return `Validation failed: ${parsed.error.message}. Expected: { planMarkdown: string }`;
      }

      const report: NodePlanReport = {
        kind: 'node_plan',
        childTaskId: context.sessionID,
        ...parsed.data,
      };

      return gateWait(context.sessionID, report);
    },
  });
}

function createNodeExecTool(): ToolDefinition {
  return tool({
    description:
      'Submit an execution report for the current node in squad orchestration. Include affected files list.',
    args: {
      reportMarkdown: tool.schema
        .string()
        .min(1)
        .describe('Detailed report of work done'),
      affectedFiles: tool.schema
        .array(tool.schema.string())
        .describe('List of absolute paths to files that were modified'),
    },
    async execute(
      args: { reportMarkdown: string; affectedFiles: string[] },
      context: { sessionID: string },
    ) {
      const parsed = NodeExecSchema.safeParse(args);
      if (!parsed.success) {
        return `Validation failed: ${parsed.error.message}. Expected: { reportMarkdown: string, affectedFiles: string[] }`;
      }

      const report: NodeExecReport = {
        kind: 'node_exec',
        childTaskId: context.sessionID,
        ...parsed.data,
      };

      return gateWait(context.sessionID, report);
    },
  });
}
