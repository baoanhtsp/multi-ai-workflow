import fs from 'node:fs';
import path from 'node:path';
import { badRequest, notFound, writeJsonAtomic } from '../tasks/lib.ts';

export interface PlaybookItem {
  line: number;
  text: string;
  checked: boolean;
  section: string;
}

export function validatePlaybookFile(
  projectPath: string,
  rawFile: string
): string {
  const normProject = path.resolve(projectPath).replace(/\\+$/, '');
  let resolved: string;

  if (path.isAbsolute(rawFile)) {
    resolved = path.resolve(rawFile);
  } else {
    resolved = path.resolve(normProject, rawFile);
  }

  // Check extension
  if (!resolved.toLowerCase().endsWith('.md')) {
    throw badRequest('Playbook file must have .md extension.');
  }

  const normResolved = resolved.replace(/\\+$/, '').toLowerCase();
  const normBase = normProject.toLowerCase();
  if (!normResolved.startsWith(normBase + '\\') && normResolved !== normBase) {
    throw badRequest(`Playbook file '${rawFile}' must be inside project.`);
  }

  // Case-insensitive boundary check
  try {
    const realProj = fs.realpathSync(normProject).toLowerCase();
    if (!fs.existsSync(resolved)) {
      throw notFound(`Playbook file not found: ${rawFile}`);
    }
    const realFile = fs.realpathSync(resolved).toLowerCase();
    if (
      !realFile.startsWith(realProj + '\\') &&
      !realFile.startsWith(realProj + '/') &&
      realFile !== realProj
    ) {
      throw badRequest(`Playbook file '${rawFile}' must be inside project.`);
    }

    const st = fs.statSync(resolved);
    if (st.size > 512 * 1024) {
      throw badRequest('Playbook file exceeds 512 KB limit.');
    }

    return resolved;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ApiValidationError') {
      throw err;
    }
    throw notFound(`Playbook file not found or inaccessible: ${rawFile}`);
  }
}

export function parsePlaybookContent(content: string): PlaybookItem[] {
  const lines = content.split(/\r?\n/);
  const items: PlaybookItem[] = [];

  let currentSection = 'General';
  let i = 0;

  while (i < lines.length) {
    const lineStr = lines[i]!;
    const trimmed = lineStr.trim();

    // Check heading
    const headingMatch = /^#{1,6}\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      currentSection = headingMatch[1]!.trim();
      i++;
      continue;
    }

    // Check bullet list item with checkbox
    const itemMatch = /^(\s*)[-*]\s+\[([ xX])\]\s*(.*)$/.exec(lineStr);
    if (itemMatch) {
      const lineNum = i + 1; // 1-based
      const bulletIndent = itemMatch[1]!.length;
      const checked = itemMatch[2]!.toLowerCase() === 'x';
      const textParts: string[] = [itemMatch[3]!.trim()];

      // Look ahead for continuation lines
      i++;
      while (i < lines.length) {
        const nextLine = lines[i]!;
        const nextTrimmed = nextLine.trim();

        // Stop on empty line, heading, or new bullet item
        if (
          nextTrimmed === '' ||
          /^#{1,6}\s+/.test(nextTrimmed) ||
          /^\s*[-*]\s+\[[ xX]\]/.test(nextLine)
        ) {
          break;
        }

        // Must be indented deeper than the bullet
        const nextIndent = (nextLine.match(/^(\s*)/)?.[1] ?? '').length;
        if (nextIndent > bulletIndent) {
          textParts.push(nextTrimmed);
          i++;
        } else {
          break;
        }
      }

      items.push({
        line: lineNum,
        text: textParts.join('\n'),
        checked,
        section: currentSection,
      });
      continue;
    }

    i++;
  }

  return items;
}

export type TickBoxResult = 'ticked' | 'already' | 'failed';

export function tickBoxInFile(
  filePath: string,
  targetLine: number,
  targetText: string
): TickBoxResult {
  if (!fs.existsSync(filePath)) {
    return 'failed';
  }

  const rawBuffer = fs.readFileSync(filePath);
  const hasBom =
    rawBuffer.length >= 3 &&
    rawBuffer[0] === 0xef &&
    rawBuffer[1] === 0xbb &&
    rawBuffer[2] === 0xbf;
  const content = rawBuffer.toString('utf8');

  const crlf = content.includes('\r\n');
  const lineEnding = crlf ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);

  const firstTextLine = targetText.split('\n')[0]!.trim();
  const getCheckedItemText = (line: string): string | null => {
    const m = /^\s*[-*]\s+\[[xX]\]\s*(.*)$/.exec(line);
    return m ? m[1]!.trim() : null;
  };
  const isAlreadyChecked = (line: string) => getCheckedItemText(line) === firstTextLine;

  const getUncheckedItemText = (line: string): string | null => {
    const m = /^\s*[-*]\s+\[ \]\s*(.*)$/.exec(line);
    return m ? m[1]!.trim() : null;
  };
  const isUncheckedTarget = (line: string) => getUncheckedItemText(line) === firstTextLine;

  // Try the targetLine first (1-based)
  const lineIdx = targetLine - 1;
  if (lineIdx >= 0 && lineIdx < lines.length) {
    const candidate = lines[lineIdx]!;
    if (isAlreadyChecked(candidate)) {
      return 'already';
    }
  }

  let modified = false;

  // Try the targetLine first (1-based)
  if (lineIdx >= 0 && lineIdx < lines.length) {
    const candidate = lines[lineIdx]!;
    if (isUncheckedTarget(candidate)) {
      lines[lineIdx] = candidate.replace(/(\s*[-*]\s+)\[ \]/, '$1[x]');
      modified = true;
    }
  }

  // If line moved, search for unchecked line matching firstTextLine
  if (!modified) {
    for (let j = 0; j < lines.length; j++) {
      const candidate = lines[j]!;
      if (isUncheckedTarget(candidate)) {
        lines[j] = candidate.replace(/(\s*[-*]\s+)\[ \]/, '$1[x]');
        modified = true;
        break;
      }
    }
  }

  if (!modified) {
    const alreadyAnywhere = lines.some((l) => isAlreadyChecked(l));
    if (alreadyAnywhere) {
      return 'already';
    }
    return 'failed';
  }

  const updatedBody = lines.join(lineEnding);
  const finalBuffer = hasBom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(updatedBody, 'utf8')])
    : Buffer.from(updatedBody, 'utf8');

  // Atomic write
  const tmpFile = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tmpFile, finalBuffer);
  let renamed = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmpFile, filePath);
      renamed = true;
      break;
    } catch {
      const end = Date.now() + 15 * (attempt + 1);
      while (Date.now() < end) {}
    }
  }
  if (!renamed) {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup
    }
    return 'failed';
  }

  return 'ticked';
}
