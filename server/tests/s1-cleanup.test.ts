import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { MawFeatureContext } from '../lib/feature.ts';
import { resolveServerPaths, type ServerPaths } from '../lib/paths.ts';
import { runCommand } from '../lib/proc.ts';
import { saveCheckpointsConfig } from '../features/checkpoints/index.ts';
import { createCheckpoint } from '../features/checkpoints/snapshot.ts';
import {
  type CleanupCandidate,
  DEFAULT_CLEANUP_CONFIG,
  getCleanupCandidates,
  handleCleanupApply,
  handleCleanupPreview,
  handleCleanupRestore,
  handleCleanupTrash,
  loadCleanupConfig,
  runAutomaticSweep,
  saveCleanupConfig,
  scanCleanup,
} from '../features/worktrees/cleanup.ts';
import { feature } from '../features/worktrees/index.ts';
import { createWorktreeRecord } from '../features/worktrees/isolate.ts';
import { handleWorktreeMerge } from '../features/worktrees/merge.ts';
import { loadWorktreesStore, saveWorktreesStore, type WorktreeRecord } from '../features/worktrees/store.ts';

// Enforce R12 isolation: disable automatic sweep timer during tests
process.env.MAW_CLEANUP_SWEEP = '0';

interface CleanupTestEnv {
  tempBase: string;
  projectsRoot: string;
  repoDir: string;
  mawHome: string;
  jobsDir: string;
  paths: ServerPaths;
  ctx: MawFeatureContext;
}

async function setupCleanupEnv(): Promise<CleanupTestEnv> {
  const rand = crypto.randomBytes(6).toString('hex');
  const tempBase = path.win32.join(os.tmpdir(), `maw-s1-clean-${rand}`);
  const projectsRoot = path.win32.join(tempBase, 'projects');
  const repoDir = path.win32.join(projectsRoot, 'sample-repo');
  const mawHome = path.win32.join(tempBase, 'maw-home');
  const jobsDir = path.win32.join(tempBase, 'maw-jobs');

  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });

  await runCommand('git', ['init', '-b', 'main', '-q'], { cwd: repoDir });
  await runCommand('git', ['config', 'user.name', 'Test Author'], { cwd: repoDir });
  await runCommand('git', ['config', 'user.email', 'author@test.local'], { cwd: repoDir });
  await runCommand('git', ['config', 'commit.gpgSign', 'false'], { cwd: repoDir });

  fs.writeFileSync(path.win32.join(repoDir, 'README.md'), '# Sample\n', 'utf8');
  await runCommand('git', ['add', '.'], { cwd: repoDir });
  await runCommand('git', ['commit', '-m', 'initial commit on main'], { cwd: repoDir });

  const paths = resolveServerPaths({
    repoRoot: repoDir,
    projectsRoot,
    mawHome,
  });
  paths.jobsDir = jobsDir;
  const testScriptsDir = path.win32.join(tempBase, 'scripts');
  fs.mkdirSync(testScriptsDir, { recursive: true });
  paths.scriptsDir = testScriptsDir;

  const ctx: MawFeatureContext = {
    paths,
    registry: {
      version: 1,
      defaults: {
        team: { backend: 'antigravity', frontend: 'claude', reviewer: 'codex' },
        council: ['claude', 'codex'],
        implementer: 'antigravity',
      },
      agents: [
        {
          id: 'antigravity',
          label: 'Antigravity',
          color: '#4285f4',
          enabled: true,
          adapter: 'antigravity',
          models: ['pro'],
          efforts: [],
          capabilities: { write: true, review: true, new_session: true, sessions: true, ide_send: true },
        },
      ] as any,
      allAgents: [],
      shippedPath: '',
      userPath: '',
      warnings: [],
    },
    readJobs: async () => [],
    startJob: async () => ({ ok: true }),
  };

  return { tempBase, projectsRoot, repoDir, mawHome, jobsDir, paths, ctx };
}

