import path from 'node:path';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { appendAudit, badRequest, conflict, notFound, fileMutex, newId, readJson, writeJsonAtomic } from './lib.ts';

export interface PromptTemplate {
  id: string;
  name: string;
  builtin: boolean;
  description: string;
  title: string;
  prompt: string;
  mode: 'task' | 'team' | 'council' | 'auto-gate' | 'chat';
  agent: string;
  role: string;
  preset_id: string;
  labels: string[];
  variables?: string[];
}

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: 'implement-feature',
    name: 'Implement feature',
    builtin: true,
    description: 'Implement a feature following specification',
    title: 'Implement {{feature}}',
    prompt: 'Implement {{feature}} in {{file}} following SPEC.md.',
    mode: 'task',
    agent: '',
    role: 'backend',
    preset_id: '',
    labels: ['feature'],
  },
  {
    id: 'fix-bug',
    name: 'Fix bug',
    builtin: true,
    description: 'Investigate and fix an issue',
    title: 'Fix: {{issue}}',
    prompt: 'Fix the bug: {{issue}} in {{file}}. Ensure tests pass.',
    mode: 'task',
    agent: '',
    role: 'backend',
    preset_id: '',
    labels: ['bug'],
  },
  {
    id: 'write-tests',
    name: 'Write tests',
    builtin: true,
    description: 'Write automated tests for a module',
    title: 'Write tests for {{module}}',
    prompt: 'Write comprehensive unit and integration tests for {{module}} in {{test_file}}.',
    mode: 'task',
    agent: '',
    role: 'tester',
    preset_id: '',
    labels: ['testing'],
  },
  {
    id: 'security-review',
    name: 'Security review',
    builtin: true,
    description: 'Council security audit of codebase or diff',
    title: 'Security review: {{scope}}',
    prompt: 'Perform a strict security review of {{scope}}. Check for input validation, secrets, and authorization flaws.',
    mode: 'council',
    agent: '',
    role: 'reviewer',
    preset_id: 'strict-council',
    labels: ['security', 'review'],
  },
  {
    id: 'refactor-file',
    name: 'Refactor file',
    builtin: true,
    description: 'Clean up and refactor code without changing behavior',
    title: 'Refactor {{file}}',
    prompt: 'Refactor {{file}} to improve clarity, maintainability and adhere to clean architecture without breaking existing tests.',
    mode: 'task',
    agent: '',
    role: 'backend',
    preset_id: '',
    labels: ['refactor'],
  },
  {
    id: 'review-uncommitted',
    name: 'Review uncommitted work',
    builtin: true,
    description: 'Council review of uncommitted git diff',
    title: 'Review uncommitted changes in {{project}}',
    prompt: 'Review uncommitted changes in {{project}} against SPEC.md and provide actionable feedback.',
    mode: 'council',
    agent: '',
    role: 'reviewer',
    preset_id: 'strict-council',
    labels: ['review'],
  },
];

const VAR_REGEX = /\{\{([a-z][a-z0-9_]{0,31})\}\}/g;

export function extractTemplateVariables(title: string, prompt: string): string[] {
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  const combined = `${title}\n${prompt}`;
  VAR_REGEX.lastIndex = 0;
  while ((match = VAR_REGEX.exec(combined)) !== null) {
    if (match[1] && match[1] !== 'project' && match[1] !== 'date') {
      vars.add(match[1]);
    }
  }
  return Array.from(vars).sort();
}

export function renderTemplate(
  tpl: PromptTemplate,
  vars: Record<string, string>,
  projectPath: string
): { title: string; prompt: string } {
  const effectiveVars: Record<string, string> = {
    project: path.basename(projectPath || '').trim() || 'project',
    date: new Date().toISOString().slice(0, 10),
    ...(vars || {}),
  };

  const needed = extractTemplateVariables(tpl.title, tpl.prompt);
  for (const v of needed) {
    if (effectiveVars[v] === undefined || effectiveVars[v] === null) {
      throw badRequest(`Missing template variable: ${v}`);
    }
  }

  const renderText = (str: string): string =>
    str.replace(VAR_REGEX, (_m, key: string) => effectiveVars[key] ?? '');

  return {
    title: renderText(tpl.title),
    prompt: renderText(tpl.prompt),
  };
}

