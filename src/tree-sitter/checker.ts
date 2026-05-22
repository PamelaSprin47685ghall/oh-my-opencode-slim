import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const localRequire = createRequire(
  typeof __filename !== 'undefined' ? __filename : '',
);

/**
 * Lazy-loaded language pack — the NAPI native module may not be available
 * in all environments (e.g., bun test on musl-incompatible hosts), so we
 * defer loading until first syntax check call.
 */
let languagePack: typeof import('@kreuzberg/tree-sitter-language-pack') | null =
  null;

async function getLanguagePack(): Promise<
  typeof import('@kreuzberg/tree-sitter-language-pack')
> {
  if (!languagePack) {
    try {
      languagePack = await import('@kreuzberg/tree-sitter-language-pack');
    } catch (err) {
      // Node.js v25+ doesn't populate glibcVersion in process.report, causing
      // the language pack's isMusl() to misdetect glibc as musl on linux.
      // Assume glibc and load the gnu binary directly.
      if (process.platform === 'linux') {
        const pkgDir = dirname(
          localRequire.resolve(
            '@kreuzberg/tree-sitter-language-pack/package.json',
          ),
        );
        const childRequire = createRequire(join(pkgDir, 'package.json'));
        try {
          languagePack = childRequire(
            join(pkgDir, `ts-pack-core-node.linux-${process.arch}-gnu.node`),
          );
          return languagePack as NonNullable<typeof languagePack>;
        } catch {
          /* fall through to throw */
        }
      }
      throw err;
    }
  }
  return languagePack;
}

export interface SyntaxError {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: string;
  message: string;
}

export interface SyntaxCheckOk {
  ok: true;
  lang: string;
  errors: SyntaxError[];
}

export interface SyntaxCheckFail {
  ok: false;
  reason: string;
}

export type SyntaxCheckResult = SyntaxCheckOk | SyntaxCheckFail;

const initPromises = new Map<string, Promise<void>>();

async function ensureLanguage(
  lang: string,
  lp: typeof import('@kreuzberg/tree-sitter-language-pack'),
): Promise<void> {
  if (lp.hasLanguage?.(lang)) return;

  let promise = initPromises.get(lang);
  if (!promise) {
    promise = (async () => {
      try {
        lp.init({ languages: [lang] });
      } catch {
        // Download failure is non-fatal — caller handles silently.
      }
    })();
    initPromises.set(lang, promise);
  }
  await promise;
}

export async function checkSyntax(
  content: string,
  filePath: string,
): Promise<SyntaxCheckResult> {
  let lp: typeof import('@kreuzberg/tree-sitter-language-pack');
  try {
    lp = await getLanguagePack();
  } catch (err) {
    return { ok: false, reason: `failed to load native language pack: ${err}` };
  }

  const lang = lp.detectLanguageFromPath(filePath);
  if (!lang) return { ok: false, reason: `unsupported language: ${filePath}` };

  try {
    await ensureLanguage(lang, lp);
  } catch {
    return { ok: false, reason: `init failed for ${lang}` };
  }

  try {
    const result = lp.process(content, {
      language: lang,
      diagnostics: true,
    });
    if (!result || typeof result !== 'object') {
      return { ok: false, reason: 'native process returned unexpected value' };
    }
    interface ProcessDiagnostic {
      span: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
      };
      severity: string;
      message: string;
    }
    const diags: ProcessDiagnostic[] =
      (result as { diagnostics?: ProcessDiagnostic[] }).diagnostics ?? [];

    if (diags.length === 0) return { ok: true, errors: [], lang };

    return {
      ok: true,
      lang,
      errors: diags.map((d) => ({
        line: d.span.startLine + 1,
        column: d.span.startColumn + 1,
        endLine: d.span.endLine + 1,
        endColumn: d.span.endColumn + 1,
        severity: d.severity,
        message: d.message,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      reason: `parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
