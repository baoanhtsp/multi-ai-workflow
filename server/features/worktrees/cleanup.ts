import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appendAuditEntry } from '../../lib/audit.ts';
import type { MawFeatureContext } from '../../lib/feature.ts';
import { getTempDir, isDirectorySafe, isFileSafe, resolveProjectPath } from '../../lib/paths.ts';
import { ApiValidationError } from '../../lib/validate.ts';
import { gitRun, snapshotTree, validateRefName } from '../checkpoints/snapshot.ts';
import { isJobStillRunning } from './merge.ts';
import { loadWorktreesStore, saveWorktreesStore, withStoreLock, type WorktreeRecord } from './store.ts';

export interface CleanupConfig {
  keep_after_merge_days: number;
  stale_branch_days: number;
  trash_days: number;
  sweep_hours: number;
  sweep_enabled: boolean;
}

export type CleanupCandidateKind =
  | 'merged_branch'
  | 'kept_worktree'
  | 'orphan_worktree'
  | 'stale_worktree'
  | 'stale_branch'
  | 'checkpoint_excess'
  | 'checkpoint_orphan'
  | 'trash_expired';

export interface CleanupCandidate {
  id: string; // <kind>:<name>
  kind: CleanupCandidateKind;
  name: string;
  path: string | null;
  reason: string;
  merged: boolean;
  risky: boolean;
  dirty: boolean;
  protected: boolean;
  last_commit_at: string | null;
  size_bytes: number | null;
  size_approx?: boolean;
  default_selected: boolean;
}

export interface CleanupPreviewResult {
  ok: true;
  project_path: string;
  scanned_at: string;
  config: CleanupConfig;
  candidates: CleanupCandidate[];
  totals: {
    count: number;
    size_bytes: number;
    risky: number;
  };
  [key: string]: unknown;
}

export interface CleanupApplyResult {
  ok: true;
  deleted: Array<{ id: string; kind: string; name: string; backup_ref?: string }>;
  skipped: Array<{ id: string; reason: string }>;
  freed_bytes: number;
  [key: string]: unknown;
}

export interface CleanupTrashItem {
  ref: string;
  branch: string;
  created_at: string;
  expires_at: string;
  last_commit_subject: string;
}

export interface CleanupScanSummary {
  scanned_at: string | null;
  count: number;
  size_bytes: number;
  by_project: Record<string, number>;
}

export const DEFAULT_CLEANUP_CONFIG: CleanupConfig = {
  keep_after_merge_days: 0,
  stale_branch_days: 14,
  trash_days: 30,
  sweep_hours: 24,
  sweep_enabled: true,
};

const MAW_BRANCH_REGEX = /^maw\/[a-z0-9][a-z0-9._/-]{0,80}$/;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'develop']);

export function isBranchProtected(branchName: string): boolean {
  const norm = branchName.replace(/^refs\/heads\//, '').trim();
  if (PROTECTED_BRANCHES.has(norm)) return true;
  if (/^release(\/.*)?$/i.test(norm)) return true;
  return false;
}

export function loadCleanupConfig(ctx: MawFeatureContext): CleanupConfig {
  const dataDir = ctx.paths.featureDataDir('worktrees');
  const cfgPath = path.win32.join(dataDir, 'cleanup-config.json');
  if (isFileSafe(cfgPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Partial<CleanupConfig>;
      return {
        keep_after_merge_days:
          typeof raw.keep_after_merge_days === 'number'
            ? Math.max(0, Math.min(90, Math.floor(raw.keep_after_merge_days)))
            : DEFAULT_CLEANUP_CONFIG.keep_after_merge_days,
        stale_branch_days:
          typeof raw.stale_branch_days === 'number'
            ? Math.max(1, Math.min(365, Math.floor(raw.stale_branch_days)))
            : DEFAULT_CLEANUP_CONFIG.stale_branch_days,
        trash_days:
          typeof raw.trash_days === 'number'
            ? Math.max(1, Math.min(365, Math.floor(raw.trash_days)))
            : DEFAULT_CLEANUP_CONFIG.trash_days,
        sweep_hours:
          typeof raw.sweep_hours === 'number'
            ? Math.max(1, Math.min(168, Math.floor(raw.sweep_hours)))
            : DEFAULT_CLEANUP_CONFIG.sweep_hours,
        sweep_enabled:
          typeof raw.sweep_enabled === 'boolean'
            ? raw.sweep_enabled
            : DEFAULT_CLEANUP_CONFIG.sweep_enabled,
      };
    } catch {
      // Return defaults on parse error
    }
  }
  return { ...DEFAULT_CLEANUP_CONFIG };
}

export function saveCleanupConfig(
  ctx: MawFeatureContext,
  partial: Record<string, unknown>
): CleanupConfig {
  const current = loadCleanupConfig(ctx);
  if (partial.keep_after_merge_days !== undefined) {
    const val = Number(partial.keep_after_merge_days);
    if (!Number.isInteger(val) || val < 0 || val > 90) {
      throw new ApiValidationError(
        'keep_after_merge_days must be an integer between 0 and 90.',
        400
      );
    }
    current.keep_after_merge_days = val;
  }
  if (partial.stale_branch_days !== undefined) {
    const val = Number(partial.stale_branch_days);
    if (!Number.isInteger(val) || val < 1 || val > 365) {
      throw new ApiValidationError(
        'stale_branch_days must be an integer between 1 and 365.',
        400
      );
    }
    current.stale_branch_days = val;
  }
  if (partial.trash_days !== undefined) {
    const val = Number(partial.trash_days);
    if (!Number.isInteger(val) || val < 1 || val > 365) {
      throw new ApiValidationError(
        'trash_days must be an integer between 1 and 365.',
        400
      );
    }
    current.trash_days = val;
  }
  if (partial.sweep_hours !== undefined) {
    const val = Number(partial.sweep_hours);
    if (!Number.isInteger(val) || val < 1 || val > 168) {
      throw new ApiValidationError(
        'sweep_hours must be an integer between 1 and 168.',
        400
      );
    }
    current.sweep_hours = val;
  }
  if (partial.sweep_enabled !== undefined) {
    if (typeof partial.sweep_enabled !== 'boolean') {
      throw new ApiValidationError('sweep_enabled must be a boolean.', 400);
    }
    current.sweep_enabled = partial.sweep_enabled;
  }

  const dataDir = ctx.paths.featureDataDir('worktrees');
  const cfgPath = path.win32.join(dataDir, 'cleanup-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(current, null, 2), 'utf8');
  return current;
}

export function computeFolderSize(
  folderPath: string,
  maxEntries = 200_000
): { size_bytes: number; size_approx?: boolean } {
  let totalBytes = 0;
  let count = 0;
  let approx = false;
  const stack = [folderPath];

  try {
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        count++;
        if (count > maxEntries) {
          approx = true;
          break;
        }
        if (entry.name === '.git') continue;
        const fullPath = path.win32.join(current, entry.name);
        try {
          if (entry.isDirectory()) {
            stack.push(fullPath);
          } else if (entry.isFile()) {
            const st = fs.statSync(fullPath);
            totalBytes += st.size;
          }
        } catch {
          // ignore
        }
      }
      if (approx) break;
    }
  } catch {
    // ignore
  }

  return { size_bytes: totalBytes, ...(approx ? { size_approx: true } : {}) };
}

