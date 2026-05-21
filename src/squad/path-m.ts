import type { SquadResult } from './path-s';
import { renderExecPrompt, renderExecReviewPrompt } from './prompts';
import type { SquadRuntime } from './runtime';
import type { NodeExecReport } from './schemas';

export async function runMPath(
  planMarkdown: string,
  runtime: SquadRuntime,
): Promise<SquadResult> {
  const execReport = await runtime.withReviewLoop<NodeExecReport>(
    'node_exec',
    'squad_executor',
    renderExecPrompt(planMarkdown),
    (report, ctx) =>
      renderExecReviewPrompt(planMarkdown, report.reportMarkdown, ctx),
  );

  return {
    taskId: execReport.childTaskId,
    reportMarkdown: execReport.reportMarkdown,
    status: 'completed',
  };
}
