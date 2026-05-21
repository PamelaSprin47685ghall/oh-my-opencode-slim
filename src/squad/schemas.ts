import { z } from 'zod';

export type SquadStage =
  | 'global_plan'
  | 'review'
  | 'dag_design'
  | 'node_plan'
  | 'node_exec';

const NonEmptyText = z.string().trim().min(1);

export const GlobalPlanSchema = z
  .object({
    size: z.enum(['S', 'M', 'L']),
    planMarkdown: NonEmptyText,
  })
  .strict();

export const ReviewSchema = z
  .object({
    feedbackMarkdown: z
      .string()
      .optional()
      .nullable()
      .transform((v) => {
        if (v == null) return null;
        const trimmed = v.trim();
        if (trimmed.length === 0) return null;
        if (trimmed.toLowerCase() === 'null') return null;
        return v;
      }),
  })
  .strict();

const EdgeSchema = z
  .object({
    child: NonEmptyText,
    parent: NonEmptyText,
  })
  .strict();

function isAcyclic(
  nodes: { name: string }[],
  edges: { child: string; parent: string }[],
): boolean {
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    adj.set(node.name, []);
  }
  for (const edge of edges) {
    adj.get(edge.child)?.push(edge.parent);
  }

  const visited = new Set<string>();
  const recStack = new Set<string>();

  function hasCycle(v: string): boolean {
    if (recStack.has(v)) return true;
    if (visited.has(v)) return false;

    visited.add(v);
    recStack.add(v);

    const neighbors = adj.get(v) || [];
    for (const neighbor of neighbors) {
      if (hasCycle(neighbor)) return true;
    }

    recStack.delete(v);
    return false;
  }

  for (const node of nodes) {
    if (hasCycle(node.name)) return false;
  }
  return true;
}

export const DagDesignSchema = z
  .object({
    nodes: z.array(z.object({ name: NonEmptyText }).strict()).min(1),
    edges: z.array(EdgeSchema),
  })
  .strict()
  .refine(
    (data) => {
      const nodeNames = new Set(data.nodes.map((n) => n.name));
      if (nodeNames.size !== data.nodes.length) return false;
      for (const edge of data.edges) {
        if (!nodeNames.has(edge.child)) return false;
        if (!nodeNames.has(edge.parent)) return false;
        if (edge.child === edge.parent) return false;
      }
      return isAcyclic(data.nodes, data.edges);
    },
    {
      message:
        'Invalid DAG: duplicate names, unknown nodes, self-dependency, or cycle detected',
    },
  );

export const NodePlanSchema = z
  .object({
    planMarkdown: NonEmptyText,
  })
  .strict();

export const NodeExecSchema = z
  .object({
    reportMarkdown: NonEmptyText,
    affectedFiles: z.array(z.string()),
  })
  .strict();

export type GlobalPlanReport = {
  kind: 'global_plan';
  childTaskId: string;
} & z.infer<typeof GlobalPlanSchema>;
export type ReviewReport = { kind: 'review' } & z.infer<typeof ReviewSchema>;
export type DagDesignReport = { kind: 'dag_design' } & z.infer<
  typeof DagDesignSchema
>;
export type NodePlanReport = {
  kind: 'node_plan';
  childTaskId: string;
} & z.infer<typeof NodePlanSchema>;
export type NodeExecReport = {
  kind: 'node_exec';
  childTaskId: string;
} & z.infer<typeof NodeExecSchema>;

export type SquadReport =
  | GlobalPlanReport
  | ReviewReport
  | DagDesignReport
  | NodePlanReport
  | NodeExecReport;

export function schemaForStage(stage: string) {
  switch (stage) {
    case 'global_plan':
      return GlobalPlanSchema;
    case 'review':
      return ReviewSchema;
    case 'dag_design':
      return DagDesignSchema;
    case 'node_plan':
      return NodePlanSchema;
    case 'node_exec':
      return NodeExecSchema;
    default:
      throw new Error(`Unknown stage: ${stage}`);
  }
}

export function describeSchema(stage: string): string {
  switch (stage) {
    case 'global_plan':
      return '{ size: "S"|"M"|"L", planMarkdown: string }';
    case 'review':
      return '{ feedbackMarkdown?: string | null }';
    case 'dag_design':
      return '{ nodes: [{ name }], edges: [{ child, parent }] }';
    case 'node_plan':
      return '{ planMarkdown: string }';
    case 'node_exec':
      return '{ reportMarkdown: string, affectedFiles: string[] }';
    default:
      return 'unknown';
  }
}
