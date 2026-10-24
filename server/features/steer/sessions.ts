import fs from 'node:fs';
import path from 'node:path';
import type { ServerPaths } from '../../lib/paths.ts';
import type { AgentEntry } from '../../lib/registry.ts';

export interface ParsedSessionRef {
  platform: string;
  id: string;
  exists: boolean;
}

export function parseSessionRefFromLog(
  logContent: string,
  platform: string,
  projectPath: string,
  paths: ServerPaths,
  registryAgent?: AgentEntry
): ParsedSessionRef | null {
  const normPlatform = platform.toLowerCase().trim();

  if (normPlatform === 'antigravity') {
    // Last CONVERSATION_ID: <cid> or conversation: <cid>
    const matches = Array.from(
      logContent.matchAll(/(?:CONVERSATION_ID|conversation):\s*([0-9a-f-]{36})/gi)
    );
    if (matches.length > 0) {
      const cid = matches[matches.length - 1]![1]!;
      const brainItemPath = path.win32.join(paths.brainDir, cid);
      let exists = false;
      try {
        exists = fs.existsSync(brainItemPath);
      } catch {
        exists = false;
      }
      return { platform: 'antigravity', id: cid, exists };
    }
    return null;
  }

  if (normPlatform === 'claude') {
    // First "session_id"\s*:\s*"([0-9a-f-]{36})"
    const match = /"session_id"\s*:\s*"([0-9a-f-]{36})"/i.exec(logContent);
    if (match) {
      const sid = match[1]!;
      const normalizedCwd = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
      const sessionFile = path.win32.join(
        paths.userProfile,
        '.claude',
        'projects',
        normalizedCwd,
        `${sid}.jsonl`
      );
      let exists = false;
      try {
        exists = fs.existsSync(sessionFile);
      } catch {
        exists = false;
      }
      return { platform: 'claude', id: sid, exists };
    }
    return null;
  }

  if (normPlatform === 'codex') {
    // First "thread_id"\s*:\s*"([^"]+)" or session id:\s*([0-9a-f-]{36})
    const m1 = /"thread_id"\s*:\s*"([^"]+)"/i.exec(logContent);
    const m2 = /session id:\s*([0-9a-f-]{36})/i.exec(logContent);
    const id = m1 ? m1[1]! : m2 ? m2[1]! : null;
    if (id) {
      let exists = false;
      try {
        const codexSessionsDir = path.win32.join(paths.userProfile, '.codex', 'sessions');
        exists = searchDirectoryForFileContaining(codexSessionsDir, id, 4);
      } catch {
        exists = false;
      }
      return { platform: 'codex', id, exists };
    }
    return null;
  }

  // Other registry agents: "session_id"\s*:\s*"([^"]+)"
  const otherMatch = /"session_id"\s*:\s*"([^"]+)"/i.exec(logContent);
  if (otherMatch) {
    const id = otherMatch[1]!;
    const exists = Boolean(registryAgent?.resume_args && registryAgent.resume_args.length > 0);
    return { platform: normPlatform, id, exists };
  }

  return null;
}

