import crypto from 'node:crypto';
import { ApiValidationError } from '../../lib/validate.ts';

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
  id: string;
  path: string;
  old_path: string;
  status: 'M' | 'A' | 'D' | 'R' | 'B';
  change?: 'M' | 'A' | 'D' | 'R';
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
const MAX_FILE_DIFF_BYTES_NORMAL = 400 * 1024; // 400 KB
const MAX_FILE_DIFF_BYTES_FULL = 4 * 1024 * 1024; // 4 MB (SPEC §1.2 with full=1 for targetPath)
const MAX_DIFF_FILES = 300;

export function unquoteGitPath(raw: string, stripDiffPrefix: boolean = true): string {
  let s = raw.trim();
  if (s.endsWith('\r')) {
    s = s.slice(0, -1).trim();
  }
  if (s === '/dev/null') {
    return '/dev/null';
  }
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
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
      const code = s.codePointAt(i)!;
      const ch = String.fromCodePoint(code);
      const chBuf = Buffer.from(ch, 'utf8');
      for (let b = 0; b < chBuf.length; b++) {
        bytes.push(chBuf[b]!);
      }
      if (ch.length > 1) {
        i += ch.length - 1;
      }
    }
    s = Buffer.from(bytes).toString('utf8');
  }

  // Only strip leading a/ or b/ when explicitly requested (for diff --git, --- a/, +++ b/)
  if (stripDiffPrefix && (s.startsWith('a/') || s.startsWith('b/'))) {
    s = s.slice(2);
  }
  return s.replace(/\\/g, '/');
}

export function computeHunkId(filePath: string, header: string, rawLines: string[]): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  // Strip trailing \r for stable hashing across platforms
  const cleanHeader = header.endsWith('\r') ? header.slice(0, -1) : header;
  const cleanLines = rawLines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const payload = `${normalizedPath}\n${cleanHeader}\n${cleanLines.join('\n')}`;
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

