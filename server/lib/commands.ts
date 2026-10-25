import path from 'node:path';

export interface ValidatedCommandInfo {
  mode: string;
  agent: string;
  account?: string;
  role: string;
  model: string;
  effort: string;
  new_session: boolean;
  team: Record<string, string> | null;
  team_spec: string;
  reviewers?: string[];
  implementer?: string;
  agent_profile_id?: string;
  conversation_id?: string;
  resume_token?: string;
  reply_language?: 'vi' | 'en';
  cli_args?: string[];
  env?: Record<string, string>;
  project_path: string;
  prompt: string;
  command: string;
}

export interface CommandSpec {
  file: string;
  args: string[];
  preview: string;
}

/**
 * PowerShell single-quote escaper (v2.2 parity: strips NUL & CR, doubles single quotes & curly quotes).
 */
export function psq(val: string): string {
  const clean = val.replace(/[\0\r]/g, '');
  const escaped = clean.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&');
  return `'${escaped}'`;
}

type ArgToken =
  | { kind: 'flag'; name: string }
  | { kind: 'raw'; name: string; value: string }
  | { kind: 'str'; name: string; value: string };

/**
 * Single unified builder that constructs BOTH the spawn argument array for `powershell.exe`
 * and the `& '...'` PowerShell preview string for `dispatch` / `run_job` (SPEC §1 & §3.5).
 */
