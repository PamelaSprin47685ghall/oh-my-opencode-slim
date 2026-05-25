import type { NodeResult } from './dag-scheduler';
import { runNodeLoop } from './dag-scheduler';
import { readAffectedFiles } from './fs-utils';
import { renderDagDesignPrompt, renderEndReviewPrompt } from './prompts';
import type { ResumeState } from './resume';
import type { SquadRuntime } from './runtime';
import type { DagDesignReport, ReviewReport } from './schemas';
import { saveDag } from './state';

export async function runDAGExecution(
  planMarkdown: string,
  runtime: SquadRuntime,
  resumeState?: ResumeState,
): Promise<{ nodeResults: NodeResult[]; endReviewFeedback: string | null }> {
  let dagDesign: DagDesignReport;

  // Use timestamp for state serialization/deserialization.
  // When resuming, we should use the same timestamp.
  const timestamp = resumeState?.timestamp || new Date().toISOString();

  if (resumeState?.dag) {
    dagDesign = {
      kind: 'dag_design',
      nodes: resumeState.dag.nodes.names.map((name) => ({ name })),
      edges: resumeState.dag.edges,
    };
  } else {
    dagDesign = (await runtime.executeFresh({
      stage: 'dag_design',
      agent: 'squad_planner',
      prompt: renderDagDesignPrompt(planMarkdown),
    })) as DagDesignReport;

    saveDag(runtime.cwd, timestamp, {
      nodes: { names: dagDesign.nodes.map((n) => n.name) },
      edges: dagDesign.edges,
    });
  }

  const nodeResults = await runNodeLoop(
    { nodes: dagDesign.nodes, edges: dagDesign.edges, planMarkdown },
    runtime,
    resumeState,
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
