import type { FileFinder } from '@ff-labs/fff-node';

// Lazy loader — avoids CJS require() of ESM-only package (@ff-labs/fff-node has no "require" export)
// Uses Function constructor so TypeScript CJS compilation doesn't transform import() to require()
let fffModule: { FileFinder: typeof FileFinder } | null = null;
const fffImport = new Function('spec', 'return import(spec)') as (
  spec: string,
) => Promise<typeof import('@ff-labs/fff-node')>;
async function getFffModule(): Promise<{ FileFinder: typeof FileFinder }> {
  if (!fffModule) {
    fffModule = (await fffImport('@ff-labs/fff-node')) as {
      FileFinder: typeof FileFinder;
    };
  }
  return fffModule;
}

/**
 * FinderManager - Lazy singleton manager for FileFinder instances.
 *
 * Creates one FileFinder per cwd, caches it, and destroys stale instances.
 * All creation/destruction is handled automatically — no explicit lifecycle needed.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: intentional singleton manager
export class FinderManager {
  private static instances = new Map<string, FileFinder>();
  private static pending = new Map<string, Promise<FileFinder>>();

  /**
   * Get or create a FileFinder for the given cwd.
   * The first call per cwd creates and awaits initial scan (15s timeout).
   */
  static async get(cwd: string): Promise<FileFinder> {
    const existing = FinderManager.instances.get(cwd);
    if (existing && !existing.isDestroyed) return existing;

    const pending = FinderManager.pending.get(cwd);
    if (pending) return pending;

    const promise = FinderManager.createFinder(cwd);
    FinderManager.pending.set(cwd, promise);
    try {
      const finder = await promise;
      FinderManager.instances.set(cwd, finder);
      return finder;
    } finally {
      FinderManager.pending.delete(cwd);
    }
  }

  /**
   * Destroy the FileFinder for a specific cwd.
   */
  static destroy(cwd: string): void {
    const finder = FinderManager.instances.get(cwd);
    if (finder && !finder.isDestroyed) {
      try {
        finder.destroy();
      } catch {
        // cleanup best-effort
      }
    }
    FinderManager.instances.delete(cwd);
    FinderManager.pending.delete(cwd);
  }

  /**
   * Destroy all cached FileFinder instances.
   */
  static destroyAll(): void {
    for (const [cwd] of FinderManager.instances) {
      FinderManager.destroy(cwd);
    }
  }

  private static async createFinder(cwd: string): Promise<FileFinder> {
    const { FileFinder } = await getFffModule();
    const result = FileFinder.create({ basePath: cwd, aiMode: true });
    if (!result.ok) {
      throw new Error(`Failed to create FFF file finder: ${result.error}`);
    }
    const finder = result.value;
    try {
      await finder.waitForScan(15000);
    } catch {
      // scan timeout is non-fatal — results still work
    }
    return finder;
  }
}
