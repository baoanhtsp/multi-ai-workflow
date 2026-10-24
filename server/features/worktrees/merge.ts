import fs from 'node:fs';
import path from 'node:path';
import { appendAuditEntry } from '../../lib/audit.ts';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { getTempDir, isFileSafe } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { createCheckpoint, gitRun, snapshotTree } from '../checkpoints/snapshot.ts';
import {
  loadWorktreesStore,
  saveWorktreesStore,
  withStoreLock,
  type WorktreeRecord,
} from './store.ts';

export async function isJobStillRunning(
  ctx: MawFeatureContext,
  jobId?: string
): Promise<boolean> {
  if (!jobId) return false;
  try {
    const allJobs = await ctx.readJobs();
    const target = allJobs.find((j) => String(j.id ?? j.job_id ?? '').trim() === jobId);
    if (target && target.status !== undefined) {
      return String(target.status).trim() === 'RUNNING';
    }
  } catch {
    // fallback to meta file if readJobs throws
  }

  const metaFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.json`);
  if (isFileSafe(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { status?: string };
      return meta && meta.status === 'RUNNING';
    } catch {
      return false;
    }
  }
  return false;
}

export async function getJobAgent(
  ctx: MawFeatureContext,
  jobId?: string
): Promise<string> {
  if (!jobId) return '';
  try {
    const allJobs = await ctx.readJobs();
    const target = allJobs.find((j) => String(j.id ?? j.job_id ?? '').trim() === jobId);
    if (target && typeof target.agent === 'string' && target.agent.trim()) {
      return target.agent.trim();
    }
  } catch {}

  const metaFile = path.win32.join(ctx.paths.jobsDir, `${jobId}.json`);
  if (isFileSafe(metaFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { agent?: string };
      if (meta && typeof meta.agent === 'string' && meta.agent.trim()) {
        return meta.agent.trim();
      }
    } catch {}
  }
  return '';
}

export async function handleWorktreeMerge(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (body.confirm !== true) {
    throw new ApiValidationError('Confirmation required.', 400);
  }

  const id = String(body.id ?? '').trim();
  if (!id) {
    throw new ApiValidationError('Worktree id is required.', 400);
  }

  const strategy = String(body.strategy ?? 'merge').trim().toLowerCase();
  if (!['merge', 'squash', 'rebase'].includes(strategy)) {
    throw new ApiValidationError("Invalid strategy. Must be 'merge', 'squash', or 'rebase'.", 400);
  }

  const dataDir = ctx.paths.featureDataDir('worktrees');

  return await withStoreLock(async () => {
    const store = await loadWorktreesStore(dataDir);
    const record = store.worktrees.find((w) => w.id === id);
    if (!record) {
      throw new ApiValidationError(`Worktree '${id}' not found.`, 404);
    }

    if (record.status !== 'active') {
      throw new ApiValidationError(`Worktree '${id}' is not active (status: ${record.status}).`, 409);
    }

    // R2-6: Check if associated job is still RUNNING using ctx.readJobs()
    if (record.job_id && (await isJobStillRunning(ctx, record.job_id))) {
      throw new ApiValidationError('Job is still running.', 409);
    }

    const wtPath = record.worktree_path;
    const repoPath = record.project_path;

    // Destructive audit entries
    const auditEntry = {
      Timestamp: new Date().toISOString(),
      Tool: 'maw-s1',
      Action: 'worktree_merge',
      Project: repoPath,
      Detail: `Merge worktree ${record.id} (${record.branch}) with strategy ${strategy}`,
    };
    appendAuditEntry(ctx.paths.auditFile, auditEntry);
    appendAuditEntry(path.win32.join(dataDir, 'audit.jsonl'), auditEntry);

    // Commit any pending uncommitted work in the worktree
    const dirtyRes = await gitRun(['status', '--porcelain'], { cwd: wtPath });
    if (dirtyRes.stdout.trim() !== '') {
      await gitRun(['add', '-A', '--', '.'], { cwd: wtPath });
      const stagedRes = await gitRun(['diff', '--cached', '--name-only'], { cwd: wtPath });
      if (stagedRes.stdout.trim() !== '') {
        const commitMsg = `maw: work from ${record.job_id || record.id}`;
        await gitRun(['commit', '-m', commitMsg], {
          cwd: wtPath,
          env: {
            GIT_AUTHOR_NAME: 'MAW',
            GIT_AUTHOR_EMAIL: 'maw@localhost',
            GIT_COMMITTER_NAME: 'MAW',
            GIT_COMMITTER_EMAIL: 'maw@localhost',
          },
        });
      }
    }

    // SPEC Guard verification on the branch diff (W5, R2-5)
    let specGuardResult: Record<string, unknown> | null = null;
    const specFile = path.win32.join(repoPath, 'SPEC.md');
    // R2-5: Fallback order with || so empty-string doesn't stop chain:
    // owner = body.owner || record.owner || jobAgent || ''
    const jobAgent = await getJobAgent(ctx, record.job_id);
    const owner = (
      String(body.owner ?? '').trim() ||
      String(record.owner ?? '').trim() ||
      jobAgent ||
      ''
    );

    if (isFileSafe(specFile) && owner) {
      const tipRes = await gitRun(['rev-parse', 'HEAD'], { cwd: wtPath });
      const tip = tipRes.stdout.trim();

      const mbRes = await gitRun(['merge-base', record.base, 'HEAD'], { cwd: wtPath, allowFailure: true });
      const mergeBase = mbRes.code === 0 && mbRes.stdout.trim() ? mbRes.stdout.trim() : record.base_commit;

      // Y1 (a): If branch diff (merge-base -> worktree snapshot) touches SPEC.md, block unless force
      const currentTree = await snapshotTree(wtPath);
      const diffFilesRes = await gitRun(['diff', '--name-only', mergeBase, currentTree], { cwd: wtPath });
      const touchedFiles = diffFilesRes.stdout.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
      const touchesSpec = touchedFiles.some((f) => f.toLowerCase() === 'spec.md');

      if (touchesSpec && body.force !== true) {
        return {
          ok: true,
          merged: false,
          blocked: 'spec_guard',
          reason: 'Branch modified or deleted SPEC.md, which defines ownership rules.',
          spec_guard: {
            verdict: 'FAIL',
            reason: 'Branch modified or deleted SPEC.md.',
            files: ['SPEC.md'],
          },
        };
      }

      await gitRun(['reset', '--soft', mergeBase], { cwd: wtPath });
      try {
        const specGuardScript = path.win32.join(ctx.paths.scriptsDir, 'invoke-spec-guard.ps1');
        let sgRes: { code: number; stdout: string; stderr: string };
        try {
          sgRes = await runCommand(
            'powershell.exe',
            [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              specGuardScript,
              '-WorkDir',
              wtPath,
              '-Owner',
              owner,
              '-Json',
            ],
            { cwd: wtPath, timeoutMs: 120000 }
          );
        } catch (err: any) {
          sgRes = {
            code: 1,
            stdout: '',
            stderr: String(err?.message ?? 'SPEC Guard failed to run.'),
          };
        }

        const outLines = sgRes.stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
        const lastJsonLine = outLines.length > 0 ? outLines[outLines.length - 1]! : '';
        if (lastJsonLine) {
          try {
            specGuardResult = JSON.parse(lastJsonLine) as Record<string, unknown>;
          } catch {
            const tail = (sgRes.stderr || sgRes.stdout).trim().slice(-400);
            specGuardResult = { error: tail || 'Failed to parse SPEC Guard JSON output.' };
          }
        } else {
          const tail = (sgRes.stderr || sgRes.stdout).trim().slice(-400);
          specGuardResult = { error: tail || 'SPEC Guard produced no JSON output.' };
        }

        let isAllowed = false;
        if (specGuardResult && specGuardResult.verdict === 'PASS') {
          isAllowed = true;
        } else if (specGuardResult && specGuardResult.verdict === 'WARN') {
          // Y1 (b): Accept WARN only when the guard JSON has has_spec: true and non-empty ownership_rules
          const hasSpec = specGuardResult.has_spec === true;
          const hasOwnershipRules =
            Array.isArray(specGuardResult.ownership_rules) &&
            specGuardResult.ownership_rules.length > 0;
          isAllowed = hasSpec && hasOwnershipRules;
        }

        if (!isAllowed && body.force !== true) {
          return {
            ok: true,
            merged: false,
            blocked: 'spec_guard',
            spec_guard: specGuardResult,
          };
        }
      } finally {
        await gitRun(['reset', '--soft', tip], { cwd: wtPath });
      }
    }

    // Main checkout verification: must be on base branch and clean
    const currentBranchRes = await gitRun(['symbolic-ref', '--short', '-q', 'HEAD'], {
      cwd: repoPath,
      allowFailure: true,
    });
    const currentBranch = currentBranchRes.code === 0 ? currentBranchRes.stdout.trim() : '';
    if (currentBranch !== record.base) {
      throw new ApiValidationError(
        `Main checkout is on branch '${currentBranch || 'detached'}', expected '${record.base}'.`,
        409
      );
    }

    const cleanRes = await gitRun(['status', '--porcelain', '--untracked-files=no'], {
      cwd: repoPath,
    });
    if (cleanRes.stdout.trim() !== '') {
      throw new ApiValidationError(
        'Main checkout has tracked uncommitted changes. Please commit or stash them before merging.',
        409
      );
    }

    // Safety checkpoint of the main checkout
    await createCheckpoint(repoPath, {
      jobKey: 'merge',
      event: 'merge',
      label: `before merge of maw/${record.id}`,
    });

    // Message sanitization (W5): cap at 300 chars, strip control characters
    let rawMsg = String(body.message ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    if (rawMsg.length > 300) {
      rawMsg = rawMsg.slice(0, 300);
    }
    const mergeMsg =
      rawMsg ||
      `Merge maw/${record.id} (${record.origin}${record.job_id ? ' ' + record.job_id : ''})`;

    if (strategy === 'merge') {
      const mergeRes = await gitRun(['merge', '--no-ff', '-m', mergeMsg, record.branch], {
        cwd: repoPath,
        allowFailure: true,
      });

      if (mergeRes.code !== 0) {
        const confRes = await gitRun(['diff', '--name-only', '--diff-filter=U'], {
          cwd: repoPath,
          allowFailure: true,
        });
        await gitRun(['merge', '--abort'], { cwd: repoPath, allowFailure: true });
        const conflicts = confRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        return {
          ok: true,
          merged: false,
          blocked: 'conflicts',
          conflicts,
          fix_hint: { action: 'worktree_fix_conflicts', id: record.id },
        };
      }
    } else if (strategy === 'squash') {
      const squashRes = await gitRun(['merge', '--squash', record.branch], {
        cwd: repoPath,
        allowFailure: true,
      });

      if (squashRes.code !== 0) {
        const confRes = await gitRun(['diff', '--name-only', '--diff-filter=U'], {
          cwd: repoPath,
          allowFailure: true,
        });
        await gitRun(['reset', '--hard', 'HEAD'], { cwd: repoPath, allowFailure: true });
        const conflicts = confRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        return {
          ok: true,
          merged: false,
          blocked: 'conflicts',
          conflicts,
          fix_hint: { action: 'worktree_fix_conflicts', id: record.id },
        };
      }

      const stagedMainRes = await gitRun(['diff', '--cached', '--name-only'], {
        cwd: repoPath,
      });
      if (stagedMainRes.stdout.trim() !== '') {
        await gitRun(['commit', '-m', mergeMsg], { cwd: repoPath });
      }
    } else if (strategy === 'rebase') {
      // Rebase branch onto base in worktree
      const rebaseRes = await gitRun(['rebase', record.base], {
        cwd: wtPath,
        allowFailure: true,
      });

      if (rebaseRes.code !== 0) {
        const confRes = await gitRun(['diff', '--name-only', '--diff-filter=U'], {
          cwd: wtPath,
          allowFailure: true,
        });
        await gitRun(['rebase', '--abort'], { cwd: wtPath, allowFailure: true });
        const conflicts = confRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        return {
          ok: true,
          merged: false,
          blocked: 'conflicts',
          conflicts,
          fix_hint: { action: 'worktree_fix_conflicts', id: record.id },
        };
      }

      // Fast-forward merge into main checkout
      const ffRes = await gitRun(['merge', '--ff-only', record.branch], {
        cwd: repoPath,
        allowFailure: true,
      });

      if (ffRes.code !== 0) {
        throw new ApiValidationError(
          `Fast-forward merge after rebase failed: ${ffRes.stderr.trim()}`,
          500
        );
      }
    }

    const commitRes = await gitRun(['rev-parse', 'HEAD'], { cwd: repoPath });
    const mergeCommit = commitRes.stdout.trim();

    record.status = 'merged';
    record.merged = {
      strategy,
      commit: mergeCommit,
      at: new Date().toISOString(),
    };
    record.updated_at = new Date().toISOString();

    const removeWorktree = body.remove !== false;
    let removed = false;
    let removeError: string | undefined = undefined;

    if (removeWorktree) {
      const rmRes = await gitRun(['worktree', 'remove', '--force', wtPath], {
        cwd: repoPath,
        allowFailure: true,
      });
      if (rmRes.code === 0) {
        removed = true;
        await gitRun(['branch', '-D', record.branch], {
          cwd: repoPath,
          allowFailure: true,
        });
        await gitRun(['worktree', 'prune'], { cwd: repoPath, allowFailure: true });
      } else {
        // W6: report removed: false and remove_error
        removed = false;
        removeError = rmRes.stderr.trim().slice(0, 400);
      }
    }

    await saveWorktreesStore(dataDir, store);

    const resp: Record<string, unknown> = {
      ok: true,
      merged: true,
      commit: mergeCommit,
      spec_guard: specGuardResult,
      removed,
    };
    if (removeError) {
      resp.remove_error = removeError;
    }
    return resp;
  });
}

export async function handleWorktreeFixConflicts(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (body.confirm !== true) {
    throw new ApiValidationError('Confirmation required.', 400);
  }

  const id = String(body.id ?? '').trim();
  if (!id) {
    throw new ApiValidationError('Worktree id is required.', 400);
  }

  const agent = String(body.agent ?? '').trim();
  if (!agent) {
    throw new ApiValidationError('Agent is required for fixing conflicts.', 400);
  }

  // W7: Validate agent against registry for capabilities.write
  const targetAgent = (ctx.registry?.agents ?? []).find((a) => a.id === agent);
  if (!targetAgent || !targetAgent.capabilities?.write) {
    throw new ApiValidationError(
      `Agent '${agent}' is not enabled or does not have write capability.`,
      400
    );
  }

  const model = body.model ? String(body.model).trim() : undefined;
  const dataDir = ctx.paths.featureDataDir('worktrees');

  return await withStoreLock(async () => {
    const store = await loadWorktreesStore(dataDir);
    const record = store.worktrees.find((w) => w.id === id);
    if (!record) {
      throw new ApiValidationError(`Worktree '${id}' not found.`, 404);
    }
    if (record.status !== 'active') {
      throw new ApiValidationError(`Worktree '${id}' is not active.`, 409);
    }

    // W7, R2-6: Refuse with 409 if record's job is RUNNING (via ctx.readJobs())
    if (record.job_id && (await isJobStillRunning(ctx, record.job_id))) {
      throw new ApiValidationError('Job is still running.', 409);
    }

    const wtPath = record.worktree_path;

    // In worktree: git merge --no-commit <base>
    const mergeRes = await gitRun(['merge', '--no-commit', record.base], {
      cwd: wtPath,
      allowFailure: true,
    });

    const confRes = await gitRun(['diff', '--name-only', '--diff-filter=U'], {
      cwd: wtPath,
      allowFailure: true,
    });
    const conflicts = confRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    // W7: If exit code is 0 and conflicts are empty, commit and return resolved
    if (mergeRes.code === 0 && conflicts.length === 0) {
      const stagedCheck = await gitRun(['diff', '--cached', '--name-only'], { cwd: wtPath });
      if (stagedCheck.stdout.trim() !== '') {
        await gitRun(['commit', '--no-edit'], { cwd: wtPath, allowFailure: true });
      }
      return {
        ok: true,
        job_id: null,
        conflicts: [],
        resolved: true,
      };
    }

    const prompt = [
      `Resolve git merge conflicts between branch '${record.branch}' and '${record.base}'.`,
      '',
      'Conflicting files:',
      ...conflicts.map((f) => `- ${f}`),
      '',
      "Instructions: Resolve every conflict marker (<<<<<<<, =======, >>>>>>>), preserve both sides' intent, run project checks, and execute git commit when done.",
    ].join('\n');

    const jobRes = await ctx.startJob({
      mode: 'task',
      agent,
      role: 'backend',
      model,
      project_path: wtPath,
      prompt,
    });

    const jobId = String(jobRes.job_id ?? '');
    record.job_id = jobId;
    record.updated_at = new Date().toISOString();
    await saveWorktreesStore(dataDir, store);

    return {
      ok: true,
      job_id: jobId,
      conflicts,
    };
  });
}

export async function handleWorktreeDiscard(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (body.confirm !== true) {
    throw new ApiValidationError('Confirmation required.', 400);
  }

  const id = String(body.id ?? '').trim();
  if (!id) {
    throw new ApiValidationError('Worktree id is required.', 400);
  }

  const dataDir = ctx.paths.featureDataDir('worktrees');

  return await withStoreLock(async () => {
    const store = await loadWorktreesStore(dataDir);
    const record = store.worktrees.find((w) => w.id === id);
    if (!record) {
      throw new ApiValidationError(`Worktree '${id}' not found.`, 404);
    }

    // W8: Refuse with 409 if status is already merged or discarded
    if (record.status === 'merged' || record.status === 'discarded') {
      throw new ApiValidationError(
        `Worktree '${id}' is already ${record.status}.`,
        409
      );
    }

    // W8, R2-6: Refuse with 409 if job is RUNNING (via ctx.readJobs())
    if (record.job_id && (await isJobStillRunning(ctx, record.job_id))) {
      throw new ApiValidationError('Job is still running.', 409);
    }

    const wtPath = record.worktree_path;
    const repoPath = record.project_path;

    // Destructive audit
    const auditEntry = {
      Timestamp: new Date().toISOString(),
      Tool: 'maw-s1',
      Action: 'worktree_discard',
      Project: repoPath,
      Detail: `Discard worktree ${record.id} (${record.branch})`,
    };
    appendAuditEntry(ctx.paths.auditFile, auditEntry);
    appendAuditEntry(path.win32.join(dataDir, 'audit.jsonl'), auditEntry);

    const keptRef = `refs/maw/discarded/${record.id}`;

    // W8: Plain snapshot commit of worktree before deletion. Do NOT create refs under refs/maw/checkpoints/*
    if (fs.existsSync(wtPath)) {
      try {
        const treeSha = await snapshotTree(wtPath);
        const headRes = await gitRun(['rev-parse', '--verify', '-q', 'HEAD'], {
          cwd: wtPath,
          allowFailure: true,
        });
        const parentSha = headRes.code === 0 && headRes.stdout.trim() ? headRes.stdout.trim() : null;

        const tempDir = getTempDir();
        const msgFile = path.win32.join(tempDir, `maw-discard-msg-${Date.now()}.txt`);
        fs.writeFileSync(msgFile, `maw discarded worktree: ${record.id}\n`, 'utf8');

        const commitArgs = parentSha
          ? ['commit-tree', treeSha, '-p', parentSha, '-F', msgFile]
          : ['commit-tree', treeSha, '-F', msgFile];

        const commitRes = await gitRun(commitArgs, {
          cwd: repoPath,
          env: {
            GIT_AUTHOR_NAME: 'MAW Discard',
            GIT_AUTHOR_EMAIL: 'maw@localhost',
            GIT_COMMITTER_NAME: 'MAW Discard',
            GIT_COMMITTER_EMAIL: 'maw@localhost',
          },
        });

        try {
          fs.unlinkSync(msgFile);
        } catch {}

        if (commitRes.code !== 0 || !commitRes.stdout.trim()) {
          throw new Error(`commit-tree failed: ${commitRes.stderr || 'unknown git error'}`);
        }

        const discardCommitSha = commitRes.stdout.trim();
        const updateRes = await gitRun(['update-ref', keptRef, discardCommitSha], { cwd: repoPath });
        if (updateRes.code !== 0) {
          throw new Error(`update-ref ${keptRef} failed: ${updateRes.stderr || 'unknown git error'}`);
        }
      } catch (err: any) {
        throw new ApiValidationError(
          `Failed to preserve discard snapshot before removal: ${err?.message || 'unknown error'}`,
          500
        );
      }

      const removeRes = await gitRun(['worktree', 'remove', '--force', wtPath], {
        cwd: repoPath,
        allowFailure: true,
      });
      if (removeRes.code !== 0) {
        throw new ApiValidationError(
          `Failed to remove worktree: ${removeRes.stderr || 'git worktree remove failed'}`,
          500
        );
      }
    } else {
      const branchHeadRes = await gitRun(['rev-parse', '--verify', '-q', record.branch], {
        cwd: repoPath,
        allowFailure: true,
      });
      if (branchHeadRes.code === 0 && branchHeadRes.stdout.trim()) {
        const updateRes = await gitRun(['update-ref', keptRef, branchHeadRes.stdout.trim()], { cwd: repoPath });
        if (updateRes.code !== 0) {
          throw new ApiValidationError(
            `Failed to update discard ref ${keptRef}: ${updateRes.stderr || 'unknown error'}`,
            500
          );
        }
      }
    }

    if (body.delete_branch !== false) {
      await gitRun(['branch', '-D', record.branch], {
        cwd: repoPath,
        allowFailure: true,
      });
    }

    await gitRun(['worktree', 'prune'], { cwd: repoPath, allowFailure: true });

    record.status = 'discarded';
    record.updated_at = new Date().toISOString();
    await saveWorktreesStore(dataDir, store);

    return {
      ok: true,
      discarded: id,
      kept_ref: keptRef,
    };
  });
}
