import type { SquadResult } from './path-s';
import type { SquadReport } from './schemas';

// ---------------------------------------------------------------------------
// Squad result renderers (used by squad-tool.ts and orchestrator.ts)
// ---------------------------------------------------------------------------

/** Render the final L-path combined node report. */
export function renderNodeResults(
  nodes: Array<{ name: string; reportMarkdown: string }>,
): string {
  return nodes.map((n) => `### ${n.name}\n\n${n.reportMarkdown}`).join('\n\n');
}

/** Render the full squad result output for completed runs. */
export function renderSquadResult(result: SquadResult): string {
  let output = `## Squad Result (Task: ${result.taskId})\n\n${result.reportMarkdown}`;
  if (result.nodes && result.nodes.length > 0) {
    output += '\n\n### Nodes\n';
    for (const node of result.nodes) {
      output += `- **${node.name}**: ${node.status}\n`;
    }
  }
  return output;
}

/** Render a cancelled squad result. */
export function renderCancelledResult(reportMarkdown: string): string {
  return `Squad execution cancelled.\n\n${reportMarkdown}`;
}

/** Render a failed squad result. */
export function renderFailedResult(message: string): string {
  return `Squad execution failed: ${message}`;
}

/** Render the exhausted-retries fallback result. */
export function renderExhaustedRetriesResult(): string {
  return 'Squad execution failed: exhausted all plan retries without completing.';
}

// ---------------------------------------------------------------------------
// Per-stage title (used for ctx.metadata in squad-tool.ts)
// ---------------------------------------------------------------------------

export function getTitle(
  report: SquadReport,
  nodeName?: string,
): string | undefined {
  switch (report.kind) {
    case 'global_plan':
      return 'Squad Global Plan';
    case 'review':
      return report.feedbackMarkdown == null
        ? 'Squad Review: Accepted'
        : 'Squad Review: Rejected';
    case 'dag_design':
      return 'Squad DAG Design';
    case 'node_plan':
      return `Squad Node Plan: ${nodeName ?? ''}`;
    case 'node_exec':
      return `Squad Node Exec: ${nodeName ?? ''}`;
    default:
      return undefined;
  }
}
