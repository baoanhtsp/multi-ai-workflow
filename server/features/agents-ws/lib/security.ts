import fs from 'node:fs';
import path from 'node:path';
import { ApiValidationError } from '../../../lib/validate.ts';

export function assertSafeProjectMawWrite(
  projectPath: string,
  subPath: string,
  projectsRoot?: string
): string {
  if (!projectPath || !fs.existsSync(projectPath)) {
    throw new ApiValidationError('Project directory does not exist or is invalid.', 400);
  }

  // 1. Resolve real path of the project directory
  let realProject: string;
  try {
    realProject = fs.realpathSync.native
      ? fs.realpathSync.native(projectPath)
      : fs.realpathSync(projectPath);
  } catch (err: unknown) {
    throw new ApiValidationError(
      `Could not resolve real path of project: ${err instanceof Error ? err.message : String(err)}`,
      400
    );
  }

  // 2. If projectsRoot is provided, ensure realProject is within real projectsRoot
  if (projectsRoot && fs.existsSync(projectsRoot)) {
    try {
      const realRoot = fs.realpathSync.native
        ? fs.realpathSync.native(projectsRoot)
        : fs.realpathSync(projectsRoot);
      const relToRoot = path.relative(realRoot.toLowerCase(), realProject.toLowerCase());
      if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
        throw new ApiValidationError('Project directory escapes projects root.', 400);
      }
    } catch (err: unknown) {
      if (err instanceof ApiValidationError) throw err;
      throw new ApiValidationError('Failed to verify projectsRoot boundary.', 400);
    }
  }

  const targetFile = path.resolve(projectPath, subPath);
  const normRealProject = realProject.replace(/\\/g, '/').toLowerCase();

  // 3. Walk all existing path components of targetFile and check their real paths
  let current = targetFile;
  while (current && current.length >= projectPath.length) {
    if (fs.existsSync(current)) {
      try {
        const realCurrent = fs.realpathSync.native
          ? fs.realpathSync.native(current)
          : fs.realpathSync(current);
        const normRealCurrent = realCurrent.replace(/\\/g, '/').toLowerCase();

        // Must stay inside realProject directory
        const isInside =
          normRealCurrent === normRealProject ||
          (normRealCurrent.startsWith(normRealProject) &&
            normRealCurrent[normRealProject.length] === '/');

        if (!isInside) {
          throw new ApiValidationError(
            'Target path escapes project directory via junction/symlink.',
            400
          );
        }
      } catch (err: unknown) {
        if (err instanceof ApiValidationError) throw err;
        throw new ApiValidationError('Failed to resolve component real path.', 400);
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return targetFile;
}
