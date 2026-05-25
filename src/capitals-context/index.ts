import fs from 'node:fs';
import path from 'node:path';

const CAPS_FILE_RE = /^[A-Z][A-Z0-9_]*\.md$/;
const CAPS_DIR_RE = /^[A-Z][A-Z0-9_]*$/;
const EXCLUDED_FILE_NAMES = new Set(['AGENTS.md', 'CLAUDE.md', 'README.md']);
const EXCLUDED_DIR_NAMES = new Set(['AGENTS', 'CLAUDE', 'NODE_MODULES']);

export interface CapsFileInfo {
  /** Absolute path to the file */
  filePath: string;
  /** Display label used in context (relative path from project root) */
  label: string;
  /** File content */
  content: string;
}

/**
 * Scan project root for ALL_CAPS.md files and ALL_CAPS/ directories,
 * returning their content as CapsFileInfo[].
 *
 * Root: only ALL_CAPS.md files (not ALL_CAPS.txt etc.)
 * Dirs: ALL files inside ALL_CAPS/ directories (not just .md)
 */
export function findCapsFiles(projectRoot: string): CapsFileInfo[] {
  const results: CapsFileInfo[] = [];

  let rootEntries: string[];
  try {
    rootEntries = fs.readdirSync(projectRoot);
  } catch {
    return results;
  }

  for (const entry of rootEntries) {
    const fullPath = path.join(projectRoot, entry);

    if (CAPS_FILE_RE.test(entry) && !EXCLUDED_FILE_NAMES.has(entry)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        if (content.trim()) {
          results.push({ filePath: fullPath, label: entry, content });
        }
      } catch {
        // skip unreadable files
      }
    }

    if (CAPS_DIR_RE.test(entry) && !EXCLUDED_DIR_NAMES.has(entry)) {
      const stat = tryStat(fullPath);
      if (stat?.isDirectory()) {
        const dirFiles = discoverFilesInDir(fullPath);
        for (const filePath of dirFiles) {
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            if (content.trim()) {
              results.push({
                filePath,
                label: path.relative(projectRoot, filePath),
                content,
              });
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    }
  }

  results.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return results;
}

function tryStat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Discover ALL files inside a directory recursively (not just .md).
 * This is the key change from the old implementation which only
 * discovered .md files.
 */
function discoverFilesInDir(dirPath: string): string[] {
  const files: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        files.push(fullPath);
      } else if (entry.isDirectory()) {
        files.push(...discoverFilesInDir(fullPath));
      }
    }
  } catch {
    // skip unreadable directories
  }
  return files;
}

/**
 * Build a single concatenated context string from all ALL_CAPS sources
 * found in the project root. Returns empty string when nothing is found.
 */
export function buildCapitalsContext(projectRoot: string): string {
  const files = findCapsFiles(projectRoot);
  if (files.length === 0) return '';

  const parts: string[] = [];
  for (const file of files) {
    parts.push(
      `<caps-context file="${file.label}">\n${file.content}\n</caps-context>`,
    );
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Plugin hook: inject capitals context into system prompt
// ---------------------------------------------------------------------------

export interface CapitalsContextHook {
  handleSystemTransform: (
    input: { sessionID?: string },
    output: { system: string[] },
  ) => void;
}

/**
 * Create a hook that injects capitals-context files into the system prompt.
 * The context is scanned once and cached for the lifetime of the hook.
 * Call `refresh()` to invalidate the cache (e.g. on file change events).
 */
export function createCapitalsContextHook(
  projectRoot: string,
): CapitalsContextHook {
  let cachedContext: string | null = null;

  return {
    handleSystemTransform(
      _input: { sessionID?: string },
      output: { system: string[] },
    ): void {
      if (cachedContext === null) {
        cachedContext = buildCapitalsContext(projectRoot);
      }
      if (!cachedContext) return;

      // Avoid duplicate injection
      const marker = '<caps-context';
      if (
        output.system.some((s) => typeof s === 'string' && s.includes(marker))
      )
        return;

      output.system.push(cachedContext);
    },
  };
}