function cleanupTestEnv(env: CleanupTestEnv): void {
  try {
    fs.rmSync(env.tempBase, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

test('S1 Cleanup: settings validation and persistence in cleanup-config.json', async () => {
  const env = await setupCleanupEnv();
  try {
    const defaultCfg = loadCleanupConfig(env.ctx);
    assert.deepEqual(defaultCfg, DEFAULT_CLEANUP_CONFIG);

    const saved = saveCleanupConfig(env.ctx, {
      keep_after_merge_days: 7,
      stale_branch_days: 30,
      trash_days: 14,
      sweep_hours: 12,
      sweep_enabled: false,
    });
    assert.equal(saved.keep_after_merge_days, 7);
    assert.equal(saved.stale_branch_days, 30);
    assert.equal(saved.trash_days, 14);
    assert.equal(saved.sweep_hours, 12);
    assert.equal(saved.sweep_enabled, false);

    // Verify persisted on disk
    const reloaded = loadCleanupConfig(env.ctx);
    assert.deepEqual(reloaded, saved);

    // Validation rejects out-of-range values
    assert.throws(() => saveCleanupConfig(env.ctx, { keep_after_merge_days: 100 }), /0 and 90/);
    assert.throws(() => saveCleanupConfig(env.ctx, { stale_branch_days: 0 }), /1 and 365/);
    assert.throws(() => saveCleanupConfig(env.ctx, { trash_days: 400 }), /1 and 365/);
    assert.throws(() => saveCleanupConfig(env.ctx, { sweep_hours: 200 }), /1 and 168/);
    assert.throws(() => saveCleanupConfig(env.ctx, { sweep_enabled: 'not-bool' as any }), /boolean/);
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Cleanup: candidate detection across all 8 kinds', async () => {
  const env = await setupCleanupEnv();
  try {
    const dataDir = env.paths.featureDataDir('worktrees');

    // 1. merged_branch: create branch maw/wt-merged, merge it to main
    await runCommand('git', ['checkout', '-b', 'maw/wt-merged'], { cwd: env.repoDir });
    fs.writeFileSync(path.win32.join(env.repoDir, 'merged.txt'), 'merged\n', 'utf8');
    await runCommand('git', ['add', '.'], { cwd: env.repoDir });
    await runCommand('git', ['commit', '-m', 'feat: merged work'], { cwd: env.repoDir });
    await runCommand('git', ['checkout', 'main'], { cwd: env.repoDir });
    await runCommand('git', ['merge', '--no-ff', '-m', 'merge maw/wt-merged', 'maw/wt-merged'], {
      cwd: env.repoDir,
    });

    // 2. stale_branch: unmerged branch maw/wt-stale-branch with commit 20 days ago
    await runCommand('git', ['checkout', '-b', 'maw/wt-stale-branch'], { cwd: env.repoDir });
    fs.writeFileSync(path.win32.join(env.repoDir, 'stale.txt'), 'stale\n', 'utf8');
    await runCommand('git', ['add', '.'], { cwd: env.repoDir });
    const pastDate = new Date(Date.now() - 20 * 86400 * 1000).toISOString();
    await runCommand('git', ['commit', '-m', 'feat: stale work'], {
      cwd: env.repoDir,
      env: { GIT_COMMITTER_DATE: pastDate, GIT_AUTHOR_DATE: pastDate },
    });
    await runCommand('git', ['checkout', 'main'], { cwd: env.repoDir });

    // 3. kept_worktree: worktree record with status merged and past remove_after
    const wtKeptRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'wt-kept',
      base: 'main',
    });
    const store = await loadWorktreesStore(dataDir);
    const keptRec = store.worktrees.find((w: WorktreeRecord) => w.id === 'wt-kept')!;
    keptRec.status = 'merged';
    keptRec.remove_after = new Date(Date.now() - 3600 * 1000).toISOString();
    await saveWorktreesStore(dataDir, store);

    // 4. orphan_worktree: folder inside .maw-wt/sample-repo not registered in git
    const containerDir = path.win32.join(env.projectsRoot, '.maw-wt', 'sample-repo');
    const orphanDir = path.win32.join(containerDir, 'wt-orphan');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.win32.join(orphanDir, 'orphan.txt'), 'orphan content\n', 'utf8');

    // 5. stale_worktree: active worktree record older than stale_branch_days with no running job
    const wtStaleRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'wt-stale-wt',
      base: 'main',
    });
    const wtStalePath = wtStaleRes.worktree.worktree_path;
    fs.writeFileSync(path.win32.join(wtStalePath, 'work.txt'), 'stale work\n', 'utf8');
    await runCommand('git', ['add', '.'], { cwd: wtStalePath });
    await runCommand('git', ['commit', '-m', 'stale commit'], {
      cwd: wtStalePath,
      env: { GIT_COMMITTER_DATE: pastDate, GIT_AUTHOR_DATE: pastDate },
    });

    // 6. checkpoint_orphan: checkpoint whose MAW-Workdir no longer exists
    const missingWorkdir = path.win32.join(env.projectsRoot, 'deleted-wt');
    await runCommand('git', ['checkout', '-b', 'maw/temp-ck'], { cwd: env.repoDir });
    fs.writeFileSync(path.win32.join(env.repoDir, 'temp.txt'), 'ck\n', 'utf8');
    await runCommand('git', ['add', '.'], { cwd: env.repoDir });
    const msgFile = path.win32.join(env.tempBase, 'ck-msg.txt');
    fs.writeFileSync(
      msgFile,
      `checkpoint\n\nMAW-Event: manual\nMAW-Workdir: ${missingWorkdir}\nMAW-Parent: main\n`,
      'utf8'
    );
    const treeRes = await runCommand('git', ['write-tree'], { cwd: env.repoDir });
    const commitRes = await runCommand('git', ['commit-tree', treeRes.stdout.trim(), '-F', msgFile], {
      cwd: env.repoDir,
    });
    const ckRef = 'refs/maw/checkpoints/orphan-job/0001';
    await runCommand('git', ['update-ref', ckRef, commitRes.stdout.trim()], { cwd: env.repoDir });
    await runCommand('git', ['checkout', 'main'], { cwd: env.repoDir });

    // 7. trash_expired: refs/maw/trash/* older than trash_days (e.g. 35 days ago)
    const expiredTrashDate = new Date(Date.now() - 35 * 86400 * 1000).toISOString();
    const trashMsgFile = path.win32.join(env.tempBase, 'trash-msg.txt');
    fs.writeFileSync(trashMsgFile, 'trash backup\n', 'utf8');
    const trashCommitRes = await runCommand(
      'git',
      ['commit-tree', treeRes.stdout.trim(), '-F', trashMsgFile],
      {
        cwd: env.repoDir,
        env: { GIT_COMMITTER_DATE: expiredTrashDate, GIT_AUTHOR_DATE: expiredTrashDate },
      }
    );
    const trashRef = 'refs/maw/trash/maw-old-20260901120000';
    await runCommand('git', ['update-ref', trashRef, trashCommitRes.stdout.trim()], {
      cwd: env.repoDir,
    });

    // Run preview
    const preview = await handleCleanupPreview(env.ctx, new URLSearchParams(`project_path=${env.repoDir}`));
    assert.equal(preview.ok, true);
    const kinds = new Set(preview.candidates.map((c: CleanupCandidate) => c.kind));

    assert.ok(kinds.has('merged_branch'), 'merged_branch should be detected');
    assert.ok(kinds.has('stale_branch'), 'stale_branch should be detected');
    assert.ok(kinds.has('kept_worktree'), 'kept_worktree should be detected');
    assert.ok(kinds.has('orphan_worktree'), 'orphan_worktree should be detected');
    assert.ok(kinds.has('stale_worktree'), 'stale_worktree should be detected');
    assert.ok(kinds.has('checkpoint_orphan'), 'checkpoint_orphan should be detected');
    assert.ok(kinds.has('trash_expired'), 'trash_expired should be detected');

    // Check defaults
    const mergedCand = preview.candidates.find((c: CleanupCandidate) => c.kind === 'merged_branch')!;
    assert.equal(mergedCand.merged, true);
    assert.equal(mergedCand.risky, false);
    assert.equal(mergedCand.default_selected, true);

    const staleCand = preview.candidates.find((c: CleanupCandidate) => c.kind === 'stale_branch')!;
    assert.equal(staleCand.merged, false);
    assert.equal(staleCand.risky, true);
    assert.equal(staleCand.default_selected, false);
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Cleanup: protected branches and checked-out branches refused', async () => {
  const env = await setupCleanupEnv();
  try {
    // Attempt forged deletion of main / master
    const applyRes = await handleCleanupApply(env.ctx, {
      project_path: env.repoDir,
      items: ['merged_branch:main', 'stale_branch:master'],
      confirm: true,
      confirm_risky: ['merged_branch:main', 'stale_branch:master'],
    });
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.deleted.length, 0);
    assert.equal(applyRes.skipped.length, 2);
    assert.equal(applyRes.skipped[0]!.reason, 'no longer a candidate');

    // Create checked-out branch in a worktree and ensure it is not listed as candidate
    const wtRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'wt-active',
      base: 'main',
    });
    const preview = await handleCleanupPreview(env.ctx, new URLSearchParams(`project_path=${env.repoDir}`));
    const activeBranchCand = preview.candidates.find((c: CleanupCandidate) => c.name === wtRes.worktree.branch);
    assert.equal(activeBranchCand, undefined, 'Checked out branch in worktree must not be a candidate');
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Cleanup: dirty worktree requires confirm_risky and creates trash backup on delete', async () => {
  const env = await setupCleanupEnv();
  try {
    const dataDir = env.paths.featureDataDir('worktrees');
    const wtRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'wt-dirty',
      base: 'main',
    });
    const wtPath = wtRes.worktree.worktree_path;
    fs.writeFileSync(path.win32.join(wtPath, 'dirty.txt'), 'uncommitted work\n', 'utf8');

    // Set remove_after in past to qualify as kept_worktree
    const store = await loadWorktreesStore(dataDir);
    const rec = store.worktrees.find((w: WorktreeRecord) => w.id === 'wt-dirty')!;
    rec.status = 'merged';
    rec.remove_after = new Date(Date.now() - 3600 * 1000).toISOString();
    await saveWorktreesStore(dataDir, store);

    const candId = 'kept_worktree:wt-dirty';

    // 1. Without confirm_risky: skipped
    const skipRes = await handleCleanupApply(env.ctx, {
      project_path: env.repoDir,
      items: [candId],
      confirm: true,
    });
    assert.equal(skipRes.deleted.length, 0);
    assert.equal(skipRes.skipped.length, 1);
    assert.equal(skipRes.skipped[0]!.reason, 'needs confirm_risky');
    assert.ok(fs.existsSync(wtPath), 'Worktree folder must still exist');

    // 2. With confirm_risky: deleted and backup created
    const delRes = await handleCleanupApply(env.ctx, {
      project_path: env.repoDir,
      items: [candId],
      confirm: true,
      confirm_risky: [candId],
    });
    assert.equal(delRes.deleted.length, 1);
    assert.equal(delRes.deleted[0]!.id, candId);
    assert.ok(delRes.deleted[0]!.backup_ref, 'Must create backup_ref for dirty worktree');
    assert.ok(delRes.deleted[0]!.backup_ref!.startsWith('refs/maw/trash/'));
    assert.ok(!fs.existsSync(wtPath), 'Worktree folder must be deleted');

    // Verify backup ref exists in git
    const showRes = await runCommand('git', ['rev-parse', delRes.deleted[0]!.backup_ref!], {
      cwd: env.repoDir,
    });
    assert.equal(showRes.code, 0, 'Trash backup ref must exist in git');
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Cleanup: unmerged branch creates trash ref and cleanup_restore restores it', async () => {
  const env = await setupCleanupEnv();
  try {
    const pastDate = new Date(Date.now() - 25 * 86400 * 1000).toISOString();
    await runCommand('git', ['checkout', '-b', 'maw/wt-restore-me'], { cwd: env.repoDir });
    fs.writeFileSync(path.win32.join(env.repoDir, 'important.txt'), 'important data\n', 'utf8');
    await runCommand('git', ['add', '.'], { cwd: env.repoDir });
    await runCommand('git', ['commit', '-m', 'feat: important unmerged commit'], {
      cwd: env.repoDir,
      env: { GIT_COMMITTER_DATE: pastDate, GIT_AUTHOR_DATE: pastDate },
    });
    await runCommand('git', ['checkout', 'main'], { cwd: env.repoDir });

    const candId = 'stale_branch:maw/wt-restore-me';

    // Apply with confirm_risky
    const delRes = await handleCleanupApply(env.ctx, {
      project_path: env.repoDir,
      items: [candId],
      confirm: true,
      confirm_risky: [candId],
    });
    assert.equal(delRes.deleted.length, 1);
    const backupRef = delRes.deleted[0]!.backup_ref!;
    assert.ok(backupRef, 'Unmerged branch must have backup_ref');

    // Branch should be deleted
    const branchCheck = await runCommand('git', ['show-ref', '--verify', 'refs/heads/maw/wt-restore-me'], {
      cwd: env.repoDir,
    });
    assert.notEqual(branchCheck.code, 0, 'Branch must be deleted');

    // List trash
    const trashRes = await handleCleanupTrash(env.ctx, new URLSearchParams(`project_path=${env.repoDir}`));
    assert.equal(trashRes.ok, true);
    const trashItems = trashRes.trash as Array<Record<string, unknown>>;
    const foundTrash = trashItems.find((t) => t.ref === backupRef);
    assert.ok(foundTrash, 'Trash item must be listed');

    // Restore from trash
    const restoreRes = await handleCleanupRestore(env.ctx, {
      project_path: env.repoDir,
      ref: backupRef,
      confirm: true,
    });
    assert.equal(restoreRes.ok, true);
    assert.equal(restoreRes.branch, 'maw/wt-restore-me');

    // Branch must now exist again
    const restoredCheck = await runCommand('git', ['show-ref', '--verify', 'refs/heads/maw/wt-restore-me'], {
      cwd: env.repoDir,
    });
    assert.equal(restoredCheck.code, 0, 'Restored branch must exist');

    // Restoring again creates <branch>-restored-1
    const secondRestore = await handleCleanupRestore(env.ctx, {
      project_path: env.repoDir,
      ref: backupRef,
      confirm: true,
    });
    assert.equal(secondRestore.ok, true);
    assert.equal(secondRestore.branch, 'maw/wt-restore-me-restored-1');
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Cleanup: path outside .maw-wt refused on apply', async () => {
  const env = await setupCleanupEnv();
  try {
    const dataDir = env.paths.featureDataDir('worktrees');
    const outsidePath = path.win32.join(env.tempBase, 'outside-folder');
    fs.mkdirSync(outsidePath, { recursive: true });

    // Store record with illegitimate worktree_path
    const store = await loadWorktreesStore(dataDir);
    store.worktrees.push({
      id: 'wt-outside',
      project_path: env.repoDir,
      worktree_path: outsidePath,
      branch: 'maw/wt-outside',
      base: 'main',
      base_commit: '12345678',
      port: 4499,
      origin: 'manual',
      status: 'merged',
      remove_after: new Date(Date.now() - 3600 * 1000).toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await saveWorktreesStore(dataDir, store);

    const applyRes = await handleCleanupApply(env.ctx, {
      project_path: env.repoDir,
      items: ['kept_worktree:wt-outside'],
      confirm: true,
    });
    assert.equal(applyRes.deleted.length, 0);
    assert.equal(applyRes.skipped.length, 1);
    assert.equal(applyRes.skipped[0]!.reason, 'path outside .maw-wt or invalid');
    assert.ok(fs.existsSync(outsidePath), 'Outside path must never be touched');
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Cleanup: keep_after_merge_days keeps worktree and sweep removes it', async () => {
  const env = await setupCleanupEnv();
  try {
    const dataDir = env.paths.featureDataDir('worktrees');

    // Configure keep_after_merge_days: 5
    saveCleanupConfig(env.ctx, { keep_after_merge_days: 5 });

    const wtRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'wt-delayed',
      base: 'main',
    });
    const wtPath = wtRes.worktree.worktree_path;
    fs.writeFileSync(path.win32.join(wtPath, 'change.txt'), 'merged change\n', 'utf8');

    // Merge without explicit remove: body.remove undefined -> keep_after_merge_days applies
    const mergeRes = await handleWorktreeMerge(env.ctx, {
      id: 'wt-delayed',
      strategy: 'merge',
      confirm: true,
    });
    assert.equal(mergeRes.ok, true);
    assert.equal(mergeRes.merged, true);
    assert.equal(mergeRes.removed, false);
    assert.ok(fs.existsSync(wtPath), 'Worktree must be kept');

    // Verify record has remove_after set ~5 days in future
    const store = await loadWorktreesStore(dataDir);
    const rec = store.worktrees.find((w: WorktreeRecord) => w.id === 'wt-delayed')!;
    assert.ok(rec.remove_after, 'Record must have remove_after set');
    const futureMs = new Date(String(rec.remove_after)).getTime();
    assert.ok(futureMs > Date.now() + 4 * 86400 * 1000);

    // Fast-forward remove_after to the past to test sweep removal
    rec.remove_after = new Date(Date.now() - 1000).toISOString();
    await saveWorktreesStore(dataDir, store);

    // Run sweep
    await runAutomaticSweep(env.ctx);

    // Worktree should now be removed by sweep
    assert.ok(!fs.existsSync(wtPath), 'Worktree must be removed by sweep');
    const updatedStore = await loadWorktreesStore(dataDir);
    const updatedRec = updatedStore.worktrees.find((w: WorktreeRecord) => w.id === 'wt-delayed')!;
    assert.equal(updatedRec.status, 'discarded');
    assert.ok(updatedRec.cleaned_at);
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Cleanup: scan writes cleanup-latest.json and feature.status reflects it', async () => {
  const env = await setupCleanupEnv();
  try {
    const scanRes = await scanCleanup(env.ctx, env.repoDir);
    assert.equal(scanRes.ok, true);

    const dataDir = env.paths.featureDataDir('worktrees');
    const latestFile = path.win32.join(dataDir, 'cleanup-latest.json');
    assert.ok(fs.existsSync(latestFile), 'cleanup-latest.json must exist');

    const raw = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
    assert.equal(typeof raw.count, 'number');
    assert.equal(typeof raw.size_bytes, 'number');

    // Call feature.status(env.ctx)
    const st = (await feature.status!(env.ctx)) as Record<string, unknown>;
    assert.ok(st.cleanup, 'status must have cleanup object');
    const cleanSt = st.cleanup as Record<string, unknown>;
    assert.equal(cleanSt.count, raw.count);
    assert.equal(cleanSt.size_bytes, raw.size_bytes);
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Cleanup K1 & K4: path normalization, registered worktree slash mismatch, and unregistered folder (b) no git backup', async () => {
  const env = await setupCleanupEnv();
  try {
    const dataDir = env.paths.featureDataDir('worktrees');
    const containerDir = path.win32.join(env.projectsRoot, '.maw-wt', 'sample-repo');
    fs.mkdirSync(containerDir, { recursive: true });

    // 1. Create registered worktree via git directly
    const regWtPath = path.win32.join(containerDir, 'wt-k1-reg');
    await runCommand('git', ['worktree', 'add', '-b', 'maw/k1-reg', regWtPath, 'main'], {
      cwd: env.repoDir,
    });

    // Record in store as active
    const store = await loadWorktreesStore(dataDir);
    store.worktrees.push({
      id: 'wt-k1-reg',
      project_path: env.repoDir,
      worktree_path: regWtPath,
      branch: 'maw/k1-reg',
      base: 'main',
      base_commit: '12345678',
      port: 4490,
      origin: 'manual',
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await saveWorktreesStore(dataDir, store);

    // 2. Create unregistered folder (b) - plain folder not in git worktree list
    const unregPath = path.win32.join(containerDir, 'wt-k1-unreg');
    fs.mkdirSync(unregPath, { recursive: true });
    fs.writeFileSync(path.win32.join(unregPath, 'orphan.txt'), 'not a git worktree\n', 'utf8');

    // Get candidates
    const cfg = loadCleanupConfig(env.ctx);
    const candidates = await getCleanupCandidates(env.ctx, env.repoDir, cfg);

    // Verify K1: Registered active worktree is NOT classified as unregistered folder (b)
    const regCand = candidates.find((c) => c.name === 'wt-k1-reg' || c.path === regWtPath);
    assert.equal(regCand, undefined, 'Active registered worktree must not be a candidate despite forward slashes from git');

    // Verify K4: Unregistered folder (b) has reason indicating no git backup and is marked risky
    const unregCand = candidates.find((c) => c.name === 'wt-k1-unreg');
    assert.ok(unregCand, 'Unregistered folder must be detected as orphan candidate');
    assert.equal(unregCand!.kind, 'orphan_worktree');
    assert.equal(unregCand!.risky, true);
    assert.ok(
      unregCand!.reason?.includes('not a git worktree; cannot be backed up'),
      `Reason should explain no git backup, got: ${unregCand!.reason}`
    );

    // Apply cleanup on unregistered folder (b)
    const applyRes = await handleCleanupApply(env.ctx, {
      project_path: env.repoDir,
      items: [unregCand!.id],
      confirm: true,
      confirm_risky: [unregCand!.id],
    });
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.deleted.length, 1);
    assert.equal(applyRes.deleted[0]!.id, unregCand!.id);
    assert.equal(applyRes.deleted[0]!.backup_ref, undefined, 'Unregistered folder must not produce backup_ref');
    assert.ok(!fs.existsSync(unregPath), 'Unregistered folder must be deleted via fs.rmSync');
    assert.ok(fs.existsSync(regWtPath), 'Registered worktree must remain intact');

    // Cleanup registered worktree
    await runCommand('git', ['worktree', 'remove', '--force', regWtPath], { cwd: env.repoDir });
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Cleanup K2: missing folder orphan worktrees (a) pruned via git worktree prune without rmSync or backup', async () => {
  const env = await setupCleanupEnv();
  try {
    const containerDir = path.win32.join(env.projectsRoot, '.maw-wt', 'sample-repo');
    fs.mkdirSync(containerDir, { recursive: true });

    const pruneWtPath = path.win32.join(containerDir, 'wt-k2-prune');
    await runCommand('git', ['worktree', 'add', '-b', 'maw/k2-prune', pruneWtPath, 'main'], {
      cwd: env.repoDir,
    });

    // Delete folder on disk so it becomes prunable (a)
    fs.rmSync(pruneWtPath, { recursive: true, force: true });
    assert.ok(!fs.existsSync(pruneWtPath), 'Folder must be missing on disk');

    const cfg = loadCleanupConfig(env.ctx);
    const candidates = await getCleanupCandidates(env.ctx, env.repoDir, cfg);
    const prunableCand = candidates.find((c) => c.name === 'wt-k2-prune');
    assert.ok(prunableCand, 'Prunable worktree missing on disk must be detected');
    assert.ok(prunableCand!.reason?.includes('prunable'));

    // Apply cleanup
    const applyRes = await handleCleanupApply(env.ctx, {
      project_path: env.repoDir,
      items: [prunableCand!.id],
      confirm: true,
      confirm_risky: [prunableCand!.id],
    });
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.deleted.length, 1);
    assert.equal(applyRes.deleted[0]!.id, prunableCand!.id);

    // Verify git pruned it
    const wtList = await runCommand('git', ['worktree', 'list', '--porcelain'], { cwd: env.repoDir });
    assert.ok(!wtList.stdout.includes('wt-k2-prune'), 'Git worktree list must no longer include pruned worktree');
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Cleanup K3: registered worktree remove failure skips cleanly without calling fs.rmSync', async () => {
  const env = await setupCleanupEnv();
  let lockingProc: ChildProcess | null = null;
  try {
    const dataDir = env.paths.featureDataDir('worktrees');
    const wtRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'wt-k3-fail',
      base: 'main',
    });
    const wtPath = wtRes.worktree.worktree_path;

    // Mark as kept_worktree in past
    const store = await loadWorktreesStore(dataDir);
    const rec = store.worktrees.find((w: WorktreeRecord) => w.id === 'wt-k3-fail')!;
    rec.status = 'merged';
    rec.remove_after = new Date(Date.now() - 3600 * 1000).toISOString();
    await saveWorktreesStore(dataDir, store);

    // Keep a child process running with cwd inside wtPath so Windows locks the directory
    lockingProc = spawn('cmd.exe', ['/k', 'echo ready'], {
      cwd: wtPath,
      windowsHide: true,
    });
    await new Promise<void>((resolve) => {
      lockingProc!.stdout?.once('data', () => resolve());
    });

    const candId = 'kept_worktree:wt-k3-fail';
    const applyRes = await handleCleanupApply(env.ctx, {
      project_path: env.repoDir,
      items: [candId],
      confirm: true,
      confirm_risky: [candId],
    });

    // Verify skipped due to git failure, not partially deleted
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.deleted.length, 0);
    assert.equal(applyRes.skipped.length, 1);
    assert.equal(applyRes.skipped[0]!.id, candId);
    assert.ok(
      applyRes.skipped[0]!.reason.includes('failed to delete') ||
        applyRes.skipped[0]!.reason.includes('Permission denied') ||
        applyRes.skipped[0]!.reason.includes('git worktree remove'),
      `Reason must mention git worktree remove failure, got: ${applyRes.skipped[0]!.reason}`
    );

    // Verify directory is NOT deleted via fs.rmSync
    assert.ok(fs.existsSync(wtPath), 'Worktree directory must still exist when git remove fails');

    // Verify record in store was NOT marked discarded
    const reloadedStore = await loadWorktreesStore(dataDir);
    const reloadedRec = reloadedStore.worktrees.find((w: WorktreeRecord) => w.id === 'wt-k3-fail')!;
    assert.equal(reloadedRec.status, 'merged', 'Store record must not be marked discarded on failure');
  } finally {
    if (lockingProc) {
      try {
        lockingProc.kill();
      } catch {
        // ignore
      }
    }
    cleanupTestEnv(env);
  }
});

test('S1 Cleanup K5: checkpoint_excess respects config retention limit and sorts by unix timestamp', async () => {
  const env = await setupCleanupEnv();
  try {
    const ckDataDir = env.paths.featureDataDir('checkpoints');
    // Set retention to 5 (minimum allowed)
    saveCheckpointsConfig(ckDataDir, { enabled: true, retention: 5 });

    const jobId = 'job_excess_k5';
    const treeRes = await runCommand('git', ['write-tree'], { cwd: env.repoDir });
    const treeHash = treeRes.stdout.trim();

    // Create 7 checkpoints with explicit timestamps
    for (let i = 1; i <= 7; i++) {
      const padSeq = String(i).padStart(4, '0');
      const msgFile = path.win32.join(env.tempBase, `msg-${padSeq}.txt`);
      fs.writeFileSync(
        msgFile,
        `checkpoint\n\nMAW-Event: manual\nMAW-Workdir: ${env.repoDir}\nMAW-Parent: main\n`,
        'utf8'
      );
      const commitDate = new Date(Date.now() - (10 - i) * 60 * 1000).toISOString();
      const commitRes = await runCommand('git', ['commit-tree', treeHash, '-F', msgFile], {
        cwd: env.repoDir,
        env: { GIT_COMMITTER_DATE: commitDate, GIT_AUTHOR_DATE: commitDate },
      });
      const ckRef = `refs/maw/checkpoints/${jobId}/${padSeq}`;
      await runCommand('git', ['update-ref', ckRef, commitRes.stdout.trim()], { cwd: env.repoDir });
    }

    const cfg = loadCleanupConfig(env.ctx);
    const candidates = await getCleanupCandidates(env.ctx, env.repoDir, cfg);
    const excessCands = candidates.filter((c) => c.kind === 'checkpoint_excess');

    // 7 checkpoints total with retention 5 -> exactly 2 excess candidates
    assert.equal(excessCands.length, 2, 'Must have exactly 2 excess checkpoints');
    // Sorted by timestamp ascending: 0001 and 0002 should be the candidates to prune
    assert.equal(excessCands[0]!.name, `refs/maw/checkpoints/${jobId}/0001`);
    assert.equal(excessCands[1]!.name, `refs/maw/checkpoints/${jobId}/0002`);
  } finally {
    cleanupTestEnv(env);
  }
});

test('S1 Cleanup K7 & K8: worktree branch deletion backs up unmerged clean branch tip and respects exact branch set', async () => {
  const env = await setupCleanupEnv();
  try {
    const dataDir = env.paths.featureDataDir('worktrees');

    // 1. Create worktree wt-k7 with unmerged commit, but clean working tree
    const wtRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'wt-k7',
      base: 'main',
    });
    const wtPath = wtRes.worktree.worktree_path;
    fs.writeFileSync(path.win32.join(wtPath, 'unmerged.txt'), 'unmerged work\n', 'utf8');
    await runCommand('git', ['add', '.'], { cwd: wtPath });
    await runCommand('git', ['commit', '-m', 'feat: unmerged commit on wt-k7'], { cwd: wtPath });

    // 2. Create another active worktree wt-k8-active on branch maw/wt-k8-active
    const wtActiveRes = await createWorktreeRecord(env.ctx, {
      project_path: env.repoDir,
      name: 'wt-k8-active',
      base: 'main',
    });

    // Mark wt-k7 as kept_worktree in past
    const store = await loadWorktreesStore(dataDir);
    const rec = store.worktrees.find((w: WorktreeRecord) => w.id === 'wt-k7')!;
    rec.status = 'merged';
    rec.remove_after = new Date(Date.now() - 3600 * 1000).toISOString();
    await saveWorktreesStore(dataDir, store);

    // Apply cleanup for wt-k7
    const candId = 'kept_worktree:wt-k7';
    const applyRes = await handleCleanupApply(env.ctx, {
      project_path: env.repoDir,
      items: [candId],
      confirm: true,
      confirm_risky: [candId],
    });

    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.deleted.length, 1);
    const del = applyRes.deleted[0]!;
    assert.equal(del.id, candId);
    // K7: Unmerged clean branch tip backed up to trash
    assert.ok(del.backup_ref, 'Must create backup_ref for unmerged branch tip');
    assert.ok(del.backup_ref!.startsWith('refs/maw/trash/maw-wt-k7-'));

    // Verify backup ref contains the unmerged commit
    const showRef = await runCommand('git', ['rev-parse', del.backup_ref!], { cwd: env.repoDir });
    assert.equal(showRef.code, 0, 'Trash backup ref must exist');

    // Branch maw/wt-k7 is deleted
    const branchCheck = await runCommand('git', ['show-ref', '--verify', 'refs/heads/maw/wt-k7'], {
      cwd: env.repoDir,
    });
    assert.notEqual(branchCheck.code, 0, 'Branch maw/wt-k7 must be deleted');

    // K8: Checked out branch maw/wt-k8-active remains active and untouched
    const activeBranchCheck = await runCommand('git', ['show-ref', '--verify', 'refs/heads/maw/wt-k8-active'], {
      cwd: env.repoDir,
    });
    assert.equal(activeBranchCheck.code, 0, 'Active branch maw/wt-k8-active must not be deleted');
  } finally {
    cleanupTestEnv(env);
  }
});
