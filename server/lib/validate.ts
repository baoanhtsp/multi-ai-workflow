import { buildCommandSpec, type ValidatedCommandInfo } from './commands.ts';
import { resolveProjectPath, type ServerPaths } from './paths.ts';
import { loadAgentRegistry } from './registry.ts';
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
  'chat',
  'team',
  'antigravity',
  'claude',
  'codex',
  'council',
  'auto-gate',
  'spec-guard',
];

const ALLOWED_TASK_ROLES: readonly string[] = [
  'architect',
  'backend',
  'frontend',
  'reviewer',
  'tester',
];
const ALLOWED_TEAM_KEYS: readonly string[] = ['backend', 'frontend', 'reviewer'];
const DENIED_ENV_KEYS = new Set<string>([
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'SYSTEMROOT',
  'WINDIR',
  'PSMODULEPATH',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
]);

function parseReviewersList(
  rawReviewers: unknown,
  enabledMap: Map<string, { id: string; capabilities: { review: boolean } }>
): string[] {
  let items: string[] = [];
  if (Array.isArray(rawReviewers)) {
    items = rawReviewers.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : ''));
  } else if (typeof rawReviewers === 'string') {
    items = rawReviewers
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x !== '');
  } else {
    throw new ApiValidationError('Invalid reviewers format: must be a non-empty array of agent ids.', 400);
  }

  if (items.length === 0 || items.some((x) => x === '')) {
    throw new ApiValidationError('Council reviewers must contain at least 1 valid agent id.', 400);
  }

  const deduped: string[] = [];
  for (const id of items) {
    const entry = enabledMap.get(id);
    if (!entry) {
      throw new ApiValidationError(`Invalid reviewer agent '${id}'. Not an enabled registry agent.`, 400);
    }
    if (!entry.capabilities.review) {
      throw new ApiValidationError(`Agent '${id}' does not have review capability.`, 400);
    }
    if (!deduped.includes(id)) {
      deduped.push(id);
    }
  }

  if (deduped.length === 0) {
    throw new ApiValidationError('Council reviewers must contain at least 1 valid agent id.', 400);
  }
  return deduped;
}

