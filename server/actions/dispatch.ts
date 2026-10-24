import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendAuditEntry } from '../lib/audit.ts';
import { type ServerPaths } from '../lib/paths.ts';
import { runCommand } from '../lib/proc.ts';
import { ApiValidationError, buildValidatedCommand } from '../lib/validate.ts';

export async function handleDispatch(
  body: Record<string, unknown>,
  paths: ServerPaths
): Promise<Record<string, unknown>> {
  const info = buildValidatedCommand(body, paths);
  const { mode, role, model: modelOverride, project_path: validatedProjectPath, prompt, command: cmd } = info;

  const executeAntigravity = body.execute_antigravity === true;
  if (executeAntigravity) {
    if (mode !== 'antigravity' || !['send-latest', 'new'].includes(role)) {
      throw new ApiValidationError(
        'Live quick-send (execute_antigravity) is only for antigravity mode with send-latest or new. Use action=run_job for background streaming execution of any mode.',
        400
      );
    }
    if (prompt === '') {
      throw new ApiValidationError('Prompt is required when execute_antigravity is true.', 400);
    }
  }

  let dispatched = false;
  let dispatchOutput = '';

  if (mode === 'antigravity' && executeAntigravity) {
    const tempDir = paths.tempDir;
    try {
      const nowMs = Date.now();
      for (const name of fs.readdirSync(tempDir)) {
        if (!name.startsWith('agy_dispatch_') || !name.endsWith('.txt')) continue;
        const full = path.win32.join(tempDir, name);
        try {
          if (nowMs - fs.statSync(full).mtimeMs > 300_000) {
            fs.unlinkSync(full);
          }
        } catch {
          // Ignore old file cleanup error
        }
      }
    } catch {
      // Ignore directory scan error
    }

    const tempPromptFile = path.win32.join(
      tempDir,
      `agy_dispatch_${crypto.randomBytes(8).toString('hex')}.txt`
    );
    try {
      fs.writeFileSync(tempPromptFile, '\uFEFF' + prompt, 'utf8');
    } catch {
      throw new ApiValidationError('Failed to create temporary prompt file.', 500);
    }

    const agyScript = path.win32.join(paths.scriptsDir, 'invoke-antigravity.ps1');
    const args: string[] = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      agyScript,
      '-Action',
      role,
      '-WorkDir',
      validatedProjectPath,
    ];
    if (role === 'new' && modelOverride !== '') {
      args.push('-Model', modelOverride);
    }
    args.push('-NoWait', '-Title', 'Task from Mission Control', '-PromptFile', tempPromptFile);

    const execRes = await runCommand('powershell.exe', args, { timeoutMs: 30000 });
    try {
      fs.unlinkSync(tempPromptFile);
    } catch {
      // Ignore cleanup error
    }

    dispatchOutput = [execRes.stdout, execRes.stderr].filter(Boolean).join('\n').trim();
    dispatched = execRes.code === 0;

    if (dispatched) {
      const promptBytes = Buffer.byteLength(prompt, 'utf8');
      const outputBytes = Buffer.byteLength(dispatchOutput, 'utf8');
      const inTokens = Math.max(1, Math.ceil(promptBytes / 3.8));
      appendAuditEntry(paths.auditFile, {
        Timestamp: new Date().toISOString(),
        Tool: 'antigravity',
        Role: role,
        Model: modelOverride || 'gemini-4-argon',
        WorkDir: validatedProjectPath,
        PromptChars: promptBytes,
        OutputChars: outputBytes,
        InputTokens: inTokens,
        OutputTokens: 120,
        CostUsd: Math.round(((inTokens * 1.25 + 120 * 5.0) / 1_000_000) * 100000) / 100000,
        Score: '',
        Verdict: 'COMPLETED',
      });
    } else {
      const err = new ApiValidationError(
        `Failed to dispatch task to Antigravity (exit code ${execRes.code}).`,
        502
      );
      const extra = err as unknown as Record<string, unknown>;
      extra.command = cmd;
      extra.dispatched = false;
      extra.output = dispatchOutput;
      throw err;
    }
  }

  return {
    ok: true,
    command: cmd,
    dispatched,
    output: dispatchOutput,
  };
}
