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
import type { SquadDeps } from './runtime';
import { createSquadRuntime } from './runtime';
import type { GlobalPlanReport, ReviewReport } from './schemas';

export interface SquadParams extends SquadDeps {
  intent: string;
}

/** Maximum number of outer loop iterations (global plan retries). */
const MAX_GLOBAL_PLAN_RETRIES = 5;

export async function runSquad(params: SquadParams): Promise<SquadResult> {
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
    for (let attempt = 0; attempt < MAX_GLOBAL_PLAN_RETRIES; attempt++) {
      if (runtime.isAborted()) {
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

        // S: no review — gate hangs during execution, released after
        if (size === 'S') {
          try {
            const result = await runSPath(planMarkdown, runtime);
            runtime.gateAccept(planChildId);
            await runtime.cleanupChild(planChildId);
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
          ({ nodeResults, endReviewFeedback } = await runDAGExecution(
            planMarkdown,
            runtime,
          ));
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
    return {
      taskId: runtime.workspaceId,
      reportMarkdown: renderExhaustedRetriesResult(),
      status: 'cancelled',
    };
  } finally {
    await runtime.cleanupAll();
  }
}
