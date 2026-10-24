import crypto from 'node:crypto';

export type DiffHunkLine = [prefix: ' ' | '-' | '+' | '\\', text: string];

export interface DiffHunk {
  id: string;
  header: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffHunkLine[];
  rawLines: string[];
}

export interface DiffFile {
  path: string;
  old_path: string;
  status: 'M' | 'A' | 'D' | 'R' | 'B';
  binary: boolean;
  untracked: boolean;
  too_large: boolean;
  omitted: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  headerLines: string[];
}

export interface ParsedDiffResult {
  truncated: boolean;
  stats: {
    files: number;
    additions: number;
    deletions: number;
  };
  files: DiffFile[];
}

const MAX_RAW_DIFF_BYTES = 5 * 1024 * 1024; // 5 MB (SPEC §1.2)
const MAX_FILE_DIFF_LINES_NORMAL = 3000;
const MAX_FILE_DIFF_LINES_FULL = 20000;
const MAX_FILE_DIFF_BYTES = 400 * 1024; // 400 KB
const MAX_DIFF_FILES = 300;

export function unquoteGitPath(raw: string): string {
  let s = raw.trim();
  if (s === '/dev/null') {
    return '/dev/null';
  }
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
    // Unescape octal bytes first to handle UTF-8 sequences
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && i + 1 < s.length) {
        const next = s[i + 1]!;
        if (next >= '0' && next <= '7') {
          let oct = next;
          let j = i + 2;
          while (j < s.length && j < i + 4 && s[j]! >= '0' && s[j]! <= '7') {
            oct += s[j]!;
            j++;
          }
          bytes.push(Number.parseInt(oct, 8));
          i = j - 1;
          continue;
        }
        if (next === 'n') {
          bytes.push(10);
          i++;
          continue;
        }
        if (next === 'r') {
          bytes.push(13);
          i++;
          continue;
        }
        if (next === 't') {
          bytes.push(9);
          i++;
          continue;
        }
        if (next === 'b') {
          bytes.push(8);
          i++;
          continue;
        }
        if (next === 'f') {
          bytes.push(12);
          i++;
          continue;
        }
        if (next === 'v') {
          bytes.push(11);
          i++;
          continue;
        }
        if (next === '\\' || next === '"') {
          bytes.push(next.charCodeAt(0));
          i++;
          continue;
        }
      }
      bytes.push(s.charCodeAt(i));
    }
    s = Buffer.from(bytes).toString('utf8');
  }

  // Strip leading a/ or b/
  if (s.startsWith('a/') || s.startsWith('b/')) {
    s = s.slice(2);
  }
  return s.replace(/\\/g, '/');
}

export function computeHunkId(filePath: string, header: string, rawLines: string[]): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const payload = `${normalizedPath}\n${header}\n${rawLines.join('\n')}`;
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

