import {
  renderNodeExecPrompt,
  renderNodeExecReviewPrompt,
  renderNodePlanPrompt,
  renderNodePlanReviewPrompt,
} from './prompts';
import type { SquadRuntime } from './runtime';
import type { NodeExecReport, NodePlanReport } from './schemas';

export interface NodeParams {
  nodeName: string;
  planMarkdown: string;
  nodes: Array<{ name: string }>;
  edges: Array<{ child: string; parent: string }>;
}

export async function executeSingleNode(
  params: NodeParams,
  runtime: SquadRuntime,
): Promise<NodeExecReport> {
  const planReport = await runtime.withReviewLoop<NodePlanReport>(
    'node_plan',
    'squad_planner',
    renderNodePlanPrompt(
      params.nodeName,
      params.planMarkdown,
      params.nodes,
      params.edges,
    ),
    (report) =>
      renderNodePlanReviewPrompt(
        params.nodeName,
        report.planMarkdown,
        params.planMarkdown,
        params.nodes,
        params.edges,
      ),
    params.nodeName,
  );

  const execReport = await runtime.withReviewLoop<NodeExecReport>(
    'node_exec',
    'squad_executor',
    renderNodeExecPrompt(params.nodeName, planReport.planMarkdown),
    (report, ctx) =>
      renderNodeExecReviewPrompt(
        params.nodeName,
        planReport.planMarkdown,
        report.reportMarkdown,
        ctx,
      ),
    params.nodeName,
  );

  return execReport;
}
