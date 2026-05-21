import type { PluginInput } from '@opencode-ai/plugin';
import { readAffectedFiles } from './fs-utils';
import type { ReviewReport, SquadReport } from './schemas';
import { Deferred, type SquadSession, squadSessions } from './squad-context';

type OpencodeClient = PluginInput['client'];

export interface StageExecutionParams {
  stage: 'global_plan' | 'review' | 'dag_design' | 'node_plan' | 'node_exec';
  agent: 'squad_planner' | 'squad_reviewer' | 'squad_executor';
  prompt: string;
  /** For DAG nodes — appended to session title for debuggability. */
  nodeName?: string;
  /** Enable tools to pass through to child sessions. */
  additionalTools?: Record<string, boolean>;
}

export interface SquadDeps {
  client: OpencodeClient;
  directory: string;
  parentSessionId: string;
  structuredStore: Map<string, SquadReport>;
  createdChildIds: Set<string>;
  abortSignal?: AbortSignal;
}

export interface SquadRuntime {
  workspaceId: string;
  cwd: string;
  isAborted: () => boolean;
  createChild: (params: StageExecutionParams) => Promise<string>;
  awaitReport: <T extends SquadReport>(childId: string) => Promise<T>;
  executeFresh: (params: StageExecutionParams) => Promise<SquadReport>;
  gateAccept: (childId: string) => void;
  gateReject: (childId: string, feedback: string) => void;
  cleanupChild: (childId: string) => Promise<void>;
  cleanupAll: () => Promise<void>;
  withReviewLoop: <TReport extends SquadReport>(
    stage: SquadSession['stage'],
    agent: 'squad_planner' | 'squad_reviewer' | 'squad_executor',
    prompt: string,
    buildReviewPrompt: (report: TReport, fileContentsContext: string) => string,
    nodeName?: string,
  ) => Promise<TReport>;
}

/** Map stage name to the report tools that should be enabled for that stage. */
function stageTools(
  stage: SquadSession['stage'],
  additionalTools?: Record<string, boolean>,
): Record<string, boolean> {
  const tools: Record<string, boolean> = {
    // Stage-specific report tool — always enabled
    squad_global_plan: false,
    squad_review: false,
    squad_dag_design: false,
    squad_node_plan: false,
    squad_node_exec: false,
    // Standard tools
    read: true,
    glob: true,
    grep: true,
    ast_grep_search: true,
    ast_grep_replace: true,
    bash: true,
    edit: true,
    write: true,
    ...additionalTools,
  };

  // Enable only the stage-specific report tool
  switch (stage) {
    case 'global_plan':
      tools.squad_global_plan = true;
      break;
    case 'review':
      tools.squad_review = true;
      break;
    case 'dag_design':
      tools.squad_dag_design = true;
      break;
    case 'node_plan':
      tools.squad_node_plan = true;
      break;
    case 'node_exec':
      tools.squad_node_exec = true;
      break;
  }

  // Planner and reviewer stages disable bash (PRD §06: recursion mitigation)
  if (
    stage === 'global_plan' ||
    stage === 'node_plan' ||
    stage === 'dag_design' ||
    stage === 'review'
  ) {
    tools.bash = false;
  }

  return tools;
}

/** Map stage name to the agent that should run it. */
function stageAgent(
  stage: SquadSession['stage'],
): 'squad_planner' | 'squad_reviewer' | 'squad_executor' {
  switch (stage) {
    case 'global_plan':
    case 'dag_design':
    case 'node_plan':
      return 'squad_planner';
    case 'review':
      return 'squad_reviewer';
    case 'node_exec':
      return 'squad_executor';
  }
}