export function buildCommandSpec(
  info: Omit<ValidatedCommandInfo, 'command'>,
  scriptsDir: string,
  promptFile: string | null = null
): CommandSpec {
  const {
    mode,
    agent,
    role,
    model: modelOverride,
    effort: effortOverride,
    new_session: newSession,
    team_spec: teamSpec,
    project_path: projectPath,
    prompt,
  } = info;

  let scriptPath = '';
  const tokens: ArgToken[] = [];

  if (mode === 'task' || mode === 'chat' || mode === 'team') {
    scriptPath = path.win32.join(scriptsDir, 'invoke-agent.ps1');
    tokens.push({ kind: 'str', name: '-Agent', value: agent });
    tokens.push({ kind: 'str', name: '-Role', value: role });
    tokens.push({ kind: 'str', name: '-WorkDir', value: projectPath });
    if (mode === 'team' && teamSpec !== '') {
      tokens.push({ kind: 'str', name: '-Team', value: teamSpec });
    }
    if (modelOverride !== '') {
      tokens.push({ kind: 'str', name: '-ModelOverride', value: modelOverride });
    }
    if (effortOverride !== '') {
      tokens.push({ kind: 'str', name: '-EffortOverride', value: effortOverride });
    }
    if (newSession) {
      tokens.push({ kind: 'flag', name: '-NewSession' });
    }
    if (info.resume_token && info.resume_token !== '') {
      tokens.push({ kind: 'str', name: '-ResumeId', value: info.resume_token });
    }
    if (info.reply_language && (info.reply_language === 'vi' || info.reply_language === 'en')) {
      tokens.push({ kind: 'str', name: '-ReplyLanguage', value: info.reply_language });
    }
    if (info.account && info.account !== '' && info.account !== 'default') {
      tokens.push({ kind: 'str', name: '-Account', value: info.account });
    }
    if (promptFile !== null) {
      tokens.push({ kind: 'str', name: '-PromptFile', value: promptFile });
    } else {
      tokens.push({ kind: 'str', name: '-Prompt', value: prompt });
    }
  } else if (mode === 'claude') {
    scriptPath = path.win32.join(scriptsDir, 'invoke-claude.ps1');
    tokens.push({ kind: 'str', name: '-Role', value: role });
    tokens.push({ kind: 'str', name: '-WorkDir', value: projectPath });
    if (role === 'reviewer') {
      tokens.push({ kind: 'flag', name: '-IncludeGitDiff' });
    }
    if (modelOverride !== '') {
      tokens.push({ kind: 'str', name: '-ModelOverride', value: modelOverride });
    }
    if (effortOverride !== '') {
      tokens.push({ kind: 'str', name: '-EffortOverride', value: effortOverride });
    }
    if (info.account && info.account !== '' && info.account !== 'default') {
      tokens.push({ kind: 'str', name: '-Account', value: info.account });
    }
    if (promptFile !== null) {
      tokens.push({ kind: 'str', name: '-PromptFile', value: promptFile });
    } else {
      tokens.push({ kind: 'str', name: '-Prompt', value: prompt });
    }
  } else if (mode === 'codex') {
    scriptPath = path.win32.join(scriptsDir, 'invoke-codex.ps1');
    tokens.push({ kind: 'str', name: '-Role', value: role });
    tokens.push({ kind: 'str', name: '-WorkDir', value: projectPath });
    if (modelOverride !== '') {
      tokens.push({ kind: 'str', name: '-ModelOverride', value: modelOverride });
    }
    if (effortOverride !== '') {
      tokens.push({ kind: 'str', name: '-EffortOverride', value: effortOverride });
    }
    if (info.account && info.account !== '' && info.account !== 'default') {
      tokens.push({ kind: 'str', name: '-Account', value: info.account });
    }
    if (prompt !== '') {
      if (promptFile !== null) {
        tokens.push({ kind: 'str', name: '-PromptFile', value: promptFile });
      } else {
        tokens.push({ kind: 'str', name: '-Prompt', value: prompt });
      }
    }
  } else if (mode === 'council') {
    scriptPath = path.win32.join(scriptsDir, 'invoke-council-review.ps1');
    tokens.push({ kind: 'str', name: '-WorkDir', value: projectPath });
    if (info.reviewers && info.reviewers.length > 0) {
      tokens.push({ kind: 'str', name: '-Reviewers', value: info.reviewers.join(',') });
    }
    if (promptFile !== null && prompt !== '') {
      tokens.push({ kind: 'str', name: '-Prompt', value: '' });
      tokens.push({ kind: 'str', name: '-PromptFile', value: promptFile });
    } else {
      const effectivePrompt =
        prompt !== '' ? prompt : 'Review uncommitted changes against SPEC.md and score X/10.';
      tokens.push({ kind: 'str', name: '-Prompt', value: effectivePrompt });
    }
  } else if (mode === 'auto-gate') {
    scriptPath = path.win32.join(scriptsDir, 'invoke-auto-gate.ps1');
    tokens.push({ kind: 'str', name: '-WorkDir', value: projectPath });
    tokens.push({ kind: 'raw', name: '-MaxRounds', value: '2' });
    if (info.implementer && info.implementer !== '') {
      tokens.push({ kind: 'str', name: '-Implementer', value: info.implementer });
    }
    if (info.reviewers && info.reviewers.length > 0) {
      tokens.push({ kind: 'str', name: '-Reviewers', value: info.reviewers.join(',') });
    }
    if (role === 'review-only') {
      tokens.push({ kind: 'flag', name: '-SkipInitialImplement' });
    }
    if (prompt !== '') {
      if (promptFile !== null) {
        tokens.push({ kind: 'str', name: '-PromptFile', value: promptFile });
      } else {
        tokens.push({ kind: 'str', name: '-Prompt', value: prompt });
      }
    }
  } else if (mode === 'spec-guard') {
    scriptPath = path.win32.join(scriptsDir, 'invoke-spec-guard.ps1');
    tokens.push({ kind: 'str', name: '-WorkDir', value: projectPath });
    if (role !== '' && role !== 'check') {
      tokens.push({ kind: 'str', name: '-Owner', value: role });
    }
  } else {
    // mode === 'antigravity'
    scriptPath = path.win32.join(scriptsDir, 'invoke-antigravity.ps1');
    tokens.push({ kind: 'str', name: '-Action', value: role });
    tokens.push({ kind: 'str', name: '-WorkDir', value: projectPath });
    if (role !== 'status' && role !== 'wait') {
      if (role === 'new' && modelOverride !== '') {
        tokens.push({ kind: 'str', name: '-Model', value: modelOverride });
      }
      tokens.push({ kind: 'str', name: '-Title', value: 'Task from Mission Control' });
      if (promptFile !== null) {
        tokens.push({ kind: 'str', name: '-PromptFile', value: promptFile });
      } else {
        tokens.push({ kind: 'str', name: '-Prompt', value: prompt });
      }
    }
  }

  const spawnArgs: string[] = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  const previewParts: string[] = [`& ${psq(scriptPath)}`];

  for (const tok of tokens) {
    if (tok.kind === 'flag') {
      spawnArgs.push(tok.name);
      previewParts.push(tok.name);
    } else if (tok.kind === 'raw') {
      spawnArgs.push(tok.name, tok.value);
      previewParts.push(`${tok.name} ${tok.value}`);
    } else {
      spawnArgs.push(tok.name, tok.value);
      previewParts.push(`${tok.name} ${psq(tok.value)}`);
    }
  }

  return {
    file: 'powershell.exe',
    args: spawnArgs,
    preview: previewParts.join(' '),
  };
}
