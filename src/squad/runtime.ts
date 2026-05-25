import type { PluginInput } from '@opencode-ai/plugin';
import { readAffectedFiles } from './fs-utils';
import { renderNudgePrompt } from './prompts';
import type { ReviewReport, SquadReport, SquadStage } from './schemas';
import {
  DEFAULT_NUDGE_CONFIG,
  Deferred,
  type NudgeConfig,
  type SquadSession,
  squadSessions,
} from './squad-context';

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
  onSnapshot?: (
    event:
      | 'child_created'
      | 'child_cleanup'
      | 'gate_accepted'
      | 'gate_rejected',
    stage: SquadStage,
    childSessionId: string,
    report?: SquadReport,
    feedback?: string,
  ) => void;
}

export interface SquadRuntime {
  workspaceId: string;
  cwd: string;
  onSnapshot?: SquadDeps['onSnapshot'];
  isAborted: () => boolean;
  isNudgeExhausted: (childId: string) => boolean;
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
    // Squad entry points — never available in child sessions (anti-recursion)
    squad: false,
    // Stage-specific report tools — only the current stage is enabled
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

  // Planner and reviewer stages: read-only — no execution, no file mutation, no subagents
  if (
    stage === 'global_plan' ||
    stage === 'node_plan' ||
    stage === 'dag_design' ||
    stage === 'review'
  ) {
    tools.bash = false;
    tools.edit = false;
    tools.write = false;
    tools.task = false;
    tools.subtask = false;
    tools.semantic_edit = false;
  }

  return tools;
}

/**
 * Create an independent completion promise for the current prompt
 * generation. Returns a resolve function that is bound to *this*
 * specific promise — calling it will never affect a subsequent
 * promptPromise set by a later call to armPromptCompletion.
 *
 * This eliminates the race where a stale prompt completion
 * accidentally resolves a newer nudge's promptPromise, which
 * caused repeated nudge firing.
 */
export function armPromptCompletion(
  session: Pick<SquadSession, 'promptPromise'>,
): () => void {
  const completion = new Deferred<void>();
  session.promptPromise = completion.promise;
  return () => completion.resolve();
}

