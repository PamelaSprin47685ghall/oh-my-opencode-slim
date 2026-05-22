import { log } from '../utils/logger';

const HEAD_TAIL_PIPE_RE =
  /\s*\|\s*(head|tail)\s+(?:-n\s*|-)\d+(?=\s*(?:[;&\n#]|$))/g;

export interface StrippedPipe {
  pipe: string;
  name: string;
  count: number;
}

export interface StripResult {
  script: string;
  stripped: StrippedPipe[];
}

export function stripHeadTailPipes(script: string): StripResult {
  const stripped: StrippedPipe[] = [];
  let current = script;
  while (true) {
    let replaced = false;
    const next = current.replace(HEAD_TAIL_PIPE_RE, (match, name: string) => {
      const count = parseInt(/\d+/.exec(match)?.[0] ?? '0', 10);
      stripped.unshift({ pipe: match.trim(), name, count });
      replaced = true;
      return '';
    });
    if (!replaced) break;
    current = next;
  }
  return { script: current, stripped };
}

/**
 * Create a `tool.execute.before` hook that transparently strips
 * `| head -n N` / `| tail -n N` pipe truncations from bash commands
 * before they reach the execute handler.
 *
 * This prevents model-generated commands from silently truncating
 * output that the agent needs to see for correct analysis.
 *
 * Per the PRD, the wrapper is transparent: no notes or warnings
 * are appended to the output. Background process results are skipped.
 */
export function createHeadTailStrippingHook() {
  return {
    'tool.execute.before': async (
      input: { tool: string },
      output: { args?: Record<string, unknown> },
    ): Promise<void> => {
      if (input.tool !== 'bash') return;

      const args = output.args;
      if (!args || typeof args.command !== 'string') return;

      const { script: cleaned, stripped } = stripHeadTailPipes(
        args.command as string,
      );
      if (stripped.length > 0) {
        args.command = cleaned;
        log('[no-head-tail] stripped pipes from bash command', {
          stripped: stripped.map((s) => s.pipe),
        });
      }
    },
  };
}
