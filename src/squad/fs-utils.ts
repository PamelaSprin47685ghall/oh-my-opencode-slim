export async function readAffectedFiles(
  affectedFiles: string[],
  _cwd: string,
): Promise<string> {
  if (affectedFiles.length === 0) return '(无受影响文件)';
  return affectedFiles.map((f) => `- ${f}`).join('\n');
}