export function computeFileId(filePath: string, rawDiffText: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const cleanText = rawDiffText
    .split(/\r?\n/)
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    .join('\n');
  const payload = `${normalizedPath}\n${cleanText}`;
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

export function parseUnifiedDiff(
  rawDiffInput: string,
  options?: { full?: boolean; targetPath?: string; untracked?: boolean }
): ParsedDiffResult {
  let raw = rawDiffInput;
  let truncated = false;

  const rawByteLen = Buffer.byteLength(raw, 'utf8');
  if (rawByteLen > MAX_RAW_DIFF_BYTES) {
    truncated = true;
    const buf = Buffer.from(raw, 'utf8').subarray(0, MAX_RAW_DIFF_BYTES);
    raw = buf.toString('utf8');
  }

  // Split on LF only to preserve CR in content
  const rawLines = raw.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  interface RawFileChunk {
    headerLines: string[];
    hunkChunks: Array<{
      header: string;
      lines: string[];
      oldLines: number;
      newLines: number;
      oldStart: number;
      newStart: number;
    }>;
    rawLines: string[];
    isBinary: boolean;
    oldPath: string;
    newPath: string;
    status: 'M' | 'A' | 'D' | 'R' | 'B';
    change?: 'M' | 'A' | 'D' | 'R';
    totalBytes: number;
    totalDiffLines: number;
  }

  const chunks: RawFileChunk[] = [];
  let curChunk: RawFileChunk | null = null;
  let curHunk: {
    header: string;
    lines: string[];
    oldLines: number;
    newLines: number;
    oldStart: number;
    newStart: number;
    seenOld: number;
    seenNew: number;
  } | null = null;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]!;

    // Check for diff command boundary
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
        rawLines: [line],
        isBinary: false,
        oldPath: '',
        newPath: '',
        status: options?.untracked ? 'A' : 'M',
        change: options?.untracked ? 'A' : 'M',
        totalBytes: Buffer.byteLength(line, 'utf8'),
        totalDiffLines: 0,
      };

      const gitMatch = /^diff --(?:git|no-index) (?:--\s+)?("?[^"]+"?|\S+)\s+("?[^"]+"?|\S+)/.exec(line);
      if (gitMatch && curChunk) {
        curChunk.oldPath = unquoteGitPath(gitMatch[1]!, true);
        curChunk.newPath = unquoteGitPath(gitMatch[2]!, true);
      }
      continue;
    }

    if (!curChunk) {
      continue;
    }

    curChunk.rawLines.push(line);
    curChunk.totalBytes += Buffer.byteLength(line, 'utf8') + 1;

    // Check for hunk header
    if (line.startsWith('@@ ')) {
      if (curHunk) {
        curChunk.hunkChunks.push(curHunk);
        curHunk = null;
      }

      const cleanLine = line.endsWith('\r') ? line.slice(0, -1) : line;
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(cleanLine);
      const oldStart = m ? Number.parseInt(m[1]!, 10) : 1;
      const oldLines = m ? (m[2] !== undefined ? Number.parseInt(m[2], 10) : 1) : 1;
      const newStart = m ? Number.parseInt(m[3]!, 10) : 1;
      const newLines = m ? (m[4] !== undefined ? Number.parseInt(m[4], 10) : 1) : 1;

      curHunk = {
        header: line,
        lines: [],
        oldStart,
        oldLines,
        newStart,
        newLines,
        seenOld: 0,
        seenNew: 0,
      };
      curChunk.totalDiffLines++;

      // If oldLines == 0 and newLines == 0, hunk is immediately complete
      if (oldLines === 0 && newLines === 0) {
        if (i + 1 < rawLines.length && rawLines[i + 1]!.startsWith('\\')) {
          curHunk.lines.push(rawLines[++i]!);
          curChunk.totalDiffLines++;
        }
        curChunk.hunkChunks.push(curHunk);
        curHunk = null;
      }
      continue;
    }

    // Inside a hunk: consume strictly by counts
    if (curHunk) {
      const prefix = line[0];
      if (prefix === ' ' || prefix === '-' || prefix === '+' || prefix === '\\') {
        curHunk.lines.push(line);
        curChunk.totalDiffLines++;

        if (prefix === ' ') {
          curHunk.seenOld++;
          curHunk.seenNew++;
        } else if (prefix === '-') {
          curHunk.seenOld++;
        } else if (prefix === '+') {
          curHunk.seenNew++;
        }

        // Check if hunk counts are fulfilled
        if (curHunk.seenOld >= curHunk.oldLines && curHunk.seenNew >= curHunk.newLines) {
          // Check for possible trailing "\ No newline"
          if (i + 1 < rawLines.length && rawLines[i + 1]!.startsWith('\\')) {
            curHunk.lines.push(rawLines[++i]!);
            curChunk.totalDiffLines++;
          }
          curChunk.hunkChunks.push(curHunk);
          curHunk = null;
        }
        continue;
      } else {
        // Line does not start with diff hunk prefix -> hunk ended prematurely
        curChunk.hunkChunks.push(curHunk);
        curHunk = null;
      }
    }

    // Header lines (outside hunks)
    if (line.startsWith('new file mode ')) {
      curChunk.headerLines.push(line);
      curChunk.status = 'A';
      curChunk.change = 'A';
    } else if (line.startsWith('deleted file mode ')) {
      curChunk.headerLines.push(line);
      curChunk.status = 'D';
      curChunk.change = 'D';
    } else if (line.startsWith('rename from ')) {
      curChunk.headerLines.push(line);
      curChunk.oldPath = unquoteGitPath(line.slice(12), false);
      curChunk.status = 'R';
      curChunk.change = 'R';
    } else if (line.startsWith('rename to ')) {
      curChunk.headerLines.push(line);
      curChunk.newPath = unquoteGitPath(line.slice(10), false);
      curChunk.status = 'R';
      curChunk.change = 'R';
    } else if (line.startsWith('copy from ')) {
      curChunk.headerLines.push(line);
      curChunk.oldPath = unquoteGitPath(line.slice(10), false);
      curChunk.status = 'A';
      curChunk.change = 'A';
    } else if (line.startsWith('copy to ')) {
      curChunk.headerLines.push(line);
      curChunk.newPath = unquoteGitPath(line.slice(8), false);
      curChunk.status = 'A';
      curChunk.change = 'A';
    } else if (
      line.startsWith('similarity index ') ||
      line.startsWith('index ') ||
      line.startsWith('old mode ') ||
      line.startsWith('new mode ')
    ) {
      curChunk.headerLines.push(line);
    } else if (line.startsWith('--- ')) {
      curChunk.headerLines.push(line);
      const parsed = unquoteGitPath(line.slice(4), true);
      if (parsed !== '/dev/null') {
        curChunk.oldPath = parsed;
      }
    } else if (line.startsWith('+++ ')) {
      curChunk.headerLines.push(line);
      const parsed = unquoteGitPath(line.slice(4), true);
      if (parsed !== '/dev/null') {
        curChunk.newPath = parsed;
      }
    } else if (line.startsWith('Binary files ') || line.includes('GIT binary patch')) {
      curChunk.headerLines.push(line);
      curChunk.isBinary = true;
      curChunk.status = 'B';
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

    const isFullTarget = Boolean(
      options?.full &&
      options.targetPath &&
      (options.targetPath.toLowerCase() === finalPath.toLowerCase() ||
        options.targetPath.toLowerCase() === finalOldPath.toLowerCase())
    );

    const maxLinesForThisFile = isFullTarget
      ? MAX_FILE_DIFF_LINES_FULL
      : MAX_FILE_DIFF_LINES_NORMAL;
    const maxBytesForThisFile = isFullTarget
      ? MAX_FILE_DIFF_BYTES_FULL
      : MAX_FILE_DIFF_BYTES_NORMAL;

    const isTooLarge =
      chunk.totalDiffLines > maxLinesForThisFile || chunk.totalBytes > maxBytesForThisFile;

    let fileAdditions = 0;
    let fileDeletions = 0;
    const hunks: DiffHunk[] = [];

    if (!isOmitted && !isTooLarge && !chunk.isBinary) {
      for (const rawHunk of chunk.hunkChunks) {
        const header = rawHunk.header;
        const lines: DiffHunkLine[] = [];
        const rawHunkLines: string[] = [];

        for (const l of rawHunk.lines) {
          rawHunkLines.push(l);
          const p = l[0] as ' ' | '-' | '+' | '\\';
          let text = l.slice(1);
          if (text.endsWith('\r')) {
            text = text.slice(0, -1);
          }
          if (p === '+') {
            fileAdditions++;
          } else if (p === '-') {
            fileDeletions++;
          }
          lines.push([p, text]);
        }

        const id = computeHunkId(finalPath, header, rawHunkLines);
        hunks.push({
          id,
          header: header.endsWith('\r') ? header.slice(0, -1) : header,
          old_start: rawHunk.oldStart,
          old_lines: rawHunk.oldLines,
          new_start: rawHunk.newStart,
          new_lines: rawHunk.newLines,
          lines,
          rawLines: rawHunkLines,
        });
      }
    } else if (!chunk.isBinary) {
      for (const rawHunk of chunk.hunkChunks) {
        for (const l of rawHunk.lines) {
          if (l.startsWith('+')) fileAdditions++;
          else if (l.startsWith('-')) fileDeletions++;
        }
      }
    }

    totalAdditions += fileAdditions;
    totalDeletions += fileDeletions;

    const fullRawDiffText = chunk.rawLines.join('\n');
    const fileId = computeFileId(finalPath, fullRawDiffText);

    files.push({
      id: fileId,
      path: finalPath,
      old_path: finalOldPath,
      status: chunk.isBinary ? 'B' : chunk.status,
      change: chunk.change,
      binary: chunk.isBinary,
      untracked: Boolean(options?.untracked),
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
  if (file.too_large || file.omitted) {
    throw new ApiValidationError('Load the full file before rejecting it.', 409);
  }

  const hunksToInclude =
    hunkId === null
      ? file.hunks
      : file.hunks.filter((h) => h.id === hunkId);

  // Pure renames or mode-only changes have no hunks; git apply -R accepts a header-only patch
  if (hunksToInclude.length === 0) {
    const isGenuineRenameOrMode =
      file.status === 'R' ||
      file.headerLines.some(
        (l) =>
          l.startsWith('old mode ') ||
          l.startsWith('new mode ') ||
          l.startsWith('rename from ') ||
          l.startsWith('rename to ')
      );
    if (hunkId === null && isGenuineRenameOrMode && file.headerLines.length > 0) {
      return `${file.headerLines.join('\n')}\n`;
    }
    throw new Error(`Hunk ${hunkId ?? 'all'} not found in file ${file.path}`);
  }

  // Ensure header lines have line endings
  const header = file.headerLines.join('\n');
  const hunksBody = hunksToInclude
    .map((h) => `${h.header}\n${h.rawLines.join('\n')}`)
    .join('\n');

  return `${header}\n${hunksBody}\n`;
}
