import type { SquadReport, SquadStage } from './schemas';

/**
 * Deferred — a one-shot promise that resolves when the child calls
 * its stage-specific report tool. The orchestrator awaits this to
 * receive the report, then resolves the gate to signal accept/reject.
 */
export class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  private _isResolved = false;

  constructor() {
    this.promise = new Promise<T>((r) => {
      this.resolve = (val: T) => {
        if (this._isResolved) return;
        this._isResolved = true;
        r(val);
      };
    });
  }
}

/**
 * Gate verdict — the orchestrator's decision after reviewing a report.
 *
 * accept: child's report is accepted, the tool returns success.
 * reject: child must revise — feedback is returned as the tool result.
 */
export type GateVerdict =
  | { accepted: true }
  | { accepted: false; feedback: string };

/**
 * SquadSession — per-child-session state shared between the orchestrator
 * (which awaits the report) and the report tool (which resolves it).
 *
 * Registered in SquadSessionMap before the child session is prompted,
 * so the tool's execute() can look up its context by sessionID.
 */
export interface SquadSession {
  parentWorkspaceId: string;
  childSessionId: string;
  stage: SquadStage;
  /** Shared store keyed by session ID; orchestrator reads from here after gate. */
  structuredStore: Map<string, SquadReport>;
  nodeName?: string;
  /** Resolved by the report tool when the child submits a valid report. */
  nextReport: Deferred<void>;
  /** Resolved by the orchestrator to signal accept/reject. */
  gate?: {
    resolve: (verdict: GateVerdict) => void;
  };
  disposed?: boolean;
}

/**
 * Global registry of squad sessions, keyed by child session ID.
 *
 * The orchestrator registers a session before prompting the child,
 * and the report tool's execute() looks up its context here.
 */
export const squadSessions = new Map<string, SquadSession>();