function getTemplatesFile(ctx: MawFeatureContext): string {
  return path.win32.join(ctx.paths.featureDataDir('tasks'), 'templates.json');
}

export async function getTemplates(ctx: MawFeatureContext): Promise<PromptTemplate[]> {
  const file = getTemplatesFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const raw = readJson<{ version?: number; templates?: PromptTemplate[] }>(file, {
      version: 1,
      templates: [],
    });
    const userList = Array.isArray(raw.templates) ? raw.templates : [];

    const builtinsWithVars = BUILTIN_TEMPLATES.map((t) => ({
      ...t,
      variables: extractTemplateVariables(t.title, t.prompt),
    }));

    const userWithVars = userList.map((t) => ({
      ...t,
      builtin: false,
      variables: extractTemplateVariables(t.title, t.prompt),
    }));

    return [...builtinsWithVars, ...userWithVars];
  });
}

export async function getTemplate(
  ctx: MawFeatureContext,
  id: string
): Promise<PromptTemplate | null> {
  const all = await getTemplates(ctx);
  return all.find((t) => t.id === id) ?? null;
}

export async function saveTemplate(
  ctx: MawFeatureContext,
  raw: Record<string, unknown>
): Promise<PromptTemplate> {
  const rawId = String(raw.id ?? '').trim();
  if (rawId && BUILTIN_TEMPLATES.some((b) => b.id === rawId)) {
    throw conflict('Built-in templates are read-only.');
  }

  const name = String(raw.name ?? '').trim();
  if (!name) {
    throw badRequest('Template name is required.');
  }
  const title = String(raw.title ?? '').trim();
  if (!title || title.length > 200) {
    throw badRequest('Template title must be between 1 and 200 characters.');
  }
  const prompt = String(raw.prompt ?? '').trim();
  if (!prompt || prompt.length > 20000) {
    throw badRequest('Template prompt must be between 1 and 20000 characters.');
  }

  const mode = String(raw.mode ?? 'task').trim() as PromptTemplate['mode'];
  const agent = String(raw.agent ?? '').trim();
  const role = String(raw.role ?? '').trim();
  const presetId = String(raw.preset_id ?? '').trim();
  const description = String(raw.description ?? '').trim();
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((x) => String(x ?? '').trim()).filter(Boolean)
    : [];

  const file = getTemplatesFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const data = readJson<{ version: 1; templates: PromptTemplate[] }>(file, {
      version: 1,
      templates: [],
    });
    if (!Array.isArray(data.templates)) {
      data.templates = [];
    }

    const id = rawId || newId('tpl');
    const existingIdx = data.templates.findIndex((t) => t.id === id);

    if (existingIdx < 0 && data.templates.length >= 200) {
      throw badRequest('Maximum user template limit (200) reached.');
    }

    const tpl: PromptTemplate = {
      id,
      name,
      builtin: false,
      description,
      title,
      prompt,
      mode,
      agent,
      role,
      preset_id: presetId,
      labels,
      variables: extractTemplateVariables(title, prompt),
    };

    if (existingIdx >= 0) {
      data.templates[existingIdx] = tpl;
    } else {
      data.templates.push(tpl);
    }

    writeJsonAtomic(file, data);
    return tpl;
  });
}

export async function deleteTemplate(
  ctx: MawFeatureContext,
  id: string
): Promise<string> {
  if (BUILTIN_TEMPLATES.some((b) => b.id === id)) {
    throw conflict('Built-in templates are read-only.');
  }

  const file = getTemplatesFile(ctx);
  return fileMutex.runExclusive(file, () => {
    const data = readJson<{ version: 1; templates: PromptTemplate[] }>(file, {
      version: 1,
      templates: [],
    });
    const beforeLen = data.templates?.length ?? 0;
    data.templates = (data.templates ?? []).filter((t) => t.id !== id);
    if (data.templates.length === beforeLen) {
      throw notFound(`Template not found: ${id}`);
    }
    writeJsonAtomic(file, data);
    appendAudit(ctx.paths.auditFile, 'template_delete', { id });
    return id;
  });
}
