export interface HandoffDispatchItem {
  to: string;
  task: string;
  acceptance: string;
  thread: string;
}

export interface StructuredHandoffResult {
  status: 'completed' | 'failed' | 'blocked';
  summary: string;
  files_changed: string[];
  evidence: string;
  blockers: string[];
  cost: number | null;
  decisions: string[];
}

export function parseHandoffDispatchBlock(
  text: string
): { ok: true; handoffs: HandoffDispatchItem[] } | { ok: false; error: string } {
  const match = /```handoff\s*\r?\n([\s\S]*?)\r?\n```/i.exec(text);
  if (!match) {
    return { ok: false, error: 'No ```handoff block found in text.' };
  }

  const rawJson = match[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err: unknown) {
    return { ok: false, error: 'Invalid JSON inside ```handoff block: ' + String(err) };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Handoff JSON must be an object with a "handoffs" array.' };
  }

  const rawHandoffs = (parsed as Record<string, unknown>).handoffs;
  if (!Array.isArray(rawHandoffs)) {
    return { ok: false, error: '"handoffs" property must be an array.' };
  }

  if (rawHandoffs.length === 0) {
    return { ok: false, error: '"handoffs" array is empty.' };
  }

  if (rawHandoffs.length > 6) {
    return { ok: false, error: 'Maximum 6 handoffs allowed per Lead turn.' };
  }

  const result: HandoffDispatchItem[] = [];
  for (let i = 0; i < rawHandoffs.length; i++) {
    const item = rawHandoffs[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: `Handoff item #${i} must be an object.` };
    }
    const obj = item as Record<string, unknown>;
    const to = String(obj.to ?? '').trim();
    if (!to) {
      return { ok: false, error: `Handoff item #${i} missing "to" property.` };
    }
    if (to.length > 60) {
      return { ok: false, error: `Handoff item #${i} "to" too long (max 60 chars).` };
    }

    const task = String(obj.task ?? '').trim();
    if (!task) {
      return { ok: false, error: `Handoff item #${i} missing "task" property.` };
    }
    if (task.length > 8000) {
      return { ok: false, error: `Handoff item #${i} "task" too long (max 8000 chars).` };
    }

    const acceptance = String(obj.acceptance ?? '').trim().slice(0, 1000);
    const thread = String(obj.thread ?? '').trim().slice(0, 60);

    result.push({ to, task, acceptance, thread });
  }

  return { ok: true, handoffs: result };
}

export function parseStructuredHandoffResult(
  text: string,
  parsedCost: number | null
):
  | { ok: true; result: StructuredHandoffResult }
  | { ok: false; error: string; fallbackResult: StructuredHandoffResult } {
  const fallbackResult: StructuredHandoffResult = {
    status: 'failed',
    summary: text.slice(0, 1500).trim(),
    files_changed: [],
    evidence: '',
    blockers: [],
    cost: parsedCost,
    decisions: [],
  };

  const regex = /```json\s*\r?\n([\s\S]*?)\r?\n```/gi;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    lastMatch = m;
  }

  if (!lastMatch) {
    return {
      ok: false,
      error: 'Missing fenced ```json result block in assistant reply.',
      fallbackResult,
    };
  }

  const rawJson = lastMatch[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err: unknown) {
    return {
      ok: false,
      error: 'Failed to parse ```json result block: ' + String(err),
      fallbackResult,
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      error: 'Structured result must be a JSON object.',
      fallbackResult,
    };
  }

  const obj = parsed as Record<string, unknown>;

  const statusRaw = String(obj.status ?? '').trim().toLowerCase();
  if (statusRaw !== 'completed' && statusRaw !== 'failed' && statusRaw !== 'blocked') {
    return {
      ok: false,
      error: `Invalid status '${statusRaw}' in result (must be completed|failed|blocked).`,
      fallbackResult,
    };
  }
  const status = statusRaw as 'completed' | 'failed' | 'blocked';

  // Item 2 (Codex Pass 6): Structured result must be complete:
  // require summary (non-empty string), files_changed (array), evidence (string, may be empty), blockers (array);
  // missing or wrong-typed -> needs_review with a parse_error naming the field.
  if (typeof obj.summary !== 'string' || obj.summary.trim() === '') {
    return {
      ok: false,
      error: 'Missing or invalid "summary" property in result (must be a non-empty string).',
      fallbackResult,
    };
  }
  const summary = obj.summary.trim().slice(0, 1500);

  if (!Array.isArray(obj.files_changed)) {
    return {
      ok: false,
      error: 'Missing or invalid "files_changed" property in result (must be an array).',
      fallbackResult,
    };
  }
  const files_changed: string[] = obj.files_changed
    .map((x) => String(x ?? '').trim())
    .filter((x) => x.length > 0 && x.length <= 500)
    .slice(0, 200);

  if (typeof obj.evidence !== 'string') {
    return {
      ok: false,
      error: 'Missing or invalid "evidence" property in result (must be a string).',
      fallbackResult,
    };
  }
  const evidence = obj.evidence.trim().slice(0, 3000);

  if (!Array.isArray(obj.blockers)) {
    return {
      ok: false,
      error: 'Missing or invalid "blockers" property in result (must be an array).',
      fallbackResult,
    };
  }
  const blockers: string[] = obj.blockers
    .map((x) => String(x ?? '').trim())
    .filter((x) => x.length > 0 && x.length <= 500)
    .slice(0, 20);

  let selfCost: number | null = null;
  if (typeof obj.cost === 'number' && !Number.isNaN(obj.cost)) {
    selfCost = obj.cost;
  }
  // Parsed job cost wins over self-reported cost
  const cost = parsedCost !== null ? parsedCost : selfCost;

  let decisions: string[] = [];
  if (Array.isArray(obj.decisions)) {
    decisions = obj.decisions
      .map((x) => String(x ?? '').trim())
      .filter((x) => x.length > 0 && x.length <= 1000)
      .slice(0, 10);
  }

  return {
    ok: true,
    result: {
      status,
      summary,
      files_changed,
      evidence,
      blockers,
      cost,
      decisions,
    },
  };
}
