export function generateUnifiedDiff(
  oldPath: string,
  newPath: string,
  oldText: string,
  newText: string,
  contextLines = 3
): string {
  // If identical, no diff
  if (oldText === newText) {
    return '';
  }

  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const m = oldLines.length;
  const n = newLines.length;

  // Max line count guard for LCS table memory
  if (m > 5000 || n > 5000) {
    return `--- ${oldPath}\n+++ ${newPath}\n@@ -1,${m} +1,${n} @@\n[File too large for inline diff]`;
  }

  // Dynamic programming LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (oldLines[i] === newLines[j]) {
        dp[i + 1]![j + 1] = dp[i]![j]! + 1;
      } else {
        dp[i + 1]![j + 1] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  // Backtrack to find edit script with line numbering
  interface Edit {
    type: 'keep' | 'add' | 'del';
    text: string;
    oldLine?: number; // 1-based line number in old
    newLine?: number; // 1-based line number in new
  }

  const edits: Edit[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      edits.push({ type: 'keep', text: oldLines[i - 1]!, oldLine: i, newLine: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      edits.push({ type: 'add', text: newLines[j - 1]!, newLine: j });
      j--;
    } else if (i > 0) {
      edits.push({ type: 'del', text: oldLines[i - 1]!, oldLine: i });
      i--;
    }
  }

  edits.reverse();

  // Find all indices of change edits ('del' or 'add')
  const changeIndices: number[] = [];
  for (let k = 0; k < edits.length; k++) {
    if (edits[k]!.type !== 'keep') {
      changeIndices.push(k);
    }
  }

  if (changeIndices.length === 0) {
    return '';
  }

  // Group change indices into hunk ranges [startEditIdx, endEditIdx]
  interface HunkRange {
    start: number;
    end: number;
  }
  const hunkRanges: HunkRange[] = [];
  let currentHunk: HunkRange = {
    start: Math.max(0, changeIndices[0]! - contextLines),
    end: Math.min(edits.length - 1, changeIndices[0]! + contextLines),
  };

  for (let c = 1; c < changeIndices.length; c++) {
    const idx = changeIndices[c]!;
    const nextStart = Math.max(0, idx - contextLines);
    const nextEnd = Math.min(edits.length - 1, idx + contextLines);

    if (nextStart <= currentHunk.end + 1) {
      // Overlapping or adjacent context: merge hunks
      currentHunk.end = nextEnd;
    } else {
      hunkRanges.push(currentHunk);
      currentHunk = { start: nextStart, end: nextEnd };
    }
  }
  hunkRanges.push(currentHunk);

  // Render unified diff with standard @@ -a,b +c,d @@ headers
  const outputLines: string[] = [
    `--- ${oldPath}`,
    `+++ ${newPath}`,
  ];

  for (const range of hunkRanges) {
    const hunkEdits = edits.slice(range.start, range.end + 1);
    let oldCount = 0;
    let newCount = 0;
    let oldStart: number | null = null;
    let newStart: number | null = null;

    for (const edit of hunkEdits) {
      if (edit.type === 'keep') {
        oldCount++;
        newCount++;
        if (oldStart === null && edit.oldLine !== undefined) oldStart = edit.oldLine;
        if (newStart === null && edit.newLine !== undefined) newStart = edit.newLine;
      } else if (edit.type === 'del') {
        oldCount++;
        if (oldStart === null && edit.oldLine !== undefined) oldStart = edit.oldLine;
      } else if (edit.type === 'add') {
        newCount++;
        if (newStart === null && edit.newLine !== undefined) newStart = edit.newLine;
      }
    }

    if (oldStart === null) oldStart = 1;
    if (newStart === null) newStart = 1;

    outputLines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const edit of hunkEdits) {
      if (edit.type === 'keep') {
        outputLines.push(` ${edit.text}`);
      } else if (edit.type === 'del') {
        outputLines.push(`-${edit.text}`);
      } else if (edit.type === 'add') {
        outputLines.push(`+${edit.text}`);
      }
    }
  }

  return outputLines.join('\n');
}