function searchDirectoryForFileContaining(
  dirPath: string,
  targetId: string,
  maxDepth: number
): boolean {
  if (maxDepth < 0 || !fs.existsSync(dirPath)) {
    return false;
  }
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.includes(targetId)) {
        return true;
      }
      if (e.isDirectory() && maxDepth > 0) {
        const found = searchDirectoryForFileContaining(
          path.win32.join(dirPath, e.name),
          targetId,
          maxDepth - 1
        );
        if (found) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export interface ResumeCommandResult {
  exe: string;
  args: string[];
  promptVia: 'stdin' | 'file_arg';
}

export function buildResumeCommand(options: {
  platform: string;
  sessionId: string;
  model?: string;
  effort?: string;
  projectPath?: string;
  paths?: ServerPaths;
  registryAgent?: AgentEntry;
}): ResumeCommandResult | null {
  const { platform, sessionId, model, effort, projectPath, paths, registryAgent } = options;
  const p = platform.toLowerCase().trim();

  if (p === 'antigravity') {
    const scriptsDir = paths?.scriptsDir ?? 'C:\\scripts';
    const scriptPath = path.win32.join(scriptsDir, 'invoke-antigravity.ps1');
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-Action',
      'send',
      '-ConversationId',
      sessionId,
      '-WorkDir',
      projectPath ?? 'C:\\project',
      '-Title',
      'Continue from Mission Control',
      '-PromptFile',
      '{prompt_file}',
    ];
    return { exe: 'powershell.exe', args, promptVia: 'file_arg' };
  }

  if (p === 'claude') {
    const args = [
      '-p',
      '--resume',
      sessionId,
      '--output-format',
      'text',
      '--permission-mode',
      'bypassPermissions',
      '--dangerously-skip-permissions',
    ];
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    return { exe: 'claude', args, promptVia: 'stdin' };
  }

  if (p === 'codex') {
    const args = [
      'exec',
      'resume',
      sessionId,
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
    ];
    if (model) args.push('-m', model);
    args.push('-'); // prompt on stdin
    return { exe: 'codex', args, promptVia: 'stdin' };
  }

  if (p === 'gemini') {
    const args = [
      '--resume',
      sessionId,
      '-p',
      'Follow the task instructions given on stdin.',
      '-o',
      'text',
      '--approval-mode',
      'yolo',
    ];
    if (model) args.push('-m', model);
    return { exe: 'gemini', args, promptVia: 'stdin' };
  }

  if (registryAgent?.cli && registryAgent.resume_args && registryAgent.cli.prompt_via === 'stdin') {
    const replacedResumeArgs = registryAgent.resume_args.map((a) =>
      a.replace(/\{session_id\}/g, sessionId)
    );
    const combinedArgs = [...replacedResumeArgs, ...registryAgent.cli.args];
    return {
      exe: registryAgent.cli.command,
      args: combinedArgs,
      promptVia: 'stdin',
    };
  }

  return null;
}

export function buildSummaryPrompt(options: {
  jobId: string;
  agent: string;
  role: string;
  projectPath: string;
  originalPrompt: string;
  logTail: string;
  message: string;
}): string {
  const maxOriginalPromptLen = 6000;
  const maxLogTailLen = 6000;
  const maxTotalLen = 20000;

  // Clean log tail: remove runner header & JOB_FINISHED marker
  let cleanLog = options.logTail
    .replace(
      /^=== \[MISSION CONTROL JOB [^\]]+\] ===[\s\S]*?------------------------------------------------------------\r?\n/,
      ''
    )
    .replace(/===\s*\[JOB_FINISHED\s+exit_code=[-]?\d+\]\s*===.*/, '')
    .trim();

  if (cleanLog.length > maxLogTailLen) {
    cleanLog = cleanLog.slice(-maxLogTailLen);
  }

  let origPrompt = options.originalPrompt.trim();
  if (origPrompt.length > maxOriginalPromptLen) {
    origPrompt = origPrompt.slice(0, maxOriginalPromptLen);
  }

  const roleSet = new Set(['architect', 'leader', 'backend', 'frontend', 'reviewer', 'tester']);
  const effectiveRole = roleSet.has(options.role) ? options.role : 'backend';

  const parts = [
    `You are continuing an earlier job (${options.jobId}, agent ${options.agent}, role ${effectiveRole}) in ${options.projectPath}.\n`,
    `Original task (may be cut):`,
    origPrompt,
    ``,
    `End of the previous output (may be cut):`,
    cleanLog,
    ``,
    `New instruction from the user:`,
    options.message.trim(),
  ];

  let fullPrompt = parts.join('\n');
  if (fullPrompt.length > maxTotalLen) {
    fullPrompt = fullPrompt.slice(0, maxTotalLen);
  }
  return fullPrompt;
}
