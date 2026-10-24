import type { MawFeatureContext, MawFeatureRequest } from '../../lib/feature.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { buildTimeline, generateTimelineReport } from './builder.ts';
import { appendTimelineEvent, type TimelineEvent } from './events.ts';

export function handleTimeline(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Record<string, unknown> {
  const query = req.query;
  const from = query.get('from') || undefined;
  const to = query.get('to') || undefined;
  const project = query.get('project') || undefined;
  const jobId = query.get('job_id') || undefined;

  const data = buildTimeline(ctx.paths, ctx.registry, {
    from,
    to,
    project,
    job_id: jobId,
  });

  return {
    ok: true,
    ...data,
  };
}

export function handleTimelineAdd(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Record<string, unknown> {
  const body = req.body;
  const kind = String(body.kind ?? '').trim();
  if (kind !== 'handoff' && kind !== 'custom') {
    throw new ApiValidationError("Property 'kind' must be 'handoff' or 'custom'.", 400);
  }

  const agent = String(body.agent ?? '').trim();
  if (!agent) {
    throw new ApiValidationError("Missing 'agent' parameter.", 400);
  }

  const title = String(body.title ?? '').trim();
  if (!title) {
    throw new ApiValidationError("Missing 'title' parameter.", 400);
  }

  const start = String(body.start ?? new Date().toISOString()).trim();

  const event: TimelineEvent = {
    ts: new Date().toISOString(),
    event: kind as 'handoff' | 'custom',
    agent,
    title,
    start,
    end: body.end ? String(body.end).trim() : null,
    status: body.status ? String(body.status).trim() : 'DONE',
    cost_usd: typeof body.cost_usd === 'number' ? body.cost_usd : 0,
    project: body.project ? String(body.project).trim() : undefined,
    ref: body.ref && typeof body.ref === 'object' ? (body.ref as Record<string, unknown>) : undefined,
  };

  appendTimelineEvent(ctx.paths, event);

  return {
    ok: true,
  };
}

export async function handleTimelineReport(
  ctx: MawFeatureContext,
  req: MawFeatureRequest
): Promise<Record<string, unknown>> {
  const query = req.query;
  const formatParam = (query.get('format') ?? 'md').trim().toLowerCase();
  const format = formatParam === 'html' ? 'html' : 'md';
  const from = query.get('from') || undefined;
  const to = query.get('to') || undefined;
  const project = query.get('project') || undefined;
  const jobId = query.get('job_id') || undefined;

  const report = await generateTimelineReport(ctx.paths, ctx.registry, {
    format,
    from,
    to,
    project,
    job_id: jobId,
  });

  return {
    ok: true,
    filename: report.filename,
    mime: report.mime,
    content: report.content,
  };
}