export function parseUnifiedDiff(
  rawDiffInput: string,
  options?: { full?: boolean; targetPath?: string }
): ParsedDiffResult {
  let raw = rawDiffInput;
  let truncated = false;

  const rawByteLen = Buffer.byteLength(raw, 'utf8');
  if (rawByteLen > MAX_RAW_DIFF_BYTES) {
    truncated = true;
    const buf = Buffer.from(raw, 'utf8').subarray(0, MAX_RAW_DIFF_BYTES);
    raw = buf.toString('utf8');
  }

  // Normalize CRLF to LF for parsing
  const rawLines = raw.replace(/\r\n/g, '\n').split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  interface RawFileChunk {
    headerLines: string[];
    hunkChunks: Array<{ header: string; lines: string[] }>;
    isBinary: boolean;
    oldPath: string;
    newPath: string;
    status: 'M' | 'A' | 'D' | 'R' | 'B';
    totalBytes: number;
    totalDiffLines: number;
  }

  const chunks: RawFileChunk[] = [];
  let curChunk: RawFileChunk | null = null;
  let curHunk: { header: string; lines: string[] } | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;

    if (line.startsWith('diff --git ') || line.startsWith('diff --no-index ')) {
      if (curChunk) {
        if (curHunk) {
          curChunk.hunkChunks.push(curHunk);
          curHunk = null;
        }
        chunks.push(curChunk);
      }

      curChunk = {
        headerLines: [line],
        hunkChunks: [],
        isBinary: false,
        oldPath: '',
        newPath: '',
        status: 'M',
        totalBytes: Buffer.byteLength(line, 'utf8'),
        totalDiffLines: 0,
      };

      // Try to parse diff --git a/... b/...
      const gitMatch = /^diff --(?:git|no-index) (?:--\s+)?("?[^"]+"?|\S+)\s+("?[^"]+"?|\S+)$/.exec(line);
      if (gitMatch) {
        curChunk.oldPath = unquoteGitPath(gitMatch[1]!);
        curChunk.newPath = unquoteGitPath(gitMatch[2]!);
      }
      continue;
    }

    if (!curChunk) {
      // Diff header before first diff command, ignore
      continue;
    }

    curChunk.totalBytes += Buffer.byteLength(line, 'utf8') + 1;

    if (line.startsWith('new file mode ')) {
      curChunk.headerLines.push(line);
      curChunk.status = 'A';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      curChunk.headerLines.push(line);
      curChunk.status = 'D';
      continue;
    }
    if (line.startsWith('rename from ')) {
      curChunk.headerLines.push(line);
      curChunk.oldPath = unquoteGitPath(line.slice(12));
      curChunk.status = 'R';
      continue;
    }
    if (line.startsWith('rename to ')) {
      curChunk.headerLines.push(line);
      curChunk.newPath = unquoteGitPath(line.slice(10));
      curChunk.status = 'R';
      continue;
    }
    if (line.startsWith('similarity index ') || line.startsWith('index ') || line.startsWith('old mode ') || line.startsWith('new mode ')) {
      curChunk.headerLines.push(line);
      continue;
    }
    if (line.startsWith('--- ')) {
      curChunk.headerLines.push(line);
      const parsed = unquoteGitPath(line.slice(4));
      if (parsed !== '/dev/null') {
        curChunk.oldPath = parsed;
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      curChunk.headerLines.push(line);
      const parsed = unquoteGitPath(line.slice(4));
      if (parsed !== '/dev/null') {
        curChunk.newPath = parsed;
      }
      continue;
    }
    if (line.startsWith('Binary files ') || line.includes('GIT binary patch')) {
      curChunk.headerLines.push(line);
      curChunk.isBinary = true;
      curChunk.status = 'B';
      continue;
    }

    if (line.startsWith('@@ ')) {
      if (curHunk) {
        curChunk.hunkChunks.push(curHunk);
      }
      curHunk = {
        header: line,
        lines: [],
      };
      curChunk.totalDiffLines++;
      continue;
    }

    if (curHunk) {
      curHunk.lines.push(line);
      curChunk.totalDiffLines++;
    } else {
      curChunk.headerLines.push(line);
    }
  }

  if (curChunk) {
    if (curHunk) {
      curChunk.hunkChunks.push(curHunk);
    }
    chunks.push(curChunk);
  }

  const files: DiffFile[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
    const chunk = chunks[cIdx]!;
    const finalPath = chunk.newPath || chunk.oldPath;
    const finalOldPath = chunk.oldPath || chunk.newPath;
    const isOmitted = cIdx >= MAX_DIFF_FILES;

    const maxLinesForThisFile =
      options?.full && options.targetPath && options.targetPath === finalPath
        ? MAX_FILE_DIFF_LINES_FULL
        : MAX_FILE_DIFF_LINES_NORMAL;

    const isTooLarge =
      chunk.totalDiffLines > maxLinesForThisFile || chunk.totalBytes > MAX_FILE_DIFF_BYTES;

    let fileAdditions = 0;
    let fileDeletions = 0;
    const hunks: DiffHunk[] = [];

    if (!isOmitted && !isTooLarge && !chunk.isBinary) {
      for (const rawHunk of chunk.hunkChunks) {
        const header = rawHunk.header;
        const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header);
        const oldStart = hunkMatch ? Number.parseInt(hunkMatch[1]!, 10) : 1;
        const oldLines = hunkMatch ? (hunkMatch[2] !== undefined ? Number.parseInt(hunkMatch[2], 10) : 1) : 0;
        const newStart = hunkMatch ? Number.parseInt(hunkMatch[3]!, 10) : 1;
        const newLines = hunkMatch ? (hunkMatch[4] !== undefined ? Number.parseInt(hunkMatch[4], 10) : 1) : 0;

        const lines: DiffHunkLine[] = [];
        const rawHunkLines: string[] = [];

        for (const l of rawHunk.lines) {
          rawHunkLines.push(l);
          if (l.startsWith('+')) {
            fileAdditions++;
            lines.push(['+', l.slice(1)]);
          } else if (l.startsWith('-')) {
            fileDeletions++;
            lines.push(['-', l.slice(1)]);
          } else if (l.startsWith('\\')) {
            lines.push(['\\', l.slice(1)]);
          } else if (l.startsWith(' ')) {
            lines.push([' ', l.slice(1)]);
          } else {
            // Some diffs might have empty context line represented as empty string
            lines.push([' ', l]);
          }
        }

        const id = computeHunkId(finalPath, header, rawHunkLines);
        hunks.push({
          id,
          header,
          old_start: oldStart,
          old_lines: oldLines,
          new_start: newStart,
          new_lines: newLines,
          lines,
          rawLines: rawHunkLines,
        });
      }
    } else if (!chunk.isBinary) {
      // Calculate approximate additions/deletions even if hunks omitted
      for (const rawHunk of chunk.hunkChunks) {
        for (const l of rawHunk.lines) {
          if (l.startsWith('+')) fileAdditions++;
          else if (l.startsWith('-')) fileDeletions++;
        }
      }
    }

    totalAdditions += fileAdditions;
    totalDeletions += fileDeletions;

    files.push({
      path: finalPath,
      old_path: finalOldPath,
      status: chunk.isBinary ? 'B' : chunk.status,
      binary: chunk.isBinary,
      untracked: false,
      too_large: isTooLarge,
      omitted: isOmitted,
      additions: fileAdditions,
      deletions: fileDeletions,
      hunks: isOmitted || isTooLarge ? [] : hunks,
      headerLines: chunk.headerLines,
    });
  }

  return {
    truncated,
    stats: {
      files: files.length,
      additions: totalAdditions,
      deletions: totalDeletions,
    },
    files,
  };
}

export function buildHunkPatch(file: DiffFile, hunkId: string | null): string {
  const hunksToInclude =
    hunkId === null
      ? file.hunks
      : file.hunks.filter((h) => h.id === hunkId);

  if (hunksToInclude.length === 0) {
    throw new Error(`Hunk ${hunkId ?? 'all'} not found in file ${file.path}`);
  }

  // Prepare header
  const header = file.headerLines.join('\n');
  const hunksBody = hunksToInclude
    .map((h) => `${h.header}\n${h.rawLines.join('\n')}`)
    .join('\n');

  return `${header}\n${hunksBody}\n`;
}
