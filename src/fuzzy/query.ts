import path from 'node:path';

export function normalizePathConstraint(
  pathConstraint: string,
  cwd = process.cwd(),
): string | null {
  let trimmed = pathConstraint.trim();
  if (!trimmed) return trimmed;

  if (path.isAbsolute(trimmed)) {
    const relative = path.relative(cwd, trimmed).replaceAll(path.sep, '/');
    if (relative === '') return null;
    if (
      relative.startsWith('../') ||
      relative === '..' ||
      path.isAbsolute(relative)
    ) {
      return null;
    }
    trimmed = relative;
  }

  if (trimmed === '.' || trimmed === './') return null;
  if (trimmed.startsWith('./')) trimmed = trimmed.slice(2);

  const recursiveDir = /^(.*)\/\*\*(?:\/\*)?$/.exec(trimmed);
  if (recursiveDir) {
    const dir = recursiveDir[1];
    if (dir && !/[*?[{]/.test(dir)) return `${dir}/`;
  }

  if (trimmed.startsWith('/') || trimmed.endsWith('/')) return trimmed;
  if (/[*?[{]/.test(trimmed)) return trimmed;
  const lastSegment = trimmed.split('/').pop() ?? '';
  if (/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)) return trimmed;
  return `${trimmed}/`;
}

export function normalizeExcludes(
  exclude: string | string[] | undefined | null,
  cwd = process.cwd(),
): string[] {
  if (!exclude) return [];
  const list = Array.isArray(exclude) ? exclude : [exclude];
  const out: string[] = [];
  for (const raw of list) {
    const parts = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const stripped = p.startsWith('!') ? p.slice(1) : p;
      const normalized = normalizePathConstraint(stripped, cwd);
      if (normalized) out.push(`!${normalized}`);
    }
  }
  return out;
}

export function buildQuery(
  fpath: string | undefined | null,
  pattern: string,
  exclude: string | string[] | undefined | null,
  cwd = process.cwd(),
  allowExternal = false,
): string {
  const parts: string[] = [];
  if (fpath) {
    if (allowExternal && path.isAbsolute(fpath)) {
      parts.push(fpath);
    } else {
      const pathConstraint = normalizePathConstraint(fpath, cwd);
      if (pathConstraint) parts.push(pathConstraint);
    }
  }
  parts.push(...normalizeExcludes(exclude, cwd));
  parts.push(pattern);
  return parts.join(' ');
}
