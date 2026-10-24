import fs from 'node:fs';
import path from 'node:path';
import { appendAuditEntry } from '../../lib/audit.ts';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { isFileSafe } from '../../lib/paths.ts';
import { runCommand } from '../../lib/proc.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { createCheckpoint, gitRun, snapshotTree } from '../checkpoints/snapshot.ts';
import {
  loadWorktreesStore,
  saveWorktreesStore,
  withStoreLock,
  type WorktreeRecord,
} from './store.ts';

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

    // Check if associated job is still RUNNING
    if (record.job_id) {
      const metaFile = path.win32.join(ctx.paths.jobsDir, `${record.job_id}.json`);
      if (isFileSafe(metaFile)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { status?: string };
          if (meta && meta.status === 'RUNNING') {
            throw new ApiValidationError('Job is still running.', 409);
          }
        } catch (err) {
          if (err instanceof ApiValidationError) throw err;
        }
      }
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

    // SPEC Guard verification on the branch diff
    let specGuardResult: Record<string, unknown> | null = null;
    const specFile = path.win32.join(repoPath, 'SPEC.md');
    const owner = String(body.owner ?? record.owner ?? '').trim();

    if (isFileSafe(specFile) && owner) {
      const tipRes = await gitRun(['rev-parse', 'HEAD'], { cwd: wtPath });
      const tip = tipRes.stdout.trim();

      const mbRes = await gitRun(['merge-base', record.base, 'HEAD'], { cwd: wtPath, allowFailure: true });
      const mergeBase = mbRes.code === 0 && mbRes.stdout.trim() ? mbRes.stdout.trim() : record.base_commit;

      await gitRun(['reset', '--soft', mergeBase], { cwd: wtPath });
      try {
        const specGuardScript = path.win32.join(ctx.paths.scriptsDir, 'invoke-spec-guard.ps1');
        const sgRes = await runCommand(
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

        if (sgRes.stdout.trim()) {
          try {
            specGuardResult = JSON.parse(sgRes.stdout.trim()) as Record<string, unknown>;
          } catch {
            // Non-JSON output
          }
        }

        if (specGuardResult && specGuardResult.verdict === 'FAIL' && body.force !== true) {
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

    const mergeMsg =
      String(body.message ?? '').trim() ||
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
    if (removeWorktree) {
      await gitRun(['worktree', 'remove', '--force', wtPath], {
        cwd: repoPath,
        allowFailure: true,
      });
      await gitRun(['branch', '-D', record.branch], {
        cwd: repoPath,
        allowFailure: true,
      });
      await gitRun(['worktree', 'prune'], { cwd: repoPath, allowFailure: true });
    }

    await saveWorktreesStore(dataDir, store);

    return {
      ok: true,
      merged: true,
      commit: mergeCommit,
      spec_guard: specGuardResult,
      removed: removeWorktree,
    };
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

    const wtPath = record.worktree_path;

    // In worktree: git merge --no-commit <base>
    await gitRun(['merge', '--no-commit', record.base], {
      cwd: wtPath,
      allowFailure: true,
    });

    const confRes = await gitRun(['diff', '--name-only', '--diff-filter=U'], {
      cwd: wtPath,
      allowFailure: true,
    });
    const conflicts = confRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

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

    // Snapshot commit of worktree before deletion
    if (fs.existsSync(wtPath)) {
      try {
        const snapRes = await createCheckpoint(wtPath, {
          jobKey: 'discarded',
          event: 'safety',
          label: `before discard of maw/${record.id}`,
        });
        await gitRun(['update-ref', keptRef, snapRes.checkpoint.commit], {
          cwd: repoPath,
          allowFailure: true,
        });
      } catch {
        // Fallback: rev-parse HEAD
        const headRes = await gitRun(['rev-parse', 'HEAD'], { cwd: wtPath, allowFailure: true });
        if (headRes.code === 0 && headRes.stdout.trim()) {
          await gitRun(['update-ref', keptRef, headRes.stdout.trim()], {
            cwd: repoPath,
            allowFailure: true,
          });
        }
      }

      await gitRun(['worktree', 'remove', '--force', wtPath], {
        cwd: repoPath,
        allowFailure: true,
      });
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