export function buildValidatedCommand(
  body: Record<string, unknown>,
  paths: ServerPaths
): ValidatedCommandInfo {
  const mode = String(body.mode ?? '').trim().toLowerCase();
  if (!ALLOWED_MODES.includes(mode)) {
    throw new ApiValidationError(
      'Invalid mode. Must be one of: task, chat, team, antigravity, claude, codex, council, auto-gate, spec-guard.',
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

  const registry = loadAgentRegistry(paths);
  const enabledAgentsMap = new Map(registry.agents.map((a) => [a.id, a]));
  const enabledIds = registry.agents.map((a) => a.id);

  let agent = '';
  let role = String(body.role ?? '').trim().toLowerCase();
  const newSession = body.new_session === true;
  let teamArray: Record<string, string> | null = null;
  let teamSpec = '';
  let reviewers: string[] | undefined;
  let implementer: string | undefined;
  let agentProfileId: string | undefined;
  let conversationId: string | undefined;
  let resumeToken: string | undefined;
  let cliArgs: string[] | undefined;
  let envVars: Record<string, string> | undefined;

  if (body.resume_token !== undefined && body.resume_token !== null && String(body.resume_token).trim() !== '') {
    const rt = String(body.resume_token).trim();
    if (!/^[\w.:/-]{1,128}$/.test(rt)) {
      throw new ApiValidationError('Invalid resume_token format.', 400);
    }
    resumeToken = rt;
  }

  if (body.agent_profile_id !== undefined && body.agent_profile_id !== null && String(body.agent_profile_id).trim() !== '') {
    agentProfileId = String(body.agent_profile_id).trim();
  }

  if (body.conversation_id !== undefined && body.conversation_id !== null && String(body.conversation_id).trim() !== '') {
    conversationId = String(body.conversation_id).trim();
  }

  if (body.cli_args !== undefined && body.cli_args !== null) {
    if (!Array.isArray(body.cli_args)) {
      throw new ApiValidationError('Invalid cli_args: must be an array of strings.', 400);
    }
    cliArgs = body.cli_args.map((a) => String(a ?? ''));
  }

  if (body.env !== undefined && body.env !== null) {
    if (typeof body.env !== 'object' || Array.isArray(body.env)) {
      throw new ApiValidationError('Invalid env: must be an object of string key-value pairs.', 400);
    }
    envVars = {};
    for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
      const kTrim = k.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(kTrim) || DENIED_ENV_KEYS.has(kTrim.toUpperCase())) {
        throw new ApiValidationError(`Invalid or denied environment variable key '${kTrim}'.`, 400);
      }
      envVars[kTrim] = String(v ?? '');
    }
  }

  if (mode === 'task' || mode === 'chat') {
    agent = String(body.agent ?? '').trim().toLowerCase();
    const agentEntry = enabledAgentsMap.get(agent);
    if (!agentEntry) {
      throw new ApiValidationError(
        `Invalid agent for ${mode} mode. Allowed: ${enabledIds.join(', ')}.`,
        400
      );
    }
    if (mode === 'chat' && role === '') {
      role = 'backend';
    }
    if (!ALLOWED_TASK_ROLES.includes(role)) {
      throw new ApiValidationError(
        `Invalid role for ${mode} mode. Allowed: architect, backend, frontend, reviewer, tester.`,
        400
      );
    }
    if (newSession && !agentEntry.capabilities.new_session) {
      throw new ApiValidationError(`Agent '${agent}' does not support new_session.`, 400);
    }
  } else if (mode === 'team') {
    agent = String(body.agent ?? '').trim().toLowerCase();
    const leaderEntry = enabledAgentsMap.get(agent);
    if (!leaderEntry) {
      throw new ApiValidationError(
        `Invalid leader agent for team mode. Allowed: ${enabledIds.join(', ')}.`,
        400
      );
    }
    if (newSession && !leaderEntry.capabilities.new_session) {
      throw new ApiValidationError(`Agent '${agent}' does not support new_session.`, 400);
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
      if (!enabledAgentsMap.has(vNorm)) {
        throw new ApiValidationError(
          `Invalid agent '${vNorm}' for team slot '${kNorm}'. Allowed: ${enabledIds.join(', ')}.`,
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
      if (body.reviewers !== undefined) {
        reviewers = parseReviewersList(body.reviewers, enabledAgentsMap);
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
      if (body.implementer !== undefined && String(body.implementer).trim() !== '') {
        const imp = String(body.implementer).trim().toLowerCase();
        const impEntry = enabledAgentsMap.get(imp);
        if (!impEntry) {
          throw new ApiValidationError(
            `Invalid implementer '${imp}'. Not an enabled registry agent.`,
            400
          );
        }
        if (!impEntry.capabilities.write) {
          throw new ApiValidationError(
            `Agent '${imp}' does not have write capability required for auto-gate implementer.`,
            400
          );
        }
        implementer = imp;
      }
      if (body.reviewers !== undefined) {
        reviewers = parseReviewersList(body.reviewers, enabledAgentsMap);
      }
    } else if (mode === 'spec-guard') {
      agent = 'spec-guard';
      if (role === '' || role === 'all') role = 'check';
      if (role !== 'check' && !enabledAgentsMap.has(role)) {
        throw new ApiValidationError(
          `Invalid role/owner for spec-guard. Allowed: check, ${enabledIds.join(', ')}.`,
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
    mode === 'chat' ||
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

  const execAgent = mode === 'task' || mode === 'chat' || mode === 'team' ? agent : mode;
  const execEntry =
    enabledAgentsMap.get(execAgent) ?? registry.agents.find((a) => a.id === execAgent);

  if (execEntry) {
    const allowedModels = new Set(execEntry.models.map((m) => m.toLowerCase()));
    if (execEntry.id === 'codex') {
      for (const cm of getCodexModels(paths.userProfile)) {
        allowedModels.add(cm.toLowerCase());
      }
    }

    if (modelOverride !== '') {
      if (!allowedModels.has(modelOverride)) {
        throw new ApiValidationError(`Invalid ${execEntry.label} model override.`, 400);
      }
      if (
        execEntry.adapter === 'antigravity' &&
        (mode === 'task' || mode === 'chat' || mode === 'team') &&
        !newSession &&
        !resumeToken
      ) {
        throw new ApiValidationError(
          'Antigravity model tier override is only supported when new_session is true.',
          400
        );
      }
    }

    const allowedEfforts = new Set(execEntry.efforts.map((e) => e.toLowerCase()));
    if (effortOverride !== '') {
      if (!allowedEfforts.has(effortOverride)) {
        throw new ApiValidationError(`Invalid ${execEntry.label} effort override.`, 400);
      }
    }
  }

  const baseInfo: Omit<ValidatedCommandInfo, 'command'> = {
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
  if (reviewers !== undefined) {
    baseInfo.reviewers = reviewers;
  }
  if (implementer !== undefined) {
    baseInfo.implementer = implementer;
  }
  if (agentProfileId !== undefined) {
    baseInfo.agent_profile_id = agentProfileId;
  }
  if (conversationId !== undefined) {
    baseInfo.conversation_id = conversationId;
  }
  if (resumeToken !== undefined) {
    baseInfo.resume_token = resumeToken;
  }
  if (cliArgs !== undefined) {
    baseInfo.cli_args = cliArgs;
  }
  if (envVars !== undefined) {
    baseInfo.env = envVars;
  }

  const spec = buildCommandSpec(baseInfo, paths.scriptsDir, null);
  return {
    ...baseInfo,
    command: spec.preview,
  };
}
