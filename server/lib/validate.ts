import { buildCommandSpec, type ValidatedCommandInfo } from './commands.ts';
import { resolveProjectPath, type ServerPaths } from './paths.ts';
import { getCodexModels } from './versions.ts';

export class ApiValidationError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ApiValidationError';
    this.statusCode = statusCode;
  }
}

const ALLOWED_MODES: readonly string[] = [
  'task',
  'team',
  'antigravity',
  'claude',
  'codex',
  'council',
  'auto-gate',
  'spec-guard',
];

const ALLOWED_AGENTS: readonly string[] = ['claude', 'antigravity', 'codex'];
const ALLOWED_TASK_ROLES: readonly string[] = [
  'architect',
  'backend',
  'frontend',
  'reviewer',
  'tester',
];
const ALLOWED_TEAM_KEYS: readonly string[] = ['backend', 'frontend', 'reviewer'];

const ALLOWED_CLAUDE_MODELS: readonly string[] = [
  '',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
];

const ALLOWED_CLAUDE_EFFORTS: readonly string[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const ALLOWED_CODEX_EFFORTS: readonly string[] = ['', 'low', 'medium', 'high', 'xhigh'];
const ALLOWED_AGY_MODELS: readonly string[] = ['', 'pro', 'flash', 'flash_lite'];

export function buildValidatedCommand(
  body: Record<string, unknown>,
  paths: ServerPaths
): ValidatedCommandInfo {
  const mode = String(body.mode ?? '').trim().toLowerCase();
  if (!ALLOWED_MODES.includes(mode)) {
    throw new ApiValidationError(
      'Invalid mode. Must be one of: task, team, antigravity, claude, codex, council, auto-gate, spec-guard.',
      400
    );
  }

  const rawProjectPath = String(body.project_path ?? paths.repoRoot).trim();
  const validatedProjectPath = resolveProjectPath(rawProjectPath, paths.projectsRoot);
  if (validatedProjectPath === null) {
    throw new ApiValidationError(
      `Invalid project_path. Must be an existing project subdirectory strictly inside ${paths.projectsRoot}.`,
      400
    );
  }

  let agent = '';
  let role = String(body.role ?? '').trim().toLowerCase();
  const newSession = body.new_session === true;
  let teamArray: Record<string, string> | null = null;
  let teamSpec = '';

  if (mode === 'task') {
    agent = String(body.agent ?? '').trim().toLowerCase();
    if (!ALLOWED_AGENTS.includes(agent)) {
      throw new ApiValidationError(
        'Invalid agent for task mode. Allowed: claude, antigravity, codex.',
        400
      );
    }
    if (!ALLOWED_TASK_ROLES.includes(role)) {
      throw new ApiValidationError(
        'Invalid role for task mode. Allowed: architect, backend, frontend, reviewer, tester.',
        400
      );
    }
  } else if (mode === 'team') {
    agent = String(body.agent ?? '').trim().toLowerCase();
    if (!ALLOWED_AGENTS.includes(agent)) {
      throw new ApiValidationError(
        'Invalid leader agent for team mode. Allowed: claude, antigravity, codex.',
        400
      );
    }
    role = 'leader';
    const rawTeam = body.team;
    if (
      !rawTeam ||
      typeof rawTeam !== 'object' ||
      Array.isArray(rawTeam) ||
      Object.keys(rawTeam).length === 0
    ) {
      throw new ApiValidationError(
        'Team mode requires a non-empty team map (subset of backend, frontend, reviewer).',
        400
      );
    }
    const normalizedTeam: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawTeam as Record<string, unknown>)) {
      const kNorm = k.trim().toLowerCase();
      const vNorm = typeof v === 'string' ? v.trim().toLowerCase() : '';
      if (!ALLOWED_TEAM_KEYS.includes(kNorm)) {
        throw new ApiValidationError(
          `Invalid team slot '${kNorm}'. Allowed keys: backend, frontend, reviewer.`,
          400
        );
      }
      if (!ALLOWED_AGENTS.includes(vNorm)) {
        throw new ApiValidationError(
          `Invalid agent '${vNorm}' for team slot '${kNorm}'. Allowed: claude, antigravity, codex.`,
          400
        );
      }
      normalizedTeam[kNorm] = vNorm;
    }
    if (Object.keys(normalizedTeam).length === 0) {
      throw new ApiValidationError('Team mode requires at least 1 valid team member.', 400);
    }
    teamArray = {};
    const teamParts: string[] = [];
    for (const slotKey of ALLOWED_TEAM_KEYS) {
      if (normalizedTeam[slotKey] !== undefined) {
        teamArray[slotKey] = normalizedTeam[slotKey]!;
        teamParts.push(`${slotKey}=${normalizedTeam[slotKey]}`);
      }
    }
    teamSpec = teamParts.join(',');
  } else {
    const allowedRolesByMode: Record<string, readonly string[]> = {
      claude: ['architect', 'leader', 'backend', 'frontend', 'reviewer', 'ui-tweak'],
      codex: ['review-diff', 'critic', 'coder'],
      antigravity: ['send-latest', 'new', 'status', 'wait'],
      council: ['parallel-review', 'reviewer', ''],
      'auto-gate': ['auto-loop', 'review-only', ''],
      'spec-guard': ['check', ''],
    };

    if (mode === 'claude') {
      agent = 'claude';
      if (!allowedRolesByMode.claude!.includes(role)) {
        throw new ApiValidationError(
          'Invalid role for claude. Allowed: architect, leader, backend, frontend, reviewer, ui-tweak.',
          400
        );
      }
    } else if (mode === 'codex') {
      agent = 'codex';
      if (role === '') role = 'review-diff';
      if (!allowedRolesByMode.codex!.includes(role)) {
        throw new ApiValidationError(
          'Invalid role for codex. Allowed: review-diff, critic, coder.',
          400
        );
      }
    } else if (mode === 'antigravity') {
      agent = 'antigravity';
      if (role === '') role = 'send-latest';
      if (!allowedRolesByMode.antigravity!.includes(role)) {
        throw new ApiValidationError(
          'Invalid role/action for antigravity. Allowed: send-latest, new, status, wait.',
          400
        );
      }
    } else if (mode === 'council') {
      agent = 'council';
      if (role === '' || role === 'reviewer') role = 'parallel-review';
      if (!allowedRolesByMode.council!.includes(role)) {
        throw new ApiValidationError('Invalid role for council. Allowed: parallel-review.', 400);
      }
    } else if (mode === 'auto-gate') {
      agent = 'auto-gate';
      if (role === '') role = 'auto-loop';
      if (!allowedRolesByMode['auto-gate']!.includes(role)) {
        throw new ApiValidationError(
          'Invalid role for auto-gate. Allowed: auto-loop, review-only.',
          400
        );
      }
    } else if (mode === 'spec-guard') {
      agent = 'spec-guard';
      if (role === '' || role === 'all') role = 'check';
      if (!['check', 'antigravity', 'claude', 'codex'].includes(role)) {
        throw new ApiValidationError(
          'Invalid role/owner for spec-guard. Allowed: check, antigravity, claude, codex.',
          400
        );
      }
    }
  }

  const rawPrompt = body.prompt ?? '';
  if (typeof rawPrompt !== 'string') {
    throw new ApiValidationError('Invalid prompt format: must be a string.', 400);
  }
  const prompt = rawPrompt.trim();
  // SPEC §3.0: Prompt limit 20000 characters (code points / characters)
  if ([...prompt].length > 20000) {
    throw new ApiValidationError('Prompt exceeds maximum length (20000 characters).', 400);
  }

  const requiresPrompt =
    mode === 'task' ||
    mode === 'team' ||
    mode === 'claude' ||
    (mode === 'codex' && ['critic', 'coder'].includes(role)) ||
    (mode === 'antigravity' && ['send-latest', 'new'].includes(role)) ||
    (mode === 'auto-gate' && role === 'auto-loop');
  if (requiresPrompt && prompt === '') {
    throw new ApiValidationError(`Prompt is required for ${mode} (${role}).`, 400);
  }

  const rawModel = body.model ?? '';
  const rawEffort = body.effort ?? '';
  if (typeof rawModel !== 'string' || typeof rawEffort !== 'string') {
    throw new ApiValidationError('Invalid model or effort format: must be strings.', 400);
  }
  const modelOverride = rawModel.trim().toLowerCase();
  const effortOverride = rawEffort.trim().toLowerCase();

  const allowedCodexModels = [
    '',
    ...getCodexModels(paths.userProfile).map((m) => m.toLowerCase()),
  ];

  const execAgent = mode === 'task' || mode === 'team' ? agent : mode;
  if (execAgent === 'claude') {
    if (!ALLOWED_CLAUDE_MODELS.includes(modelOverride)) {
      throw new ApiValidationError('Invalid Claude model override.', 400);
    }
    if (!ALLOWED_CLAUDE_EFFORTS.includes(effortOverride)) {
      throw new ApiValidationError('Invalid Claude effort override.', 400);
    }
  } else if (execAgent === 'codex') {
    if (!allowedCodexModels.includes(modelOverride)) {
      throw new ApiValidationError('Invalid Codex model override.', 400);
    }
    if (!ALLOWED_CODEX_EFFORTS.includes(effortOverride)) {
      throw new ApiValidationError('Invalid Codex effort override.', 400);
    }
  } else if (execAgent === 'antigravity') {
    if (!ALLOWED_AGY_MODELS.includes(modelOverride)) {
      throw new ApiValidationError(
        'Invalid Antigravity model tier (allowed: pro, flash, flash_lite).',
        400
      );
    }
    if ((mode === 'task' || mode === 'team') && modelOverride !== '' && !newSession) {
      throw new ApiValidationError(
        'Antigravity model tier override is only supported when new_session is true.',
        400
      );
    }
    if (effortOverride !== '') {
      throw new ApiValidationError('Antigravity does not accept an effort override.', 400);
    }
  }

  const baseInfo = {
    mode,
    agent,
    role,
    model: modelOverride,
    effort: effortOverride,
    new_session: newSession,
    team: teamArray,
    team_spec: teamSpec,
    project_path: validatedProjectPath,
    prompt,
  };
  const spec = buildCommandSpec(baseInfo, paths.scriptsDir, null);
  return {
    ...baseInfo,
    command: spec.preview,
  };
}