export function createSquadRuntime(deps: SquadDeps): SquadRuntime {
  const children = new Map<string, SquadSession>();

  async function createChild(params: StageExecutionParams): Promise<string> {
    const agent = params.agent ?? stageAgent(params.stage);
    const title = `Squad ${params.stage}${params.nodeName ? `: ${params.nodeName}` : ''}`;
    const tools = stageTools(params.stage, params.additionalTools);

    // Create child session
    const sessionResponse = await deps.client.session.create({
      responseStyle: 'data',
      throwOnError: true,
      query: { directory: deps.directory },
      body: {
        parentID: deps.parentSessionId,
        title,
      },
    });

    const childSessionId =
      (sessionResponse as { data?: { id?: string }; id?: string })?.data?.id ??
      (sessionResponse as { data?: { id?: string }; id?: string })?.id;

    if (!childSessionId) {
      throw new Error('Squad child session did not return an id');
    }

    // Register session in squadSessions before prompting so the
    // report tool can find it when the child calls it.
    const ctx: SquadSession = {
      parentWorkspaceId: deps.parentSessionId,
      childSessionId,
      stage: params.stage,
      structuredStore: deps.structuredStore,
      nodeName: params.nodeName,
      nextReport: new Deferred<void>(),
    };
    squadSessions.set(childSessionId, ctx);
    children.set(childSessionId, ctx);
    deps.createdChildIds.add(childSessionId);

    // Fire prompt — do NOT await it; the child runs in the background.
    // The gate mechanism (nextReport + gate) is our synchronization point.
    try {
      await deps.client.session.prompt({
        responseStyle: 'data',
        throwOnError: true,
        query: { directory: deps.directory },
        path: { id: childSessionId },
        body: {
          agent,
          parts: [{ type: 'text', text: params.prompt }],
          tools,
        },
      });
    } catch (err) {
      // If prompt fails immediately, clean up
      ctx.disposed = true;
      squadSessions.delete(childSessionId);
      children.delete(childSessionId);
      deps.createdChildIds.delete(childSessionId);
      throw err;
    }

    return childSessionId;
  }

  async function awaitReportInternal<T extends SquadReport>(
    childId: string,
  ): Promise<T> {
    const ctx = children.get(childId);
    if (!ctx) throw new Error(`No context for ${childId}`);

    // Wait for the child's report tool to resolve nextReport
    await ctx.nextReport.promise;

    // Reset nextReport for potential retry (gate reject → child resubmits)
    ctx.nextReport = new Deferred<void>();

    const report = deps.structuredStore.get(childId);
    if (!report) throw new Error(`No report from ${ctx.stage} (${childId})`);
    return report as T;
  }

  async function executeFreshInternal(
    params: StageExecutionParams,
  ): Promise<SquadReport> {
    const childId = await createChild(params);
    try {
      const ctx = children.get(childId);
      if (!ctx) throw new Error(`No session context for child ${childId}`);

      // Wait for report
      await ctx.nextReport.promise;
      const report = deps.structuredStore.get(childId);
      if (!report)
        throw new Error(`No report from ${params.stage} (${childId})`);

      // Accept immediately — fresh stages don't need review loops
      ctx.gate?.resolve({ accepted: true });

      return report;
    } catch (err) {
      const ctx = children.get(childId);
      ctx?.gate?.resolve({ accepted: true }); // G: release gate on error
      throw err;
    } finally {
      await cleanupChildInternal(childId);
    }
  }

  async function cleanupChildInternal(childId: string): Promise<void> {
    const ctx = children.get(childId);
    if (ctx) {
      ctx.disposed = true;
      ctx.gate?.resolve({ accepted: true }); // G: release gate
    }

    squadSessions.delete(childId);
    deps.structuredStore.delete(childId);
    children.delete(childId);
    deps.createdChildIds.delete(childId);

    // Abort the child session (H: kill children on cleanup)
    try {
      await deps.client.session.abort({
        path: { id: childId },
        query: { directory: deps.directory },
      });
    } catch {
      // Best-effort cleanup
    }
  }

  async function cleanupAllInternal(): Promise<void> {
    // Snapshot IDs before clearing so we can abort them after
    const allChildIds = [...deps.createdChildIds];

    for (const [childId, ctx] of children.entries()) {
      ctx.disposed = true;
      ctx.gate?.resolve({ accepted: true }); // G: release gate
      deps.structuredStore.delete(childId);
    }
    // Also clean global registry
    for (const childId of allChildIds) {
      squadSessions.delete(childId);
    }
    children.clear();
    deps.createdChildIds.clear();

    // Abort all child sessions (H)
    for (const childId of allChildIds) {
      try {
        await deps.client.session.abort({
          path: { id: childId },
          query: { directory: deps.directory },
        });
      } catch {
        // Best-effort
      }
    }
  }

  const runtime: SquadRuntime = {
    workspaceId: deps.parentSessionId,
    cwd: deps.directory,
    isAborted: () => !!deps.abortSignal?.aborted,
    createChild,
    awaitReport: awaitReportInternal,
    executeFresh: executeFreshInternal,
    gateAccept: (childId) => {
      const ctx = children.get(childId);
      if (ctx) ctx.gate?.resolve({ accepted: true });
    },
    gateReject: (childId, feedback) => {
      const ctx = children.get(childId);
      if (ctx) ctx.gate?.resolve({ accepted: false, feedback });
    },
    cleanupChild: cleanupChildInternal,
    cleanupAll: cleanupAllInternal,
    withReviewLoop: async <TReport extends SquadReport>(
      stage: SquadSession['stage'],
      agent: 'squad_planner' | 'squad_reviewer' | 'squad_executor',
      prompt: string,
      buildReviewPrompt: (
        report: TReport,
        fileContentsContext: string,
      ) => string,
      nodeName?: string,
    ): Promise<TReport> => {
      const childId = await runtime.createChild({
        stage,
        agent,
        prompt,
        nodeName,
      });

      while (true) {
        if (runtime.isAborted()) {
          runtime.gateAccept(childId);
          await runtime.cleanupChild(childId);
          throw new Error(
            `${stage}${nodeName ? ` (${nodeName})` : ''} aborted`,
          );
        }

        const report = await runtime.awaitReport<TReport>(childId);

        // Read affected files before building review prompt
        let fileContentsContext = '(无受影响文件)';
        if (
          'affectedFiles' in (report as object) &&
          Array.isArray((report as Record<string, unknown>).affectedFiles)
        ) {
          const files = (report as unknown as { affectedFiles: string[] })
            .affectedFiles;
          if (files.length > 0) {
            fileContentsContext = await readAffectedFiles(
              files,
              deps.directory,
            );
          }
        }

        const review = (await runtime.executeFresh({
          stage: 'review',
          agent: 'squad_reviewer',
          prompt: buildReviewPrompt(report, fileContentsContext),
          nodeName,
        })) as ReviewReport;

        if (review.feedbackMarkdown != null) {
          runtime.gateReject(childId, review.feedbackMarkdown);
          continue;
        }

        runtime.gateAccept(childId);
        await runtime.cleanupChild(childId);
        return report;
      }
    },
  };

  return runtime;
}
