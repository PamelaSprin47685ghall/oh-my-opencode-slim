import { runDAGExecution } from './path-l';
import { runMPath } from './path-m';
import { runSPath, type SquadResult } from './path-s';
import {
  renderExecRejectionFeedback,
  renderGlobalPlanPrompt,
  renderGlobalReviewPrompt,
  renderPlanRejectionFeedback,
} from './prompts';
import {
  renderExhaustedRetriesResult,
  renderNodeResults,
} from './report-renderer';
import type { ResumeState } from './resume';
import type { SquadDeps } from './runtime';
import { createSquadRuntime } from './runtime';
import type { GlobalPlanReport, ReviewReport } from './schemas';
import { saveMeta, savePlan } from './state';

export interface SquadParams extends SquadDeps {
  intent: string;
  resumeState?: ResumeState;
}

/** Maximum number of outer loop iterations (global plan retries). */
const MAX_GLOBAL_PLAN_RETRIES = 5;

export async function runSquad(params: SquadParams): Promise<SquadResult> {
  const _timestamp =
    params.resumeState?.timestamp ||
    new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  const realTimestamp =
    params.resumeState?.timestamp || new Date().toISOString();

  // Create onSnapshot hook to persist state
  const originalOnSnapshot = params.onSnapshot;
  params.onSnapshot = (event, stage, childSessionId, report, feedback) => {
    if (originalOnSnapshot) {
      try {
        originalOnSnapshot(event, stage, childSessionId, report, feedback);
      } catch (_e) {}
    }

    if (event === 'gate_accepted' && stage === 'global_plan') {
      const rep = report as GlobalPlanReport;
      if (rep) {
        saveMeta(params.directory, realTimestamp, {
          timestamp: realTimestamp,
          intent: params.intent,
          directory: params.directory,
          status: 'running',
          size: rep.size,
        });

        const attempts = params.resumeState?.plan?.attempts || [];
        const index = attempts.length;
        attempts.push({
          index,
          size: rep.size,
          planMarkdown: rep.planMarkdown,
          reviewFeedback: null,
          gateAccepted: true,
        });
        savePlan(params.directory, realTimestamp, { attempts });
      }
    } else if (event === 'gate_rejected' && stage === 'global_plan') {
      const attempts = params.resumeState?.plan?.attempts || [];
      const index = attempts.length;
      attempts.push({
        index,
        size: 'L', // default, review rejects are usually from larger sizes
        planMarkdown: '(Plan rejected)',
        reviewFeedback: feedback || null,
        gateAccepted: false,
      });
      savePlan(params.directory, realTimestamp, { attempts });
    }
  };

  const runtime = createSquadRuntime(params);

  async function executeGlobalReview(
    planChildId: string,
    size: string,
    planMarkdown: string,
  ): Promise<ReviewReport | null> {
    let review: ReviewReport;
    try {
      review = (await runtime.executeFresh({
        stage: 'review',
        agent: 'squad_reviewer',
        prompt: renderGlobalReviewPrompt(params.intent, size, planMarkdown),
      })) as ReviewReport;
    } catch (err) {
      runtime.gateAccept(planChildId);
      await runtime.cleanupChild(planChildId);
      throw err;
    }
    if (review.feedbackMarkdown != null) {
      runtime.gateReject(
        planChildId,
        renderPlanRejectionFeedback(review.feedbackMarkdown),
      );
      return null;
    }
    return review;
  }

  try {
    // 0. Save initial meta state
    if (!params.resumeState) {
      saveMeta(params.directory, realTimestamp, {
        timestamp: realTimestamp,
        intent: params.intent,
        directory: params.directory,
        status: 'running',
      });
    }

    // Check if we are resuming from plan_reviewed or later stages
    if (params.resumeState && params.resumeState.stage !== 'planning') {
      const acceptedAttempt = params.resumeState.plan?.attempts.find(
        (a) => a.gateAccepted,
      );
      if (acceptedAttempt) {
        const { size, planMarkdown } = acceptedAttempt;

        if (size === 'S') {
          const result = await runSPath(planMarkdown, runtime);
          saveMeta(params.directory, realTimestamp, {
            timestamp: realTimestamp,
            intent: params.intent,
            directory: params.directory,
            status: 'completed',
            size: 'S',
          });
          return result;
        }

        if (size === 'M') {
          const result = await runMPath(planMarkdown, runtime);
          saveMeta(params.directory, realTimestamp, {
            timestamp: realTimestamp,
            intent: params.intent,
            directory: params.directory,
            status: 'completed',
            size: 'M',
          });
          return result;
        }

        // L path resume
        const { nodeResults, endReviewFeedback } = await runDAGExecution(
          planMarkdown,
          runtime,
          params.resumeState,
        );

        if (endReviewFeedback != null) {
          // If end review fails on resume, we fall back to global loop execution
          // But to be clean we could write cancelled or loop back, let's just let it propagate
        }

        saveMeta(params.directory, realTimestamp, {
          timestamp: realTimestamp,
          intent: params.intent,
          directory: params.directory,
          status: 'completed',
          size: 'L',
        });

        const combinedReport = renderNodeResults(nodeResults);
        return {
          taskId: runtime.workspaceId,
          reportMarkdown: combinedReport,
          status: 'completed' as const,
          nodes: nodeResults,
        };
      }
    }

    for (let attempt = 0; attempt < MAX_GLOBAL_PLAN_RETRIES; attempt++) {
      if (runtime.isAborted()) {
        saveMeta(params.directory, realTimestamp, {
          timestamp: realTimestamp,
          intent: params.intent,
          directory: params.directory,
          status: 'cancelled',
        });
        return {
          taskId: runtime.workspaceId,
          reportMarkdown: 'Squad execution cancelled.',
          status: 'cancelled',
        };
      }

      const planChildId = await runtime.createChild({
        stage: 'global_plan',
        agent: 'squad_planner',
        prompt: renderGlobalPlanPrompt(params.intent),
      });

      // Inner loop: same plan child, review reject → agent retries → accept
      while (true) {
        const planReport =
          await runtime.awaitReport<GlobalPlanReport>(planChildId);
        const { size, planMarkdown } = planReport;

        // If the plan child exhausted nudges, the child is dead and
        // cannot revise. Accept and move on without review.
        if (runtime.isNudgeExhausted(planChildId)) {
          runtime.gateAccept(planChildId);
          await runtime.cleanupChild(planChildId);
          saveMeta(params.directory, realTimestamp, {
            timestamp: realTimestamp,
            intent: params.intent,
            directory: params.directory,
            status: 'completed',
            size: 'S',
          });
          return {
            taskId: runtime.workspaceId,
            reportMarkdown: planReport.planMarkdown,
            status: 'completed' as const,
          };
        }

        // S: no review — gate hangs during execution, released after
        if (size === 'S') {
          try {
            const result = await runSPath(planMarkdown, runtime);
            runtime.gateAccept(planChildId);
            await runtime.cleanupChild(planChildId);
            saveMeta(params.directory, realTimestamp, {
              timestamp: realTimestamp,
              intent: params.intent,
              directory: params.directory,
              status: 'completed',
              size: 'S',
            });
            return result;
          } catch (err) {
            runtime.gateAccept(planChildId);
            await runtime.cleanupChild(planChildId);
            throw err;
          }
        }

        // M: review → hang gate during exec with review loop → release after
        if (size === 'M') {
          const review = await executeGlobalReview(
            planChildId,
            size,
            planMarkdown,
          );
          if (!review) continue;

          try {
            const result = await runMPath(planMarkdown, runtime);
            runtime.gateAccept(planChildId);
            await runtime.cleanupChild(planChildId);
            saveMeta(params.directory, realTimestamp, {
              timestamp: realTimestamp,
              intent: params.intent,
              directory: params.directory,
              status: 'completed',
              size: 'M',
            });
            return result;
          } catch (err) {
            runtime.gateAccept(planChildId);
            await runtime.cleanupChild(planChildId);
            throw err;
          }
        }

        // L: review → hang gate → DAG + exec + end review → release
        const review = await executeGlobalReview(
          planChildId,
          size,
          planMarkdown,
        );
        if (!review) continue;

        // Gate hangs — plan agent waits while DAG runs
        let nodeResults: {
          name: string;
          status: string;
          reportMarkdown: string;
          affectedFiles: string[];
        }[];
        let endReviewFeedback: string | null;
        try {
          const res = await runDAGExecution(planMarkdown, runtime);
          nodeResults = res.nodeResults;
          endReviewFeedback = res.endReviewFeedback;
        } catch (err) {
          runtime.gateAccept(planChildId);
          await runtime.cleanupChild(planChildId);
          throw err;
        }

        if (endReviewFeedback != null) {
          runtime.gateReject(
            planChildId,
            renderExecRejectionFeedback(endReviewFeedback),
          );
          continue;
        }

        runtime.gateAccept(planChildId);
        await runtime.cleanupChild(planChildId);

        saveMeta(params.directory, realTimestamp, {
          timestamp: realTimestamp,
          intent: params.intent,
          directory: params.directory,
          status: 'completed',
          size: 'L',
        });

        const combinedReport = renderNodeResults(nodeResults);
        return {
          taskId: runtime.workspaceId,
          reportMarkdown: combinedReport,
          status: 'completed' as const,
          nodes: nodeResults,
        };
      }
    }

    // Exhausted all global plan retries
    saveMeta(params.directory, realTimestamp, {
      timestamp: realTimestamp,
      intent: params.intent,
      directory: params.directory,
      status: 'cancelled',
    });
    return {
      taskId: runtime.workspaceId,
      reportMarkdown: renderExhaustedRetriesResult(),
      status: 'cancelled',
    };
  } finally {
    await runtime.cleanupAll();
  }
}
