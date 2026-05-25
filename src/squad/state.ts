import * as fs from 'node:fs';
import * as path from 'node:path';
import * as toml from 'smol-toml';

export interface SquadMeta {
  timestamp: string;
  intent: string;
  directory: string;
  status: 'running' | 'completed' | 'cancelled';
  size?: 'S' | 'M' | 'L';
}

export interface PlanAttempt {
  index: number;
  size: 'S' | 'M' | 'L';
  planMarkdown: string;
  reviewFeedback: string | null;
  gateAccepted: boolean;
}

export interface PlanState {
  attempts: PlanAttempt[];
}

export interface DagNodeDef {
  name: string;
}

export interface DagEdgeDef {
  parent: string;
  child: string;
}

export interface DagState {
  nodes: { names: string[] };
  edges: DagEdgeDef[];
}

export interface NodeResultState {
  name: string;
  status: 'completed' | 'pending' | 'failed';
  reportMarkdown: string;
  affectedFiles: string[];
}

export interface NodesState {
  nodes: NodeResultState[];
}

export function ensureSquadDir(directory: string, timestamp: string): string {
  const dir = path.join(
    directory,
    'squad',
    timestamp.replace(/[-:]/g, '').split('.')[0],
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveMeta(
  directory: string,
  timestamp: string,
  meta: SquadMeta,
) {
  const dir = ensureSquadDir(directory, timestamp);
  fs.writeFileSync(
    path.join(dir, 'meta.toml'),
    toml.stringify(meta as unknown as Record<string, unknown>),
  );
}

export function loadMeta(
  directory: string,
  timestamp: string,
): SquadMeta | null {
  const normalizedTimestamp = timestamp.replace(/[-:]/g, '').split('.')[0];
  const dir = path.join(directory, 'squad', normalizedTimestamp);
  const file = path.join(dir, 'meta.toml');
  if (!fs.existsSync(file)) return null;
  return toml.parse(fs.readFileSync(file, 'utf-8')) as unknown as SquadMeta;
}

export function savePlan(
  directory: string,
  timestamp: string,
  plan: PlanState,
) {
  const dir = ensureSquadDir(directory, timestamp);
  fs.writeFileSync(
    path.join(dir, 'plan.toml'),
    toml.stringify(plan as unknown as Record<string, unknown>),
  );
}

export function loadPlan(
  directory: string,
  timestamp: string,
): PlanState | null {
  const normalizedTimestamp = timestamp.replace(/[-:]/g, '').split('.')[0];
  const dir = path.join(directory, 'squad', normalizedTimestamp);
  const file = path.join(dir, 'plan.toml');
  if (!fs.existsSync(file)) return null;
  return toml.parse(fs.readFileSync(file, 'utf-8')) as unknown as PlanState;
}

export function saveDag(directory: string, timestamp: string, dag: DagState) {
  const dir = ensureSquadDir(directory, timestamp);
  fs.writeFileSync(
    path.join(dir, 'dag.toml'),
    toml.stringify(dag as unknown as Record<string, unknown>),
  );
}

export function loadDag(directory: string, timestamp: string): DagState | null {
  const normalizedTimestamp = timestamp.replace(/[-:]/g, '').split('.')[0];
  const dir = path.join(directory, 'squad', normalizedTimestamp);
  const file = path.join(dir, 'dag.toml');
  if (!fs.existsSync(file)) return null;
  return toml.parse(fs.readFileSync(file, 'utf-8')) as unknown as DagState;
}

export function saveNodes(
  directory: string,
  timestamp: string,
  nodes: NodesState,
) {
  const dir = ensureSquadDir(directory, timestamp);
  fs.writeFileSync(
    path.join(dir, 'nodes.toml'),
    toml.stringify(nodes as unknown as Record<string, unknown>),
  );
}

export function loadNodes(
  directory: string,
  timestamp: string,
): NodesState | null {
  const normalizedTimestamp = timestamp.replace(/[-:]/g, '').split('.')[0];
  const dir = path.join(directory, 'squad', normalizedTimestamp);
  const file = path.join(dir, 'nodes.toml');
  if (!fs.existsSync(file)) return null;
  return toml.parse(fs.readFileSync(file, 'utf-8')) as unknown as NodesState;
}

export interface CheckpointInfo {
  timestamp: string;
  intent: string;
  directory: string;
  status: 'running' | 'completed' | 'cancelled';
  size?: 'S' | 'M' | 'L';
  completedNodes: number;
  totalNodes: number;
}

export function listCheckpoints(directory: string): CheckpointInfo[] {
  const squadDir = path.join(directory, 'squad');
  if (!fs.existsSync(squadDir)) return [];
  const entries = fs.readdirSync(squadDir, { withFileTypes: true });
  const list: CheckpointInfo[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const metaFile = path.join(squadDir, entry.name, 'meta.toml');
      if (fs.existsSync(metaFile)) {
        try {
          const meta = toml.parse(
            fs.readFileSync(metaFile, 'utf-8'),
          ) as unknown as SquadMeta;
          let completedNodes = 0;
          let totalNodes = 0;

          const dagFile = path.join(squadDir, entry.name, 'dag.toml');
          if (fs.existsSync(dagFile)) {
            const dag = toml.parse(
              fs.readFileSync(dagFile, 'utf-8'),
            ) as unknown as DagState;
            totalNodes = dag.nodes?.names?.length ?? 0;
          }

          const nodesFile = path.join(squadDir, entry.name, 'nodes.toml');
          if (fs.existsSync(nodesFile)) {
            const nodesState = toml.parse(
              fs.readFileSync(nodesFile, 'utf-8'),
            ) as unknown as NodesState;
            completedNodes =
              nodesState.nodes?.filter((n) => n.status === 'completed')
                .length ?? 0;
            if (totalNodes === 0) {
              totalNodes = nodesState.nodes?.length ?? 0;
            }
          }

          list.push({
            timestamp: entry.name,
            intent: meta.intent,
            directory: meta.directory,
            status: meta.status,
            size: meta.size,
            completedNodes,
            totalNodes,
          });
        } catch (_e) {
          // ignore corrupted checkpoint
        }
      }
    }
  }

  // Sort by timestamp descending
  return list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