export function isInsideMawWt(folderPath: string, repoPath: string): boolean {
  try {
    const expectedContainer = path.win32.resolve(
      path.dirname(repoPath),
      '.maw-wt',
      path.basename(repoPath)
    );
    if (!fs.existsSync(expectedContainer) || !fs.existsSync(folderPath)) {
      return false;
    }
    const realContainer = fs.realpathSync(expectedContainer).toLowerCase();
    const realFolder = fs.realpathSync(folderPath).toLowerCase();
    const realRepo = fs.realpathSync(repoPath).toLowerCase();

    if (realFolder === realRepo) {
      return false;
    }
    const rel = path.win32.relative(realContainer, realFolder);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function formatTrashTimestamp(d = new Date()): string {
  const yyyy = String(d.getFullYear());
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}${MM}${dd}${HH}${mm}${ss}`;
}

export async function getCleanupCandidates(
  ctx: MawFeatureContext,
  projectPath: string,
  config?: CleanupConfig
): Promise<CleanupCandidate[]> {
  const repoPath = resolveProjectPath(projectPath, ctx.paths.projectsRoot);
  if (!repoPath) {
    throw new ApiValidationError(`Invalid project path '${projectPath}'.`, 400);
  }
  const cfg = config ?? loadCleanupConfig(ctx);
  const dataDir = ctx.paths.featureDataDir('worktrees');
  const store = await loadWorktreesStore(dataDir);
  const candidates: CleanupCandidate[] = [];

  // 1. Get all checked-out branches in any worktree
  const wtListRes = await gitRun(['worktree', 'list', '--porcelain'], {
    cwd: repoPath,
    allowFailure: true,
  });
  const checkedOutBranches = new Set<string>();
  const gitRegisteredWorktrees: Array<{ path: string; branch: string; prunable: boolean }> = [];

  if (wtListRes.code === 0 && wtListRes.stdout.trim()) {
    const lines = wtListRes.stdout.split(/\r?\n/);
    let currentWtPath = '';
    let currentBranch = '';
    let currentPrunable = false;

    for (const l of lines) {
      const trimmed = l.trim();
      if (trimmed.startsWith('worktree ')) {
        if (currentWtPath) {
          gitRegisteredWorktrees.push({
            path: currentWtPath,
            branch: currentBranch,
            prunable: currentPrunable,
          });
        }
        currentWtPath = trimmed.slice('worktree '.length).trim();
        currentBranch = '';
        currentPrunable = false;
      } else if (trimmed.startsWith('branch refs/heads/')) {
        currentBranch = trimmed.slice('branch refs/heads/'.length).trim();
        checkedOutBranches.add(currentBranch);
        checkedOutBranches.add(`maw/${currentBranch}`);
      } else if (trimmed.startsWith('branch ')) {
        currentBranch = trimmed.slice('branch '.length).trim();
        checkedOutBranches.add(currentBranch);
      } else if (trimmed.startsWith('prunable')) {
        currentPrunable = true;
      }
    }
    if (currentWtPath) {
      gitRegisteredWorktrees.push({
        path: currentWtPath,
        branch: currentBranch,
        prunable: currentPrunable,
      });
    }
  }

  // Determine repository base branch (default 'main')
  let repoBase = 'main';
  const headBranchRes = await gitRun(['symbolic-ref', '--short', 'HEAD'], {
    cwd: repoPath,
    allowFailure: true,
  });
  if (headBranchRes.code === 0 && headBranchRes.stdout.trim()) {
    repoBase = headBranchRes.stdout.trim();
  }

  // 2. Kind: merged_branch & stale_branch
  const branchListRes = await gitRun(
    ['for-each-ref', '--format=%(refname:short)%09%(creatordate:iso-strict)', 'refs/heads/maw/'],
    { cwd: repoPath, allowFailure: true }
  );

  const localMawBranches: Array<{ name: string; date: string }> = [];
  if (branchListRes.code === 0 && branchListRes.stdout.trim()) {
    for (const line of branchListRes.stdout.split(/\r?\n/)) {
      const parts = line.trim().split('\t');
      if (parts[0]) {
        localMawBranches.push({
          name: parts[0],
          date: parts[1] || new Date().toISOString(),
        });
      }
    }
  }

  const projectStoreRecords = store.worktrees.filter(
    (w) => w.project_path.toLowerCase() === repoPath.toLowerCase()
  );

  for (const b of localMawBranches) {
    if (checkedOutBranches.has(b.name) || checkedOutBranches.has(b.name.replace(/^maw\//, ''))) {
      continue; // Checked out in a worktree, never candidate
    }

    const rec = projectStoreRecords.find((w) => w.branch === b.name);
    const branchBase = rec?.base || repoBase;

    // Check if merged
    let isMerged = false;
    if (rec && rec.status === 'merged') {
      isMerged = true;
    } else {
      const ancRes = await gitRun(
        ['merge-base', '--is-ancestor', b.name, branchBase],
        { cwd: repoPath, allowFailure: true }
      );
      if (ancRes.code === 0) {
        isMerged = true;
      }
    }

    if (isMerged) {
      // merged_branch candidate
      let sizeBytes: number | null = null;
      const sizeRes = await gitRun(
        ['rev-list', '--objects', '--disk-usage', `${branchBase}..${b.name}`],
        { cwd: repoPath, allowFailure: true }
      );
      if (sizeRes.code === 0 && sizeRes.stdout.trim()) {
        const num = Number.parseInt(sizeRes.stdout.trim(), 10);
        if (!Number.isNaN(num)) sizeBytes = num;
      }

      candidates.push({
        id: `merged_branch:${b.name}`,
        kind: 'merged_branch',
        name: b.name,
        path: null,
        reason: `merged into ${branchBase}`,
        merged: true,
        risky: false,
        dirty: false,
        protected: false,
        last_commit_at: b.date,
        size_bytes: sizeBytes,
        default_selected: true,
      });
    } else {
      // Check if stale_branch
      // Must not have an active worktree record
      const hasActiveWorktree = projectStoreRecords.some(
        (w) => w.branch === b.name && w.status === 'active'
      );
      if (!hasActiveWorktree) {
        const commitTime = new Date(b.date).getTime();
        const ageDays = (Date.now() - commitTime) / (86400 * 1000);
        if (ageDays >= cfg.stale_branch_days) {
          let sizeBytes: number | null = null;
          const sizeRes = await gitRun(
            ['rev-list', '--objects', '--disk-usage', `${branchBase}..${b.name}`],
            { cwd: repoPath, allowFailure: true }
          );
          if (sizeRes.code === 0 && sizeRes.stdout.trim()) {
            const num = Number.parseInt(sizeRes.stdout.trim(), 10);
            if (!Number.isNaN(num)) sizeBytes = num;
          }

          candidates.push({
            id: `stale_branch:${b.name}`,
            kind: 'stale_branch',
            name: b.name,
            path: null,
            reason: `unmerged branch older than ${cfg.stale_branch_days} days`,
            merged: false,
            risky: true,
            dirty: false,
            protected: false,
            last_commit_at: b.date,
            size_bytes: sizeBytes,
            default_selected: false,
          });
        }
      }
    }
  }

  // 3. Kind: kept_worktree & stale_worktree
  for (const rec of projectStoreRecords) {
    if (rec.status === 'merged' && rec.remove_after) {
      const removeAfterTime = new Date(String(rec.remove_after)).getTime();
      if (removeAfterTime <= Date.now() && fs.existsSync(rec.worktree_path)) {
        const statusRes = await gitRun(['status', '--porcelain'], {
          cwd: rec.worktree_path,
          allowFailure: true,
        });
        const dirty = statusRes.code === 0 && statusRes.stdout.trim() !== '';
        const sizeInfo = computeFolderSize(rec.worktree_path);

        candidates.push({
          id: `kept_worktree:${rec.id}`,
          kind: 'kept_worktree',
          name: rec.id,
          path: rec.worktree_path,
          reason: `past remove_after (${rec.remove_after})`,
          merged: true,
          risky: dirty,
          dirty,
          protected: false,
          last_commit_at: rec.updated_at || rec.created_at,
          size_bytes: sizeInfo.size_bytes,
          size_approx: sizeInfo.size_approx,
          default_selected: !dirty,
        });
      }
    } else if (rec.status === 'active') {
      // Check if job is still running
      let isRunning = false;
      if (rec.job_id) {
        isRunning = await isJobStillRunning(ctx, rec.job_id);
      }
      if (!isRunning && fs.existsSync(rec.worktree_path)) {
        // Check age of last commit or folder
        let lastCommitTime = 0;
        let lastCommitIso: string | null = null;
        const logRes = await gitRun(['log', '-1', '--format=%cI'], {
          cwd: rec.worktree_path,
          allowFailure: true,
        });
        if (logRes.code === 0 && logRes.stdout.trim()) {
          lastCommitIso = logRes.stdout.trim();
          lastCommitTime = new Date(lastCommitIso).getTime();
        } else {
          try {
            const st = fs.statSync(rec.worktree_path);
            lastCommitTime = st.mtimeMs;
            lastCommitIso = new Date(st.mtimeMs).toISOString();
          } catch {
            // ignore
          }
        }

        const ageDays = (Date.now() - lastCommitTime) / (86400 * 1000);
        if (ageDays >= cfg.stale_branch_days) {
          const statusRes = await gitRun(['status', '--porcelain'], {
            cwd: rec.worktree_path,
            allowFailure: true,
          });
          const dirty = statusRes.code === 0 && statusRes.stdout.trim() !== '';
          const sizeInfo = computeFolderSize(rec.worktree_path);

          candidates.push({
            id: `stale_worktree:${rec.id}`,
            kind: 'stale_worktree',
            name: rec.id,
            path: rec.worktree_path,
            reason: `unmerged worktree older than ${cfg.stale_branch_days} days`,
            merged: false,
            risky: true,
            dirty,
            protected: false,
            last_commit_at: lastCommitIso,
            size_bytes: sizeInfo.size_bytes,
            size_approx: sizeInfo.size_approx,
            default_selected: false,
          });
        }
      }
    }
  }

  // 4. Kind: orphan_worktree
  const mawWtContainer = path.win32.join(
    path.dirname(repoPath),
    '.maw-wt',
    path.basename(repoPath)
  );
  if (isDirectorySafe(mawWtContainer)) {
    const existingSubFolders = new Set<string>();
    try {
      const entries = fs.readdirSync(mawWtContainer, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          existingSubFolders.add(e.name);
        }
      }
    } catch {
      // ignore
    }

    // (a) git-registered worktree under .maw-wt/<repo>/ whose folder is gone (prunable)
    for (const gwt of gitRegisteredWorktrees) {
      if (
        gwt.path.toLowerCase().startsWith(mawWtContainer.toLowerCase()) &&
        !fs.existsSync(gwt.path)
      ) {
        const name = path.basename(gwt.path);
        candidates.push({
          id: `orphan_worktree:${name}`,
          kind: 'orphan_worktree',
          name,
          path: gwt.path,
          reason: 'git prunable worktree (folder missing)',
          merged: false,
          risky: false,
          dirty: false,
          protected: false,
          last_commit_at: null,
          size_bytes: 0,
          default_selected: true,
        });
      }
    }

    // (b) folder under .maw-wt/<repo>/ not registered in git
    for (const folderName of existingSubFolders) {
      const fullPath = path.win32.join(mawWtContainer, folderName);
      const isRegistered = gitRegisteredWorktrees.some(
        (g) => g.path.toLowerCase() === fullPath.toLowerCase()
      );
      if (!isRegistered) {
        const sizeInfo = computeFolderSize(fullPath);
        let hasFiles = sizeInfo.size_bytes > 0;
        try {
          const items = fs.readdirSync(fullPath);
          hasFiles = items.length > 0;
        } catch {
          // ignore
        }
        candidates.push({
          id: `orphan_worktree:${folderName}`,
          kind: 'orphan_worktree',
          name: folderName,
          path: fullPath,
          reason: 'unregistered folder under .maw-wt',
          merged: false,
          risky: hasFiles,
          dirty: hasFiles,
          protected: false,
          last_commit_at: null,
          size_bytes: sizeInfo.size_bytes,
          size_approx: sizeInfo.size_approx,
          default_selected: !hasFiles,
        });
      }
    }

    // (c) registered worktree without S1 record
    for (const gwt of gitRegisteredWorktrees) {
      if (
        gwt.path.toLowerCase().startsWith(mawWtContainer.toLowerCase()) &&
        fs.existsSync(gwt.path)
      ) {
        const folderName = path.basename(gwt.path);
        const hasRecord = projectStoreRecords.some(
          (w) =>
            w.id === folderName ||
            w.worktree_path.toLowerCase() === gwt.path.toLowerCase()
        );
        if (!hasRecord && !candidates.some((c) => c.path === gwt.path)) {
          const statusRes = await gitRun(['status', '--porcelain'], {
            cwd: gwt.path,
            allowFailure: true,
          });
          const dirty = statusRes.code === 0 && statusRes.stdout.trim() !== '';
          const sizeInfo = computeFolderSize(gwt.path);
          candidates.push({
            id: `orphan_worktree:${folderName}`,
            kind: 'orphan_worktree',
            name: folderName,
            path: gwt.path,
            reason: 'registered worktree without S1 record',
            merged: false,
            risky: dirty,
            dirty,
            protected: false,
            last_commit_at: null,
            size_bytes: sizeInfo.size_bytes,
            size_approx: sizeInfo.size_approx,
            default_selected: !dirty,
          });
        }
      }
    }
  }

  // 5. Kind: checkpoint_excess & checkpoint_orphan
  const ckRefsRes = await gitRun(
    ['for-each-ref', '--format=%(refname)', 'refs/maw/checkpoints/'],
    { cwd: repoPath, allowFailure: true }
  );

  if (ckRefsRes.code === 0 && ckRefsRes.stdout.trim()) {
    const rawRefs = ckRefsRes.stdout
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter(Boolean);

    // Group by workdir
    const byWorkdir = new Map<string, Array<{ ref: string; date: string }>>();
    const orphanRefs: string[] = [];

    for (const ref of rawRefs) {
      const logRes = await gitRun(['log', '-1', '--format=%cI%x1f%B', ref], {
        cwd: repoPath,
        allowFailure: true,
      });
      if (logRes.code === 0 && logRes.stdout.trim()) {
        const [cDate, ...rest] = logRes.stdout.split('\x1f');
        const body = rest.join('\x1f');
        const match = body.match(/^MAW-Workdir:\s*(.+)$/m);
        const workdir = match ? match[1]!.trim() : '';

        if (!workdir || !fs.existsSync(workdir)) {
          orphanRefs.push(ref);
        } else {
          const arr = byWorkdir.get(workdir) || [];
          arr.push({ ref, date: cDate || '' });
          byWorkdir.set(workdir, arr);
        }
      }
    }

    // checkpoint_orphan
    for (const ref of orphanRefs) {
      candidates.push({
        id: `checkpoint_orphan:${ref}`,
        kind: 'checkpoint_orphan',
        name: ref,
        path: null,
        reason: 'MAW-Workdir folder no longer exists',
        merged: false,
        risky: false,
        dirty: false,
        protected: false,
        last_commit_at: null,
        size_bytes: null,
        default_selected: true,
      });
    }

    // checkpoint_excess: retention default 20
    const retention = 20;
    for (const [workdir, arr] of byWorkdir.entries()) {
      if (arr.length > retention) {
        // Sort oldest first
        arr.sort((a, b) => a.date.localeCompare(b.date));
        const excess = arr.slice(0, arr.length - retention);
        for (const item of excess) {
          candidates.push({
            id: `checkpoint_excess:${item.ref}`,
            kind: 'checkpoint_excess',
            name: item.ref,
            path: null,
            reason: `exceeds retention (${retention}) for workdir`,
            merged: false,
            risky: false,
            dirty: false,
            protected: false,
            last_commit_at: item.date,
            size_bytes: null,
            default_selected: true,
          });
        }
      }
    }
  }

  // 6. Kind: trash_expired
  const trashRefsRes = await gitRun(
    ['for-each-ref', '--format=%(refname)%09%(creatordate:iso-strict)', 'refs/maw/trash/'],
    { cwd: repoPath, allowFailure: true }
  );
  if (trashRefsRes.code === 0 && trashRefsRes.stdout.trim()) {
    for (const line of trashRefsRes.stdout.split(/\r?\n/)) {
      const parts = line.trim().split('\t');
      const ref = parts[0];
      const date = parts[1];
      if (!ref) continue;

      const createdTime = new Date(date || Date.now()).getTime();
      const ageDays = (Date.now() - createdTime) / (86400 * 1000);
      if (ageDays >= cfg.trash_days) {
        candidates.push({
          id: `trash_expired:${ref}`,
          kind: 'trash_expired',
          name: ref,
          path: null,
          reason: `trash backup expired (older than ${cfg.trash_days} days)`,
          merged: false,
          risky: false,
          dirty: false,
          protected: false,
          last_commit_at: date || null,
          size_bytes: null,
          default_selected: true,
        });
      }
    }
  }

  return candidates;
}

export async function handleCleanupPreview(
  ctx: MawFeatureContext,
  query: URLSearchParams
): Promise<CleanupPreviewResult> {
  const projectPath = String(query.get('project_path') ?? ctx.paths.repoRoot).trim();
  const repoPath = resolveProjectPath(projectPath, ctx.paths.projectsRoot);
  if (!repoPath) {
    throw new ApiValidationError(`Invalid project path '${projectPath}'.`, 400);
  }
  const config = loadCleanupConfig(ctx);
  const candidates = await getCleanupCandidates(ctx, repoPath, config);

  let totalSize = 0;
  let riskyCount = 0;
  for (const c of candidates) {
    if (typeof c.size_bytes === 'number') totalSize += c.size_bytes;
    if (c.risky) riskyCount++;
  }

  return {
    ok: true,
    project_path: repoPath,
    scanned_at: new Date().toISOString(),
    config,
    candidates,
    totals: {
      count: candidates.length,
      size_bytes: totalSize,
      risky: riskyCount,
    },
  };
}

export async function applyCleanupCandidates(
  ctx: MawFeatureContext,
  repoPath: string,
  targetIds: string[],
  confirmRiskyIds: string[]
): Promise<CleanupApplyResult> {
  const config = loadCleanupConfig(ctx);
  const freshCandidates = await getCleanupCandidates(ctx, repoPath, config);
  const candMap = new Map<string, CleanupCandidate>();
  for (const c of freshCandidates) {
    candMap.set(c.id, c);
  }

  const deleted: Array<{ id: string; kind: string; name: string; backup_ref?: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  let freedBytes = 0;

  const dataDir = ctx.paths.featureDataDir('worktrees');

  for (const id of targetIds) {
    const cand = candMap.get(id);
    if (!cand) {
      skipped.push({ id, reason: 'no longer a candidate' });
      continue;
    }

    if (cand.risky || cand.dirty) {
      if (!confirmRiskyIds.includes(id)) {
        skipped.push({ id, reason: 'needs confirm_risky' });
        continue;
      }
    }

    try {
      // 3. Safety checks and execution per kind
      if (cand.kind === 'merged_branch' || cand.kind === 'stale_branch') {
        const branchName = cand.name;
        let validRef = false;
        try {
          await validateRefName(branchName, repoPath);
          validRef = true;
        } catch {
          validRef = false;
        }
        if (!MAW_BRANCH_REGEX.test(branchName) || !validRef) {
          skipped.push({ id, reason: 'invalid branch name' });
          continue;
        }
        if (isBranchProtected(branchName)) {
          skipped.push({ id, reason: 'protected branch' });
          continue;
        }

        // Refuse if checked out in ANY worktree
        const wtCheckRes = await gitRun(['worktree', 'list', '--porcelain'], {
          cwd: repoPath,
          allowFailure: true,
        });
        if (
          wtCheckRes.stdout.includes(`refs/heads/${branchName}`) ||
          wtCheckRes.stdout.includes(`refs/heads/${branchName.replace(/^maw\//, '')}`)
        ) {
          skipped.push({ id, reason: 'branch checked out in a worktree' });
          continue;
        }

        let backupRef: string | undefined;
        if (!cand.merged) {
          // Unmerged branch: create trash backup
          const safeName = branchName.replace(/\//g, '-');
          backupRef = `refs/maw/trash/${safeName}-${formatTrashTimestamp()}`;
          const tipRes = await gitRun(['rev-parse', branchName], { cwd: repoPath });
          const tipSha = tipRes.stdout.trim();
          const backupRes = await gitRun(['update-ref', backupRef, tipSha], { cwd: repoPath });
          if (backupRes.code !== 0) {
            skipped.push({ id, reason: 'failed to create trash backup' });
            continue;
          }
        }

        const delRes = await gitRun(['branch', '-D', branchName], { cwd: repoPath });
        if (delRes.code !== 0) {
          skipped.push({ id, reason: delRes.stderr.trim() || 'git branch -D failed' });
          continue;
        }

        // Update record in store if exists
        await withStoreLock(async () => {
          const s = await loadWorktreesStore(dataDir);
          const r = s.worktrees.find((w) => w.branch === branchName);
          if (r) {
            r.status = 'discarded';
            r.cleaned_at = new Date().toISOString();
            await saveWorktreesStore(dataDir, s);
          }
        });

        // Audit
        const auditEntry = {
          Timestamp: new Date().toISOString(),
          Tool: 'maw-s1',
          Action: 'cleanup_delete',
          Project: repoPath,
          Detail: `${cand.kind} ${branchName}${backupRef ? ` [backup ${backupRef}]` : ''}`,
        };
        appendAuditEntry(ctx.paths.auditFile, auditEntry);
        appendAuditEntry(path.win32.join(dataDir, 'audit.jsonl'), auditEntry);

        if (typeof cand.size_bytes === 'number') freedBytes += cand.size_bytes;
        deleted.push({ id, kind: cand.kind, name: branchName, backup_ref: backupRef });
      } else if (
        cand.kind === 'kept_worktree' ||
        cand.kind === 'orphan_worktree' ||
        cand.kind === 'stale_worktree'
      ) {
        const wtPath = cand.path;
        if (!wtPath || !isInsideMawWt(wtPath, repoPath)) {
          skipped.push({ id, reason: 'path outside .maw-wt or invalid' });
          continue;
        }

        let backupRef: string | undefined;
        if (cand.dirty || !cand.merged) {
          // Create trash backup via snapshotTree
          if (fs.existsSync(wtPath)) {
            try {
              let treeSha: string;
              let parentSha: string | null = null;

              if (fs.existsSync(path.win32.join(wtPath, '.git'))) {
                treeSha = await snapshotTree(wtPath);
                const headRes = await gitRun(['rev-parse', '--verify', '-q', 'HEAD'], {
                  cwd: wtPath,
                  allowFailure: true,
                });
                parentSha =
                  headRes.code === 0 && headRes.stdout.trim() ? headRes.stdout.trim() : null;
              } else {
                // Unregistered folder without .git: snapshot files via main repo work-tree
                const tempDir = getTempDir();
                const rand = crypto.randomBytes(6).toString('hex');
                const tmpIdx = path.win32.join(tempDir, `maw-orphan-${rand}.idx`);
                try {
                  await gitRun([`--work-tree=${wtPath}`, 'add', '-A'], {
                    cwd: repoPath,
                    env: { GIT_INDEX_FILE: tmpIdx },
                  });
                  const wtTreeRes = await gitRun(['write-tree'], {
                    cwd: repoPath,
                    env: { GIT_INDEX_FILE: tmpIdx },
                  });
                  treeSha = wtTreeRes.stdout.trim();
                } finally {
                  if (fs.existsSync(tmpIdx)) {
                    try {
                      fs.unlinkSync(tmpIdx);
                    } catch {
                      // ignore
                    }
                  }
                }
              }

              const tempDir = getTempDir();
              const msgFile = path.win32.join(tempDir, `maw-trash-msg-${Date.now()}.txt`);
              fs.writeFileSync(msgFile, `maw cleanup trash: ${cand.name}\n`, 'utf8');

              const commitArgs = parentSha
                ? ['commit-tree', treeSha, '-p', parentSha, '-F', msgFile]
                : ['commit-tree', treeSha, '-F', msgFile];

              const commitRes = await gitRun(commitArgs, {
                cwd: repoPath,
                env: {
                  GIT_AUTHOR_NAME: 'MAW Cleanup',
                  GIT_AUTHOR_EMAIL: 'maw@localhost',
                  GIT_COMMITTER_NAME: 'MAW Cleanup',
                  GIT_COMMITTER_EMAIL: 'maw@localhost',
                },
              });

              if (isFileSafe(msgFile)) {
                try {
                  fs.unlinkSync(msgFile);
                } catch {
                  // ignore
                }
              }

              const commitSha = commitRes.stdout.trim();
              const safeName = cand.name.replace(/[^a-zA-Z0-9._-]/g, '-');
              backupRef = `refs/maw/trash/${safeName}-${formatTrashTimestamp()}`;
              const updateRefRes = await gitRun(['update-ref', backupRef, commitSha], {
                cwd: repoPath,
              });
              if (updateRefRes.code !== 0) {
                skipped.push({ id, reason: 'failed to create trash backup' });
                continue;
              }
            } catch (err) {
              skipped.push({
                id,
                reason: `trash backup failed: ${err instanceof Error ? err.message : String(err)}`,
              });
              continue;
            }
          }
        }

        // Folder removal via git worktree remove or fs.rmSync
        const rmRes = await gitRun(['worktree', 'remove', '--force', wtPath], {
          cwd: repoPath,
          allowFailure: true,
        });

        if (fs.existsSync(wtPath)) {
          try {
            fs.rmSync(wtPath, { recursive: true, force: true });
          } catch {
            // ignore
          }
        }

        // Also delete branch if exists and not checked out
        const branchName = `maw/${cand.name}`;
        await gitRun(['branch', '-D', branchName], { cwd: repoPath, allowFailure: true });

        // Update record
        await withStoreLock(async () => {
          const s = await loadWorktreesStore(dataDir);
          const r = s.worktrees.find(
            (w) => w.id === cand.name || w.worktree_path.toLowerCase() === wtPath.toLowerCase()
          );
          if (r) {
            r.status = 'discarded';
            r.cleaned_at = new Date().toISOString();
            await saveWorktreesStore(dataDir, s);
          }
        });

        // Audit
        const auditEntry = {
          Timestamp: new Date().toISOString(),
          Tool: 'maw-s1',
          Action: 'cleanup_delete',
          Project: repoPath,
          Detail: `${cand.kind} ${cand.name}${backupRef ? ` [backup ${backupRef}]` : ''}`,
        };
        appendAuditEntry(ctx.paths.auditFile, auditEntry);
        appendAuditEntry(path.win32.join(dataDir, 'audit.jsonl'), auditEntry);

        if (typeof cand.size_bytes === 'number') freedBytes += cand.size_bytes;
        deleted.push({ id, kind: cand.kind, name: cand.name, backup_ref: backupRef });
      } else if (
        cand.kind === 'checkpoint_excess' ||
        cand.kind === 'checkpoint_orphan' ||
        cand.kind === 'trash_expired'
      ) {
        const refName = cand.name;
        if (
          !refName.startsWith('refs/maw/checkpoints/') &&
          !refName.startsWith('refs/maw/trash/')
        ) {
          skipped.push({ id, reason: 'ref outside refs/maw/' });
          continue;
        }

        const delRefRes = await gitRun(['update-ref', '-d', refName], { cwd: repoPath });
        if (delRefRes.code !== 0) {
          skipped.push({ id, reason: delRefRes.stderr.trim() || 'git update-ref -d failed' });
          continue;
        }

        // Audit
        const auditEntry = {
          Timestamp: new Date().toISOString(),
          Tool: 'maw-s1',
          Action: 'cleanup_delete',
          Project: repoPath,
          Detail: `${cand.kind} ${refName}`,
        };
        appendAuditEntry(ctx.paths.auditFile, auditEntry);
        appendAuditEntry(path.win32.join(dataDir, 'audit.jsonl'), auditEntry);

        deleted.push({ id, kind: cand.kind, name: refName });
      } else {
        skipped.push({ id, reason: 'unknown candidate kind' });
      }
    } catch (err) {
      skipped.push({ id, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // Prune worktrees once at the end
  await gitRun(['worktree', 'prune'], { cwd: repoPath, allowFailure: true });

  return {
    ok: true,
    deleted,
    skipped,
    freed_bytes: freedBytes,
  };
}

export async function handleCleanupApply(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<CleanupApplyResult> {
  if (body.confirm !== true) {
    throw new ApiValidationError('Confirmation required.', 400);
  }

  const projectPath = String(body.project_path ?? ctx.paths.repoRoot).trim();
  const repoPath = resolveProjectPath(projectPath, ctx.paths.projectsRoot);
  if (!repoPath) {
    throw new ApiValidationError(`Invalid project path '${projectPath}'.`, 400);
  }

  const rawItems = Array.isArray(body.items) ? (body.items as unknown[]) : [];
  const items = rawItems.map(String).filter(Boolean);

  const rawRisky = Array.isArray(body.confirm_risky) ? (body.confirm_risky as unknown[]) : [];
  const confirmRisky = rawRisky.map(String).filter(Boolean);

  return await applyCleanupCandidates(ctx, repoPath, items, confirmRisky);
}

export function extractBranchFromTrashRef(ref: string): string {
  const baseRefName = ref.replace(/^refs\/maw\/trash\//, '');
  const withoutTs = baseRefName.replace(/-\d{14}$/, '');
  if (withoutTs.startsWith('maw-')) {
    return 'maw/' + withoutTs.slice(4);
  }
  return withoutTs.startsWith('maw/') ? withoutTs : `maw/${withoutTs}`;
}

export async function handleCleanupTrash(
  ctx: MawFeatureContext,
  query: URLSearchParams
): Promise<Record<string, unknown>> {
  const projectPath = String(query.get('project_path') ?? ctx.paths.repoRoot).trim();
  const repoPath = resolveProjectPath(projectPath, ctx.paths.projectsRoot);
  if (!repoPath) {
    throw new ApiValidationError(`Invalid project path '${projectPath}'.`, 400);
  }
  const cfg = loadCleanupConfig(ctx);

  const trashRefsRes = await gitRun(
    ['for-each-ref', '--format=%(refname)%09%(creatordate:iso-strict)%09%(contents:subject)', 'refs/maw/trash/'],
    { cwd: repoPath, allowFailure: true }
  );

  const trash: CleanupTrashItem[] = [];
  if (trashRefsRes.code === 0 && trashRefsRes.stdout.trim()) {
    for (const line of trashRefsRes.stdout.split(/\r?\n/)) {
      const parts = line.trim().split('\t');
      const ref = parts[0];
      const createdIso = parts[1] || new Date().toISOString();
      const subject = parts[2] || '';
      if (!ref) continue;

      const createdTime = new Date(createdIso).getTime();
      const expiresIso = new Date(createdTime + cfg.trash_days * 86400 * 1000).toISOString();
      const branchName = extractBranchFromTrashRef(ref);

      trash.push({
        ref,
        branch: branchName,
        created_at: createdIso,
        expires_at: expiresIso,
        last_commit_subject: subject,
      });
    }
  }

  return {
    ok: true,
    trash,
  };
}

export async function handleCleanupRestore(
  ctx: MawFeatureContext,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  if (body.confirm !== true) {
    throw new ApiValidationError('Confirmation required.', 400);
  }

  const projectPath = String(body.project_path ?? ctx.paths.repoRoot).trim();
  const repoPath = resolveProjectPath(projectPath, ctx.paths.projectsRoot);
  if (!repoPath) {
    throw new ApiValidationError(`Invalid project path '${projectPath}'.`, 400);
  }
  const ref = String(body.ref ?? '').trim();

  if (!/^refs\/maw\/trash\/[A-Za-z0-9._/-]+$/.test(ref)) {
    throw new ApiValidationError('Invalid trash ref.', 400);
  }

  // Verify ref exists
  const showRes = await gitRun(['rev-parse', '--verify', '-q', ref], {
    cwd: repoPath,
    allowFailure: true,
  });
  if (showRes.code !== 0 || !showRes.stdout.trim()) {
    throw new ApiValidationError(`Trash ref '${ref}' not found.`, 404);
  }

  // Extract candidate branch name
  const targetBranch = extractBranchFromTrashRef(ref);

  // If targetBranch exists, append -restored-<n>
  let finalBranch = targetBranch;
  let counter = 1;
  while (true) {
    const existRes = await gitRun(['show-ref', '--verify', '--quiet', `refs/heads/${finalBranch}`], {
      cwd: repoPath,
      allowFailure: true,
    });
    if (existRes.code !== 0) {
      break;
    }
    finalBranch = `${targetBranch}-restored-${counter++}`;
  }

  const branchRes = await gitRun(['branch', finalBranch, ref], { cwd: repoPath });
  if (branchRes.code !== 0) {
    throw new ApiValidationError(
      branchRes.stderr.trim() || 'Failed to restore branch from trash ref.',
      500
    );
  }

  // Audit
  const dataDir = ctx.paths.featureDataDir('worktrees');
  const auditEntry = {
    Timestamp: new Date().toISOString(),
    Tool: 'maw-s1',
    Action: 'cleanup_restore',
    Project: repoPath,
    Detail: `${ref} -> ${finalBranch}`,
  };
  appendAuditEntry(ctx.paths.auditFile, auditEntry);
  appendAuditEntry(path.win32.join(dataDir, 'audit.jsonl'), auditEntry);

  return {
    ok: true,
    branch: finalBranch,
  };
}

export async function scanCleanup(
  ctx: MawFeatureContext,
  projectPath?: string
): Promise<Record<string, unknown>> {
  const dataDir = ctx.paths.featureDataDir('worktrees');
  const store = await loadWorktreesStore(dataDir);
  const config = loadCleanupConfig(ctx);

  const reposToScan = new Set<string>();
  if (projectPath) {
    const resolved = resolveProjectPath(projectPath, ctx.paths.projectsRoot);
    if (resolved) {
      reposToScan.add(resolved);
    }
  } else {
    // 1. Projects of worktree records
    for (const w of store.worktrees) {
      if (w.project_path && isDirectorySafe(w.project_path)) {
        reposToScan.add(w.project_path);
      }
    }
    // 2. Repos with .maw-wt/<repo> under projectsRoot parent
    if (isDirectorySafe(ctx.paths.projectsRoot)) {
      try {
        const rootEntries = fs.readdirSync(ctx.paths.projectsRoot, { withFileTypes: true });
        for (const e of rootEntries) {
          if (e.isDirectory()) {
            const p = path.win32.join(ctx.paths.projectsRoot, e.name);
            const wtDir = path.win32.join(ctx.paths.projectsRoot, '.maw-wt', e.name);
            if (isDirectorySafe(wtDir) && isDirectorySafe(p)) {
              reposToScan.add(p);
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  const projects: Array<{
    project_path: string;
    count: number;
    size_bytes: number;
    risky: number;
  }> = [];

  let totalCount = 0;
  let totalSizeBytes = 0;
  const byProject: Record<string, number> = {};

  for (const repo of reposToScan) {
    try {
      const candidates = await getCleanupCandidates(ctx, repo, config);
      let repoSize = 0;
      let repoRisky = 0;
      for (const c of candidates) {
        if (typeof c.size_bytes === 'number') repoSize += c.size_bytes;
        if (c.risky) repoRisky++;
      }
      projects.push({
        project_path: repo,
        count: candidates.length,
        size_bytes: repoSize,
        risky: repoRisky,
      });
      totalCount += candidates.length;
      totalSizeBytes += repoSize;
      byProject[repo] = candidates.length;
    } catch {
      // ignore
    }
  }

  const scannedAt = new Date().toISOString();
  const summary: CleanupScanSummary = {
    scanned_at: scannedAt,
    count: totalCount,
    size_bytes: totalSizeBytes,
    by_project: byProject,
  };

  const latestFile = path.win32.join(dataDir, 'cleanup-latest.json');
  fs.writeFileSync(latestFile, JSON.stringify(summary, null, 2), 'utf8');

  return {
    ok: true,
    scanned_at: scannedAt,
    projects,
    total: {
      count: totalCount,
      size_bytes: totalSizeBytes,
    },
  };
}

let cleanupSweepTimer: NodeJS.Timeout | null = null;
let cleanupSweepStarted = false;

export async function runAutomaticSweep(ctx: MawFeatureContext): Promise<void> {
  const dataDir = ctx.paths.featureDataDir('worktrees');
  const store = await loadWorktreesStore(dataDir);
  const config = loadCleanupConfig(ctx);

  const reposToScan = new Set<string>();
  for (const w of store.worktrees) {
    if (w.project_path && isDirectorySafe(w.project_path)) {
      reposToScan.add(w.project_path);
    }
  }

  for (const repo of reposToScan) {
    try {
      const candidates = await getCleanupCandidates(ctx, repo, config);
      // Automatic safe actions: kept_worktree past remove_after and trash_expired
      const autoIds = candidates
        .filter((c) => (c.kind === 'kept_worktree' && !c.dirty) || c.kind === 'trash_expired')
        .map((c) => c.id);

      if (autoIds.length > 0) {
        await applyCleanupCandidates(ctx, repo, autoIds, []);
      }
    } catch {
      // ignore
    }
  }

  // Refresh cleanup-latest.json
  await scanCleanup(ctx);
}

export function ensureCleanupSweepStarted(ctx: MawFeatureContext): void {
  if (cleanupSweepStarted) return;
  cleanupSweepStarted = true;

  if (process.env.MAW_CLEANUP_SWEEP === '0') {
    return;
  }

  const runSweep = async () => {
    try {
      const config = loadCleanupConfig(ctx);
      if (!config.sweep_enabled) return;

      await runAutomaticSweep(ctx);
    } catch {
      // Swallowed in background sweep
    }
  };

  const scheduleNext = () => {
    const config = loadCleanupConfig(ctx);
    const ms = Math.max(1, config.sweep_hours) * 3600 * 1000;
    cleanupSweepTimer = setTimeout(async () => {
      await runSweep();
      scheduleNext();
    }, ms);
    cleanupSweepTimer.unref();
  };

  scheduleNext();
}

export function stopCleanupSweep(): void {
  if (cleanupSweepTimer) {
    clearTimeout(cleanupSweepTimer);
    cleanupSweepTimer = null;
  }
  cleanupSweepStarted = false;
}
