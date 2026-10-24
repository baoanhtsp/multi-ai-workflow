import fs from 'node:fs';
import path from 'node:path';
import { ApiValidationError } from '../../lib/validate.ts';
import { validateSafeExistingPath, validateSafeRelativePath } from '../review/git.ts';
import { getProjectGitStatus } from './gitStatus.ts';

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ts: 'ts',
  js: 'js',
  json: 'json',
  md: 'md',
  ps1: 'ps1',
  css: 'css',
  html: 'html',
  py: 'py',
  php: 'php',
  go: 'go',
  rs: 'rs',
  java: 'java',
  cs: 'cs',
  c: 'c',
  cpp: 'cpp',
  sh: 'sh',
  yml: 'yml',
  toml: 'toml',
  sql: 'sql',
  xml: 'xml',
};

const MAX_FILE_READ_BYTES = 1024 * 1024; // 1 MB (SPEC §2.1)
const BINARY_PROBE_BYTES = 8000;

export async function readProjectFile(
  projectPath: string,
  relPathInput: string
): Promise<Record<string, unknown>> {
  const validPath = validateSafeRelativePath(projectPath, relPathInput);
  const realProject = fs.realpathSync.native(projectPath);

  // Validate initial existing path
  const { realPath: initialPath } = validateSafeExistingPath(projectPath, validPath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(initialPath);
  } catch {
    throw new ApiValidationError(`File not found: ${validPath}`, 404);
  }

  if (stat.isDirectory()) {
    throw new ApiValidationError(`Path is a directory: ${validPath}`, 400);
  }

  const size = stat.size;
  const mtime = new Date(stat.mtimeMs).toISOString();

  // Extension language mapping
  const extMatch = /\.([a-zA-Z0-9]+)$/.exec(validPath);
  const ext = extMatch ? extMatch[1]!.toLowerCase() : '';
  const language = EXTENSION_LANGUAGE_MAP[ext] ?? 'text';

  // Git status letter
  const gitStatus = await getProjectGitStatus(realProject);
  const gitLetter = gitStatus.statusMap.get(validPath) ?? '';

  if (size > MAX_FILE_READ_BYTES) {
    return {
      ok: true,
      path: validPath,
      size,
      mtime,
      binary: false,
      too_large: true,
      content: null,
      line_count: 0,
      language,
      git: gitLetter,
    };
  }

  // Re-run realpath.native containment & .git check immediately before opening to eliminate TOCTOU across await getProjectGitStatus
  // (residual race window between check and open is minimal and unavoidable without OS-level openat/O_NOFOLLOW).
  const { realPath: safeFinalPath } = validateSafeExistingPath(projectPath, validPath);

  // Check binary in first 8000 bytes
  const fd = fs.openSync(safeFinalPath, 'r');
  let isBinary = false;
  let probeBuf: Buffer;
  try {
    const probeLen = Math.min(size, BINARY_PROBE_BYTES);
    probeBuf = Buffer.alloc(probeLen);
    const bytesRead = fs.readSync(fd, probeBuf, 0, probeLen, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (probeBuf[i] === 0) {
        isBinary = true;
        break;
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  if (isBinary) {
    return {
      ok: true,
      path: validPath,
      size,
      mtime,
      binary: true,
      too_large: false,
      content: null,
      line_count: 0,
      language,
      git: gitLetter,
    };
  }

  // Read full content as UTF-8
  let rawBuf = fs.readFileSync(safeFinalPath);
  // Strip leading UTF-8 BOM if present
  if (rawBuf.length >= 3 && rawBuf[0] === 0xef && rawBuf[1] === 0xbb && rawBuf[2] === 0xbf) {
    rawBuf = rawBuf.subarray(3);
  }

  const content = rawBuf.toString('utf8');
  const lineCount = content.length === 0 ? 0 : content.split('\n').length;

  return {
    ok: true,
    path: validPath,
    size,
    mtime,
    binary: false,
    too_large: false,
    content,
    line_count: lineCount,
    language,
    git: gitLetter,
  };
}
