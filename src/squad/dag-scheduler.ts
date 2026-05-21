import { executeSingleNode, type NodeParams } from './node-executor';
import type { SquadRuntime } from './runtime';
import type { NodeExecReport } from './schemas';

export interface NodeLoopParams {
  nodes: Array<{ name: string }>;
  edges: Array<{ child: string; parent: string }>;
  planMarkdown: string;
}

export interface NodeResult {
  name: string;
  status: string;
  reportMarkdown: string;
  affectedFiles: string[];
}

export async function runNodeLoop(
  params: NodeLoopParams,
  runtime: SquadRuntime,
): Promise<NodeResult[]> {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of params.nodes) {
    inDegree.set(node.name, 0);
    dependents.set(node.name, []);
  }

  for (const edge of params.edges) {
    inDegree.set(edge.child, (inDegree.get(edge.child) ?? 0) + 1);
    dependents.get(edge.parent)?.push(edge.child);
  }

  const hasZeroInDegree = Array.from(inDegree.values()).some(
    (deg) => deg === 0,
  );
  if (!hasZeroInDegree && params.nodes.length > 0) {
    throw new Error('Invalid DAG: Cycle detected or no entry nodes available.');
  }

  if (runtime.isAborted()) {
    throw new Error('Squad aborted');
  }

  const completed = new Map<string, NodeExecReport>();
  const dagAbort = new AbortController();

  const promise = new Promise<NodeResult[]>((resolve, reject) => {
    let hasError = false;

    const onAbort = () => {
      if (hasError) return;
      hasError = true;
      dagAbort.abort();
      reject(new Error('Squad aborted'));
    };

    if (runtime.isAborted()) {
      onAbort();
      return;
    }

    function triggerReady() {
      if (hasError || dagAbort.signal.aborted) return;
      if (completed.size === params.nodes.length) {
        resolve(formatResults(completed));
        return;
      }

      let isAnyRunning = false;

      for (const [name, deg] of inDegree.entries()) {
        if (deg === 0) {
          inDegree.set(name, -1);
          executeNodeSafely(name);
          isAnyRunning = true;
        } else if (deg === -1) {
          isAnyRunning = true;
        }
      }

      if (!isAnyRunning && completed.size < params.nodes.length) {
        hasError = true;
        reject(
          new Error(
            'DAG Deadlock: Cyclic dependency detected during execution.',
          ),
        );
      }
    }

    async function executeNodeSafely(name: string) {
      try {
        const nodeParams: NodeParams = {
          nodeName: name,
          planMarkdown: params.planMarkdown,
          nodes: params.nodes,
          edges: params.edges,
        };

        const report = await executeSingleNode(nodeParams, runtime);
        completed.set(name, report);

        for (const dep of dependents.get(name) ?? []) {
          inDegree.set(dep, (inDegree.get(dep) ?? 0) - 1);
        }

        triggerReady();
      } catch (err) {
        if (hasError) return;
        hasError = true;
        dagAbort.abort();
        reject(err);
      }
    }

    triggerReady();
  });

  return promise;
}

function formatResults(completed: Map<string, NodeExecReport>): NodeResult[] {
  return Array.from(completed.entries()).map(([name, report]) => ({
    name,
    status: 'completed',
    reportMarkdown: report.reportMarkdown,
    affectedFiles: report.affectedFiles,
  }));
}
