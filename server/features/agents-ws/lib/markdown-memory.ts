export interface MemoryEntry {
  id: string;
  title: string;
  body: string;
  date: string;
  source?: string;
  agent?: string;
  pinned?: boolean;
  tags?: string[];
}

export function parseDecisionsMarkdown(md: string): {
  preamble: string;
  entries: MemoryEntry[];
} {
  const raw = String(md ?? '').replace(/^\uFEFF/, '').trim();
  if (!raw) {
    return {
      preamble: '# Project decisions\n',
      entries: [],
    };
  }

  const lines = raw.split(/\r?\n/);
  const entries: MemoryEntry[] = [];
  const preambleLines: string[] = [];

  let inEntry = false;
  let currentId = '';
  let currentTitle = '';
  let currentCommentMeta: Partial<MemoryEntry> = {};
  let currentBodyLines: string[] = [];

  let inFence = false;
  let fenceMarker = '';

  const flushCurrent = () => {
    if (currentId) {
      let body = currentBodyLines.join('\n').trim();
      if (body.length > 4000) {
        body = body.slice(0, 4000);
      }
      entries.push({
        id: currentId,
        title: currentTitle || currentId,
        body,
        date: currentCommentMeta.date || new Date().toISOString().slice(0, 10),
        source: currentCommentMeta.source || '',
        agent: currentCommentMeta.agent || '',
        pinned: Boolean(currentCommentMeta.pinned),
        tags: Array.isArray(currentCommentMeta.tags) ? currentCommentMeta.tags : [],
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Track fenced code blocks (``` or ~~~)
    if (!inFence) {
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
        inFence = true;
        fenceMarker = trimmed.slice(0, 3);
      }
    } else {
      if (trimmed.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
      }
    }

    // Check ## ADR-xxxx (only when outside code blocks)
    if (!inFence) {
      const headingMatch = /^##\s+(ADR-\d{4})(?:\s*[·:]\s*(.*))?$/i.exec(trimmed);
      if (headingMatch) {
        if (inEntry) {
          flushCurrent();
        } else {
          inEntry = true;
        }
        currentId = headingMatch[1]!.toUpperCase();
        currentTitle = (headingMatch[2] ?? '').trim();
        currentCommentMeta = {};
        currentBodyLines = [];
        continue;
      }
    }

    if (!inEntry) {
      preambleLines.push(line);
      continue;
    }

    // Check <!-- maw-memory {...} --> (only directly under heading before body lines and outside fences)
    if (!inFence && currentBodyLines.length === 0) {
      const commentMatch = /<!--\s*maw-memory\s+({.*?})\s*-->/i.exec(trimmed);
      if (commentMatch) {
        try {
          currentCommentMeta = JSON.parse(commentMatch[1]!) as Partial<MemoryEntry>;
        } catch {
          currentCommentMeta = {};
        }
        continue;
      }
    }

    currentBodyLines.push(line);
  }

  if (inEntry) {
    flushCurrent();
  }

  let preamble = preambleLines.join('\n').trim();
  if (!preamble) {
    preamble = '# Project decisions';
  }

  return { preamble: preamble + '\n', entries };
}

export function renderDecisionsMarkdown(
  preamble: string,
  entries: MemoryEntry[]
): string {
  const parts: string[] = [preamble.trim()];

  for (const entry of entries) {
    const titlePart = entry.title ? ` · ${entry.title.trim()}` : '';
    const heading = `## ${entry.id.toUpperCase()}${titlePart}`;
    const metaObj = {
      id: entry.id.toUpperCase(),
      date: entry.date || new Date().toISOString().slice(0, 10),
      source: entry.source || '',
      agent: entry.agent || '',
      pinned: Boolean(entry.pinned),
      tags: Array.isArray(entry.tags) ? entry.tags : [],
    };
    const comment = `<!-- maw-memory ${JSON.stringify(metaObj)} -->`;
    const body = (entry.body || '').trim();

    parts.push(`${heading}\n${comment}\n${body}`);
  }

  return parts.join('\n\n') + '\n';
}

export function getNextAdrId(entries: MemoryEntry[]): string {
  let maxNum = 0;
  for (const entry of entries) {
    const m = /^ADR-(\d{4})$/i.exec(entry.id);
    if (m) {
      const n = Number.parseInt(m[1]!, 10);
      if (n > maxNum) {
        maxNum = n;
      }
    }
  }
  const next = maxNum + 1;
  return `ADR-${String(next).padStart(4, '0')}`;
}
