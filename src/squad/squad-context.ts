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

/** Nudge configuration for squad child sessions. */
export interface NudgeConfig {
/** Maximum number of nudges before giving up and using a default report. Default: 20. */
  maxNudges: number;
  }
 
  /** Default nudge configuration. */
  export const DEFAULT_NUDGE_CONFIG: NudgeConfig = {
  maxNudges: 20,
};

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
  /**
   * The promise returned by client.session.prompt() for this child.
   * Resolves when the child session finishes (either with or without
   * calling the report tool). Used to detect silent endings.
   */
  promptPromise?: Promise<void>;
  /**
   * Replace promptPromise with a new Promise so we can detect the
   * next silent ending. Each call creates a fresh Promise+resolve pair
   * and stores the resolve in promptResolve.
   */
  resetPromptPromise?: () => void;
  /**
   * Resolve function for the current promptPromise. When the prompt
   * (or nudge prompt) completes, we call promptResolve() so the
   * awaitReportInternal race can detect the silent ending.
   */
  promptResolve?: () => void;
  /** Number of nudges sent so far. Incremented on each nudge, checked against maxNudges. */
  nudgeCount: number;
  /** Nudge config for this session. Falls back to DEFAULT_NUDGE_CONFIG. */
  nudgeConfig?: NudgeConfig;
  /**
   * Set to true when nudgeCount >= maxNudges and a default report was used.
   * Callers (e.g. withReviewLoop) should skip review for exhausted sessions
   * because the child is dead and cannot revise.
   */
  nudgeExhausted?: boolean;
}

/**
 * Global registry of squad sessions, keyed by child session ID.
 *
 * The orchestrator registers a session before prompting the child,
 * and the report tool's execute() looks up its context here.
 */
export const squadSessions = new Map<string, SquadSession>();
