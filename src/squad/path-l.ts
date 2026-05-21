import type { NodeResult } from './dag-scheduler';
import { runNodeLoop } from './dag-scheduler';
import { readAffectedFiles } from './fs-utils';
import { renderDagDesignPrompt, renderEndReviewPrompt } from './prompts';
import type { SquadRuntime } from './runtime';
import type { DagDesignReport, ReviewReport } from './schemas';

export async function runDAGExecution(
  planMarkdown: string,
  runtime: SquadRuntime,
): Promise<{ nodeResults: NodeResult[]; endReviewFeedback: string | null }> {
  const dagDesign = (await runtime.executeFresh({
    stage: 'dag_design',
    agent: 'squad_planner',
    prompt: renderDagDesignPrompt(planMarkdown),
  })) as DagDesignReport;

  const nodeResults = await runNodeLoop(
    { nodes: dagDesign.nodes, edges: dagDesign.edges, planMarkdown },
    runtime,
  );

  const mergedFiles = [...new Set(nodeResults.flatMap((n) => n.affectedFiles))];
  const fileContentsContext = await readAffectedFiles(mergedFiles, runtime.cwd);

  const endReview = (await runtime.executeFresh({
    stage: 'review',
    agent: 'squad_reviewer',
    prompt: renderEndReviewPrompt(
      planMarkdown,
      nodeResults,
      fileContentsContext,
    ),
  })) as ReviewReport;

  return { nodeResults, endReviewFeedback: endReview.feedbackMarkdown };
}