function startTrackedPrompt(
  session: Pick<SquadSession, 'promptPromise'>,
  start: () => Promise<unknown>,
): void {
  const resolvePrompt = armPromptCompletion(session);

  Promise.resolve()
    .then(start)
    .then(() => {
      resolvePrompt();
    })
    .catch(() => {
      resolvePrompt();
    });
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

/**
 * Create a default report for a stage when the child session
 * ends silently without calling its report tool (exhausted nudges).
 *
 * These reports are intentionally minimal — they carry enough data
 * to satisfy the schema so downstream orchestration doesn't crash,
 * but clearly signal that no real work was produced.
 */
function makeDefaultReport(
  stage: SquadStage,
  childSessionId: string,
): SquadReport {
  switch (stage) {
    case 'global_plan':
      return {
        kind: 'global_plan',
        childTaskId: childSessionId,
        size: 'S',
        planMarkdown:
          '(No plan was submitted — the child session ended without calling the report tool.)',
      };
    case 'review':
      return {
        kind: 'review',
        feedbackMarkdown:
          'Review skipped: child session ended without calling the report tool.',
      };
    case 'dag_design':
      return {
        kind: 'dag_design',
        nodes: [{ name: 'default-node' }],
        edges: [],
      };
    case 'node_plan':
      return {
        kind: 'node_plan',
        childTaskId: childSessionId,
        planMarkdown:
          '(No plan was submitted — the child session ended without calling the report tool.)',
      };
    case 'node_exec':
      return {
        kind: 'node_exec',
        childTaskId: childSessionId,
        reportMarkdown:
          '(No report was submitted — the child session ended without calling the report tool.)',
        affectedFiles: [],
      };
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

    // Per-child context — promptPromise is set by startTrackedPrompt below.
    const ctx: SquadSession = {
      parentWorkspaceId: deps.parentSessionId,
      childSessionId,
      stage: params.stage,
      structuredStore: deps.structuredStore,
      nodeName: params.nodeName,
      nextReport: new Deferred<void>(),
      nudgeCount: 0,
    };

    squadSessions.set(childSessionId, ctx);
    children.set(childSessionId, ctx);
    deps.createdChildIds.add(childSessionId);

    if (deps.onSnapshot) {
      try {
        deps.onSnapshot('child_created', params.stage, childSessionId);
      } catch (_e) {
        // ignore
      }
    }

    // Fire prompt — do NOT await it; the child runs in the background.
    // Fire prompt — do NOT await it; the child runs in the background.
    // The gate mechanism (nextReport + gate) is our synchronization point.
    // startTrackedPrompt sets up an independent completion promise so
    // awaitReportInternal can detect silent endings.
    startTrackedPrompt(ctx, () =>
      deps.client.session.prompt({
        responseStyle: 'data',
        throwOnError: true,
        query: { directory: deps.directory },
        path: { id: childSessionId },
        body: {
          agent,
          parts: [{ type: 'text', text: params.prompt }],
          tools,
        },
      }),
    );

    return childSessionId;
  }

  /**
   * Await a report from a child session, with nudge logic.
   *
   * If the child finishes (promptPromise resolves) without calling
   * its report tool (nextReport not resolved), we nudge it by
   * sending a reminder prompt. After maxNudges nudges without a
   * response, we create a default report and continue.
   */
  async function awaitReportInternal<T extends SquadReport>(
    childId: string,
  ): Promise<T> {
    const ctx = children.get(childId);
    if (!ctx) throw new Error(`No context for ${childId}`);

    const nudgeConfig: NudgeConfig = ctx.nudgeConfig ?? DEFAULT_NUDGE_CONFIG;
    const maxNudges = nudgeConfig.maxNudges;

    while (true) {
      if (runtime.isAborted()) {
        throw new Error(`Squad aborted`);
      }

      // Race: which resolves first?
      // - nextReport.promise → child called the report tool (success)
      // - promptPromise     → child ended without calling it (nudge)
      // - abortSignal       → parent cancelled (DAG error / user abort)
      const racers: Promise<
        | { type: 'report'; report: SquadReport | undefined }
        | { type: 'silent_end' }
      >[] = [
        ctx.nextReport.promise.then(() => {
          const report = deps.structuredStore.get(childId);
          return { type: 'report' as const, report };
        }),
        (ctx.promptPromise ?? new Promise<never>(() => {})).then(() => {
          return { type: 'silent_end' as const };
        }),
      ];

      if (deps.abortSignal) {
        const signal = deps.abortSignal;
        racers.push(
          new Promise<never>((_, reject) => {
            const onAbort = () => reject(new Error('Squad aborted'));
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener('abort', onAbort, {
              once: true,
            });
          }),
        );
      }

      const report = await Promise.race(racers);

      if (report.type === 'report') {
        // Child submitted a report — reset nextReport for potential retry
        ctx.nextReport = new Deferred<void>();
        if (!report.report) {
          throw new Error(`No report from ${ctx.stage} (${childId})`);
        }
        return report.report as T;
      }

      // Silent ending — child finished without calling report tool
      if (ctx.nudgeCount >= maxNudges) {
        // Exhausted all nudges — create a default report and continue.
        // Mark as exhausted so callers skip review (child is dead, can't revise).
        const defaultReport = makeDefaultReport(ctx.stage, childId);
        ctx.structuredStore.set(childId, defaultReport);
        ctx.nudgeExhausted = true;
        ctx.nextReport.resolve();
        // After resolving nextReport, the gate flow will proceed normally.
        // Reset nextReport for potential retry (gate reject → child resubmits)
        ctx.nextReport = new Deferred<void>();
        // The child never called the report tool, so ctx.gate is undefined.
        // Provide a pre-resolved gate so callers that try to gateAccept/gateReject
        // don't silently no-op — the gate is already accepted.
        if (!ctx.gate) {
          ctx.gate = { resolve: () => {} };
        }
        return defaultReport as T;
      }

      // Send nudge — increment counter and fire a new prompt.
      // startTrackedPrompt creates an independent completion promise
      // for this nudge so stale completions cannot affect it.
      ctx.nudgeCount++;
      const nudgeText = renderNudgePrompt(ctx.stage, ctx.nudgeCount, maxNudges);

      startTrackedPrompt(ctx, () =>
        deps.client.session.prompt({
          responseStyle: 'data',
          throwOnError: true,
          query: { directory: deps.directory },
          path: { id: childId },
          body: {
            agent: stageAgent(ctx.stage),
            parts: [{ type: 'text', text: nudgeText }],
            tools: stageTools(ctx.stage),
          },
        }),
      );
    }
  }

  async function executeFreshInternal(
    params: StageExecutionParams,
  ): Promise<SquadReport> {
    const childId = await createChild(params);
    try {
      const report = await runtime.awaitReport<SquadReport>(childId);

      const ctx = children.get(childId);
      if (ctx) {
        // Accept immediately — fresh stages don't need review loops
        ctx.gate?.resolve({ accepted: true });
      }

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
      if (deps.onSnapshot) {
        try {
          deps.onSnapshot('child_cleanup', ctx.stage, childId);
        } catch (_e) {
          // ignore
        }
      }
    }

    // Remove from global registry first so orphan sessions fail closed
    // in gateWait — they'll see disposed/missing ctx and return immediately.
    squadSessions.delete(childId);
    deps.structuredStore.delete(childId);
    children.delete(childId);
    deps.createdChildIds.delete(childId);
  }

  async function cleanupAllInternal(): Promise<void> {
    const allChildIds = [...deps.createdChildIds];

    for (const [childId, ctx] of children.entries()) {
      ctx.disposed = true;
      ctx.gate?.resolve({ accepted: true }); // G: release gate
      deps.structuredStore.delete(childId);
    }
    // Also clean global registry so orphan sessions fail closed
    for (const childId of allChildIds) {
      squadSessions.delete(childId);
    }
    children.clear();
    deps.createdChildIds.clear();
  }

  const runtime: SquadRuntime = {
    workspaceId: deps.parentSessionId,
    cwd: deps.directory,
    isAborted: () => !!deps.abortSignal?.aborted,
    isNudgeExhausted: (childId: string) => {
      const ctx = children.get(childId);
      return ctx?.nudgeExhausted === true;
    },
    createChild,
    awaitReport: awaitReportInternal,
    executeFresh: executeFreshInternal,
    gateAccept: (childId) => {
      const ctx = children.get(childId);
      if (ctx) ctx.gate?.resolve({ accepted: true });
      if (deps.onSnapshot && ctx) {
        try {
          const report = deps.structuredStore.get(childId);
          deps.onSnapshot('gate_accepted', ctx.stage, childId, report);
        } catch (_e) {
          // ignore
        }
      }
    },
    gateReject: (childId, feedback) => {
      const ctx = children.get(childId);
      if (ctx) ctx.gate?.resolve({ accepted: false, feedback });
      if (deps.onSnapshot && ctx) {
        try {
          deps.onSnapshot(
            'gate_rejected',
            ctx.stage,
            childId,
            undefined,
            feedback,
          );
        } catch (_e) {
          // ignore
        }
      }
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

        // If nudge was exhausted, the child is dead and can't revise —
        // skip review and accept immediately.
        const ctx = children.get(childId);
        if (ctx?.nudgeExhausted) {
          runtime.gateAccept(childId);
          await runtime.cleanupChild(childId);
          return report;
        }

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

        let review: ReviewReport;
        try {
          review = (await runtime.executeFresh({
            stage: 'review',
            agent: 'squad_reviewer',
            prompt: buildReviewPrompt(report, fileContentsContext),
            nodeName,
          })) as ReviewReport;
        } catch (err) {
          runtime.gateAccept(childId);
          await runtime.cleanupChild(childId);
          throw err;
        }

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
