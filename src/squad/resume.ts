import {
  type DagState,
  loadDag,
  loadMeta,
  loadNodes,
  loadPlan,
  type NodesState,
  type PlanState,
  type SquadMeta,
} from './state';

export interface ResumeState {
  timestamp: string; // e.g. "20260525T143052"
  stage:
    | 'planning'
    | 'plan_reviewed'
    | 'dag_design'
    | 'dag_execution'
    | 'end_review';
  meta: SquadMeta;
  plan: PlanState | null;
  dag: DagState | null;
  nodes: NodesState | null;
}

export function getResumeState(
  directory: string,
  timestamp: string,
): ResumeState | null {
  const meta = loadMeta(directory, timestamp);
  if (!meta) return null;

  if (meta.status === 'completed' || meta.status === 'cancelled') {
    return null;
  }

  const plan = loadPlan(directory, timestamp);
  const dag = loadDag(directory, timestamp);
  const nodes = loadNodes(directory, timestamp);

  let stage: ResumeState['stage'] = 'planning';

  if (plan?.attempts.some((a) => a.gateAccepted)) {
    stage = 'plan_reviewed';
  }

  if (dag) {
    stage = 'dag_design';
    if (nodes && nodes.nodes.length > 0) {
      stage = 'dag_execution';
      // If all node names in dag have been completed in nodes
      const totalNodes = dag.nodes?.names ?? [];
      const completedCount = nodes.nodes.filter(
        (n) => n.status === 'completed',
      ).length;
      if (totalNodes.length > 0 && completedCount === totalNodes.length) {
        stage = 'end_review';
      }
    }
  }

  return {
    timestamp,
    stage,
    meta,
    plan,
    dag,
    nodes,
  };
}
