import { renderExecPrompt } from './prompts';
import type { SquadRuntime } from './runtime';
import type { NodeExecReport } from './schemas';

export interface SquadResult {
  taskId: string;
  reportMarkdown: string;
  status: 'completed' | 'cancelled';
  nodes?: Array<{
    name: string;
    status: string;
    reportMarkdown?: string;
    affectedFiles?: string[];
  }>;
}

export async function runSPath(
  planMarkdown: string,
  runtime: SquadRuntime,
): Promise<SquadResult> {
  const execChildId = await runtime.createChild({
    stage: 'node_exec',
    agent: 'squad_executor',
    prompt: renderExecPrompt(planMarkdown),
  });

  try {
    const execReport = await runtime.awaitReport<NodeExecReport>(execChildId);
    runtime.gateAccept(execChildId);
    await runtime.cleanupChild(execChildId);

    return {
      taskId: execChildId,
      reportMarkdown: execReport.reportMarkdown,
      status: 'completed',
    };
  } catch (err) {
    runtime.gateAccept(execChildId);
    await runtime.cleanupChild(execChildId);
    throw err;
  }
}
