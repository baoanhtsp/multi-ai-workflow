# S1 — Isolation: detailed design (checkpoints, worktrees, merge, fork, best-of-N, git actions)

Stream lead: Claude (frontend, review). Backend: the S1 Antigravity conversation.
Brief: `specs/streams/s1-isolation.md`. Rules: `specs/streams/README.md`, `SPEC.md` §3.0, §7, §9.

## 0. Files and ownership

| Path | Owner | Content |
| :--- | :--- | :--- |
| `server/features/checkpoints/index.ts` | Antigravity | feature `checkpoints` (routes §1) |
| `server/features/checkpoints/snapshot.ts` | Antigravity | shared git helpers: `gitRun`, `snapshotTree`, `createCheckpoint`, `listCheckpoints`, `restoreTree`, `diffTrees`, ref / path validation. **Imported by `worktrees` too.** |
| `server/features/worktrees/index.ts` | Antigravity | feature `worktrees` (routes §2–§5) |
| `server/features/worktrees/*.ts` | Antigravity | `store.ts` (records), `merge.ts`, `bestof.ts`, `gitActions.ts`, `isolate.ts` (exported `prepareIsolatedJob`) |
| `server/tests/s1-*.test.ts` | Antigravity | node tests on real temp git repos (§8) |
| `antigravity/skills/claude-leader/scripts/hooks/_shared/10-checkpoint-lib.ps1` | Antigravity | PowerShell library `New-MawCheckpoint` (same format as the TS one). Lives under `hooks/` so `install.ps1` already copies it; `_shared` never matches an event name, so it is never run as a hook |
| `antigravity/skills/claude-leader/scripts/hooks/{job-start,round-start,before-agent}/10-checkpoint.ps1` | Antigravity | hook files (§1.2) |
| `tests/S1Checkpoint.Tests.ps1` | Antigravity | Pester for the hook library |
| `dashboard/feat-checkpoints.{js,css}`, `dashboard/feat-worktrees.{js,css}` | Claude | UI (§7) |

Nothing else is edited. Shared-file needs are listed in §9.

Common rules for every S1 action:
- `project_path` is validated with `resolveProjectPath(path, paths.projectsRoot)`; failure ⇒ `400 "Invalid project path."`. It must be inside a git work tree (`git rev-parse --show-toplevel`), else `400 "Not a git repository."`.
- Git always runs through `runCommand('git', [...args], { cwd, timeoutMs })` (argument array, `shell:false`). Never `git -c core.*` from user input. Environment adds `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` (read actions) and, where noted, `GIT_INDEX_FILE`.
- Ref / branch names from input: `^(?!.*\.\.)(?!.*//)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$`, not ending in `/`, `.` or `.lock`, and `git check-ref-format --branch <name>` must pass. Commit ids: `^[0-9a-f]{7,40}$`. Remote names: `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. A value starting with `-` is always rejected (no option injection).
- Job ids: `^job_[A-Za-z0-9_]{1,80}$` (as produced by the runner). Checkpoint "job keys": `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$`.
- Destructive actions (`checkpoint_restore`, `worktree_merge`, `worktree_discard`, `bestof_pick`, `git_push`, `git_pull`, `git_branch_switch`) require `"confirm": true` in the body (else `400 "Confirmation required."`) and append one line to the audit file through `appendAuditEntry(paths.auditFile, { Tool: 'maw-s1', Action: '<action>', Project, Detail, Timestamp })` **and** to `featureDataDir('worktrees'|'checkpoints')/audit.jsonl`.
- Errors: `ApiValidationError(msg, status)` ⇒ `{ ok:false, error }`. Git failures ⇒ `500` with `"git <subcommand> failed: <first stderr line>"` (stderr trimmed to 400 chars).
- Output sizes: patches are cut at **512 KB** (`truncated: true`), file lists at 2000 entries.

---

## 1. B7 — Checkpoints + rollback (feature `checkpoints`)

### 1.1 Snapshot format (identical in TS and PowerShell)
A checkpoint is a commit object that captures the **whole working tree** (tracked + untracked, `.gitignore` respected) without touching the real index, HEAD or files:
1. `tmpIndex = <temp>/maw-cp-<rand>.idx`; copy the real index (`git rev-parse --git-path index`) to it when it exists (speed: stat cache).
2. With `GIT_INDEX_FILE=tmpIndex`: `git add -A -- .` then `git write-tree` ⇒ `tree`.
3. `parent = git rev-parse --verify -q HEAD` (absent in an empty repo ⇒ no `-p`).
4. `git commit-tree <tree> [-p <parent>] -F <msgfile>` with author/committer `MAW Checkpoint <maw@localhost>` (env `GIT_AUTHOR_*` / `GIT_COMMITTER_*`).
5. `git update-ref refs/maw/checkpoints/<jobKey>/<n> <commit>` where `<n>` is the next integer for that job key, zero-padded to 4 digits (`0001`).
6. Delete the temp index (finally).

Commit message:
```
maw checkpoint: <label>

MAW-Event: job-start|round-start|before-agent|safety|manual|merge
MAW-Job: <jobKey>
MAW-Agent: <agent or empty>
MAW-Role: <role or empty>
MAW-Round: <n or empty>
MAW-Workdir: <absolute normalised workdir>
```
- **Dedup**: if the newest checkpoint of the same job key has the same tree, nothing is created and the existing one is returned (`created: false`). This collapses `job-start` + `before-agent` fired back-to-back.
- **Retention**: after creating, keep the newest `retention` checkpoints whose `MAW-Workdir` is this workdir (default **50**, from `featureDataDir('checkpoints')/config.json` `{ "retention": 50 }`, range 5–500) and delete older refs with `git update-ref -d`. `safety` checkpoints count too.
- Checkpoint id exposed to the API = `<jobKey>/<n>` (e.g. `job_20261025_101500_ab12cd/0001`). Validation: `^[A-Za-z0-9][A-Za-z0-9._-]{0,79}/\d{4}$`.
- Refs are shared by every worktree of a repository, so listing **filters by `MAW-Workdir`** (case-insensitive, `\` normalised).
- A non-git project ⇒ hooks do nothing (one log line `[checkpoint] skipped: not a git repository`).

### 1.2 Hooks (PowerShell 5.1)
`scripts/hooks/_shared/10-checkpoint-lib.ps1` defines `New-MawCheckpoint -WorkDir -JobKey -Event -Label [-Agent] [-Role] [-Round] [-Retention]` implementing §1.1 with `Invoke-NativeProcess`-style argument arrays (stdin closed; `$env:GIT_INDEX_FILE` set only for the child and restored in `finally`). It returns the checkpoint id or `$null`, and **never throws** (a failed checkpoint must not block the job; it writes `[checkpoint] failed: …`).

Hook files (each is ~10 lines, dot-sources the library via `Join-Path (Split-Path $PSScriptRoot) '_shared\10-checkpoint-lib.ps1'`, never returns `Block`):
- `hooks/job-start/10-checkpoint.ps1`: `JobKey = $Context.job_id`, `WorkDir = $Context.project`, label `before job <job_id> (<agent>/<role>)`. Writes `[checkpoint] <id>` (becomes a job-log line).
- `hooks/round-start/10-checkpoint.ps1`: `JobKey = $env:MAW_JOB_ID` if valid else `autogate-<yyyyMMdd>`; label `before Auto-Gate round <round>`; `Round = $Context.round`.
- `hooks/before-agent/10-checkpoint.ps1`: `JobKey = $env:MAW_JOB_ID` if valid else `agent-<yyyyMMdd>`; label `before <agent> as <role>`; `WorkDir = $Context.workdir`.
- Opt-out: env `MAW_CHECKPOINTS=0` or `config.json` `{ "enabled": false }` ⇒ hooks do nothing.

### 1.3 Actions
**`GET checkpoint_list?project_path=&job_id=&limit=`** (limit 1–500, default 200)
```json
{ "ok": true, "project_path": "C:\\…", "head": "<sha>", "retention": 50,
  "checkpoints": [ { "id": "job_x/0001", "job_key": "job_x", "n": 1, "commit": "<sha>", "tree": "<sha>",
     "parent": "<sha>|null", "event": "job-start", "label": "before job …", "agent": "claude", "role": "backend",
     "round": null, "created_at": "2026-10-25T10:15:00+07:00", "head_moved": false,
     "stats": { "files": 3, "additions": 10, "deletions": 2 } } ] }
```
Newest first. `head_moved` = `parent !== current HEAD`. `stats` = diff of this checkpoint vs the previous (older) checkpoint of the same workdir (`git diff --numstat`), `null` for the oldest. `job_id` filters by job key.

**`GET checkpoint_diff?project_path=&from=<id>&to=<id|WORKTREE>&path=`** (`to` default `WORKTREE` = a fresh snapshot tree, no ref written)
```json
{ "ok": true, "from": "job_x/0001", "to": "WORKTREE",
  "files": [ { "path": "src/a.ts", "status": "M|A|D|R", "old_path": null, "additions": 3, "deletions": 1, "binary": false } ],
  "patch": "diff --git …", "truncated": false }
```
`path` (optional, validated relative path without `..`) limits the patch to one file.

**`POST checkpoint_create { project_path, label? }`** — manual checkpoint, job key `manual`, event `manual`. Returns `{ ok, checkpoint, created }`.

**`POST checkpoint_restore { project_path, checkpoint, confirm: true }`**
1. Safety checkpoint first: job key `safety`, event `safety`, label `before restore to <checkpoint>` ⇒ `safety_checkpoint` (so the restore can be undone by restoring it).
2. `current = snapshotTree()`, `target = <checkpoint>^{tree}`.
3. With a temp index: `git read-tree <target>` then `git checkout-index -a -f` (writes every file of the checkpoint; real index untouched).
4. Delete files that exist in `current` but not in `target` (`git diff --name-only --diff-filter=D <current> <target>` semantics, i.e. added since the checkpoint); remove directories left empty. Ignored files are never touched.
5. HEAD is **not** moved. If the checkpoint's parent ≠ HEAD the response has `head_moved: true` and the UI says commits made since are kept.
```json
{ "ok": true, "restored": "job_x/0001", "safety_checkpoint": "safety/0007", "files_written": 12, "files_deleted": 2, "head_moved": false }
```
**`POST checkpoint_config { project_path?, retention?, enabled? }`** — saves `config.json`; returns it. **`GET checkpoint_rollback_target?job_id=`** — the first checkpoint of that job (`job-start`), plus `project_path` read from the job meta (`<jobsDir>/<job_id>.json`), so the UI can offer "Rollback to before this job" with only `state.job.id`. `404` when the job has no checkpoint.

`status()` → `feature_data.checkpoints = { enabled, retention }` (cheap; no git calls).

---

## 2. B1 — Worktree + branch per job / handoff (feature `worktrees`)

### 2.1 Layout and records
- Repository root `repo = git rev-parse --show-toplevel` of `project_path` (for a project that is itself a linked worktree use the **main** worktree: first entry of `git worktree list --porcelain`).
- Worktree path: `<dirname(repo)>/.maw-wt/<basename(repo)>/<name>`; branch `maw/<name>`. `.maw-wt` starts with a dot, so the status project scan already hides it, and it stays inside `projectsRoot`, so `resolveProjectPath` accepts it (jobs can run there).
- `name`: `^[a-z0-9][a-z0-9._-]{0,47}$`; default `wt-<yyyyMMdd-HHmmss>-<4 hex>`; for a job `j-<job tail>`; best-of-N `bo-<id>-<i>`. Must not exist yet (path or branch) ⇒ `409`.
- Records: `featureDataDir('worktrees')/worktrees.json` = `{ "version": 1, "worktrees": [Record] }`, written atomically (temp file + rename) behind an in-process mutex.
```ts
interface WorktreeRecord {
  id: string;            // = name
  project_path: string;  // main repo root
  worktree_path: string;
  branch: string;        // maw/<name>
  base: string;          // base branch name (or commit when detached)
  base_commit: string;   // sha at creation
  port: number;          // MAW_PORT, unique among active records, 4400–4999
  origin: 'manual' | 'job' | 'fork' | 'bestof' | 'handoff';
  job_id?: string;       // job running in it
  source_job_id?: string;// fork source
  bestof_id?: string;
  owner?: string;        // registry agent id, used by SPEC Guard
  status: 'active' | 'merged' | 'discarded' | 'missing';
  created_at: string; updated_at: string;
  merged?: { strategy: string; commit: string; at: string };
  setup?: { ran: boolean; exit_code: number | null; log: string };
}
```

### 2.2 `POST worktree_create { project_path, base?, name?, owner?, origin? }`
1. `base` default = current branch of the repo (`git symbolic-ref --short -q HEAD`, else `HEAD` sha). Must resolve (`git rev-parse --verify <base>^{commit}`) ⇒ else `400`.
2. `git worktree add -b maw/<name> <wtPath> <base>`.
3. `.worktreeinclude` in the repo root (one relative path per line, `#` comments, blank lines; simple globs `*` and `**` allowed; entries with `..`, absolute paths or drive letters are skipped): matching **files** that exist in the repo (typically ignored ones like `.env`) are copied to the same relative path; max 200 files / 50 MB total.
4. Port: lowest free in 4400–4999 not used by an active record.
5. Setup: if `<repo>/.maw/setup.ps1` exists, run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <repo>\.maw\setup.ps1` with `cwd = wtPath`, env `WORKTREE_PATH`, `REPO_PATH`, `MAW_PORT`, timeout 300 s. Output → `featureDataDir('worktrees')/logs/<name>.setup.log`. A failing setup does **not** remove the worktree; it is reported.
6. Response: `{ ok, worktree: Record, copied: ["…"], setup: { ran, exit_code, log_tail } }`.

### 2.3 `GET worktree_list?project_path=&include=all`
Records for the project (all projects when omitted), `active` only unless `include=all`. Each gets a live part (records whose folder vanished become `missing`):
```json
{ "id": "…", …record, "live": { "exists": true, "head": "<sha>", "dirty": 3, "ahead": 2, "behind": 0,
  "additions": 40, "deletions": 5, "files": 4, "job_status": "RUNNING|DONE|FAILED|…|null" } }
```
`ahead/behind` = `git rev-list --left-right --count <base>...HEAD` in the worktree. `additions/deletions/files` = diff of `merge-base(base, HEAD)` vs a snapshot tree of the worktree (committed **and** uncommitted work). `job_status` from the job meta.

### 2.4 `GET worktree_diff?id=&path=`
Same shape as `checkpoint_diff`, from `merge-base(base, HEAD)` to the worktree snapshot tree (so uncommitted agent edits are included). Plus `commits: [{ sha, subject, author, date }]` (`git log <merge-base>..HEAD`, max 100).

### 2.5 `POST worktree_merge { id, strategy: "merge"|"squash"|"rebase", message?, owner?, force?: false, remove?: true, confirm: true }`
1. Record must be `active`; its job (if any) must not be `RUNNING` ⇒ `409 "Job is still running."`.
2. **Commit pending work in the worktree**: if dirty, `git add -A` + `git commit -m "maw: work from <job_id|name>"` (author from git config; fallback `MAW <maw@localhost>` through env).
3. **SPEC Guard on the branch diff (before merging)** — owner = `owner` ‖ `record.owner` ‖ the job's agent. In the worktree: remember `tip`, `git reset --soft <merge-base>` (index + files unchanged, so every branch change shows as staged), run `invoke-spec-guard.ps1 -WorkDir <wt> -Owner <owner> -Json` through `powershell.exe` (argument array, 120 s), then `git reset --soft <tip>` in `finally`. Skipped when the repo has no `SPEC.md` or no owner. A violation and `force !== true` ⇒ no merge: `{ ok:true, merged:false, blocked:"spec_guard", spec_guard }`.
3b. **S4 test gate** (when the `checks` feature is loaded and `ctx.callAction` exists, R11): `checks_gate?project_path=<wt>&scope=merge[&override_token=<body.checks_override_token>]`; `green: false` ⇒ `{ ok:true, merged:false, blocked:"checks", checks: <gate> }` (no `force` bypass — the override is S4's `checks_override`, which returns a one-time token). Without S4 the gate is skipped and the response carries `checks: null`.
4. The main checkout must be on `base` and have no tracked changes (`git status --porcelain --untracked-files=no` empty) ⇒ else `409` with the reason. A safety checkpoint of the main checkout is taken (event `merge`).
5. Merge in the main checkout:
   - `merge`: `git merge --no-ff -m <msg> maw/<name>`;
   - `squash`: `git merge --squash maw/<name>` then `git commit -m <msg>`;
   - `rebase`: in the worktree `git rebase <base>`; then in the main checkout `git merge --ff-only maw/<name>`.
   Default message: `Merge maw/<name> (<origin> <job_id>)`.
6. **Conflicts**: collect `git diff --name-only --diff-filter=U`, then `git merge --abort` / `git rebase --abort` so both trees are clean again, and return
   `{ ok:true, merged:false, blocked:"conflicts", conflicts:["a.ts","b.ts"], fix_hint:{ action:"worktree_fix_conflicts", id } }`.
7. Success: record `status:"merged"`, `merged:{strategy, commit, at}`; when `remove` (default true) `git worktree remove --force <wt>` and `git branch -D maw/<name>` (the branch tip stays reachable from the merge). Response `{ ok:true, merged:true, commit, spec_guard, removed }`.

### 2.6 `POST worktree_fix_conflicts { id, agent, model?, confirm: true }`
In the **worktree**: `git merge --no-commit <base>` (conflict markers land in the worktree, never in the main checkout); then `ctx.startJob({ mode:"task", agent, role:"backend", model, project_path:<wt>, prompt })` with a prompt listing the conflicting files and asking to resolve every conflict marker, keep both sides' intent, run the project's checks and `git commit`. Records `job_id`. Returns `{ ok, job_id, conflicts }`. The UI then offers "Merge again".

### 2.7 `POST worktree_discard { id, delete_branch?: true, confirm: true }`
Before deleting, the final state is kept: snapshot commit of the worktree ⇒ `refs/maw/discarded/<name>` (recoverable with `git worktree add … refs/maw/discarded/<name>`). Then `git worktree remove --force`, `git branch -D maw/<name>` (when `delete_branch`), `git worktree prune`. Record `status:"discarded"`. Response `{ ok, discarded, kept_ref }`.

### 2.8 Isolated jobs — `POST worktree_job { …run_job body, base?, name? }`
The interim way to get `isolate: true` until the runner change (§9 R1) lands:
1. `prepareIsolatedJob(ctx, body)` (exported from `isolate.ts`): `worktree_create` with `origin:"job"`, `owner = body.agent ‖ body.implementer`.
2. `ctx.startJob({ ...body, project_path: <wt>, isolate: undefined })`.
3. Record `job_id`. Response = the `run_job` response plus `worktree: { id, path, branch, port }`.
`feature_data.worktrees.jobs` maps `job_id → { id, branch, path }` so other streams (S2, S6) and the UI can find a job's worktree.

---

## 3. #3 — Fork a job: `POST job_fork { job_id, agent?, model?, effort?, role?, note?, base?: "project"|"result" }`
1. Read `<jobsDir>/<job_id>.json` (meta) and `<job_id>.prompt.txt`; `404` when missing. Works for running and finished jobs.
2. Summary of the previous result = the last 6000 characters of `<job_id>.log`, without the runner header, ANSI codes removed.
3. Base: `"project"` (default) = HEAD of the source project's main checkout; `"result"` = when the source job ran in an S1 worktree, its branch tip **plus** its uncommitted work (snapshot commit), so the fork continues from the result.
4. Worktree `origin:"fork"`, `source_job_id`. Prompt:
```
<original prompt>

---
## Previous attempt (job <job_id>, agent <agent>, status <status>)
<summary>

## Instructions for this attempt
<note, or "Solve the task again, independently; avoid the problems visible above.">
```
   (cut to 20000 characters, the original prompt is kept whole and the summary is shortened first).
5. `ctx.startJob({ mode:"task", agent: agent ‖ meta.agent, role: role ‖ meta.role ‖ "backend", model, effort, project_path: <wt>, prompt })`. Source modes other than `task`/`team` fork as `task`.
Response: `{ ok, job_id, source_job_id, worktree }`.

---

## 4. N2 — Best-of-N
### 4.1 `POST bestof_start { project_path, prompt, role, candidates:[{agent, model?, effort?}], judge:"council"|"tests"|"both", reviewers?: [ids], base? }`
- 2–4 candidates; agents must be enabled registry entries with `capabilities.write`; duplicates allowed only with different models.
- `id = bo<yyyyMMddHHmmss><2 hex>`; one worktree per candidate (`bo-<id>-<i>`, `origin:"bestof"`), one job each through `ctx.startJob({ mode:"task", … })`.
- Run file `featureDataDir('worktrees')/bestof/<id>.json`:
```ts
interface BestOfRun {
  id: string; project_path: string; prompt: string; role: string; judge: 'council'|'tests'|'both';
  reviewers: string[]; base: string; created_at: string;
  state: 'running' | 'judging' | 'done' | 'picked' | 'cancelled';
  candidates: Array<{ i: number; agent: string; model?: string; effort?: string; worktree_id: string;
    job_id: string; job_status: string; started_at: string; finished_at?: string; duration_s?: number;
    diff: { files: number; additions: number; deletions: number } | null;
    tests: { status: 'pass'|'fail'|'none'|'running'|'error'; results: Array<{ name: string; exit_code: number|null; duration_s: number; tail: string }> } | null;
    council: { job_id: string; status: string; verdicts: Record<string, string>; score: number|null; approved: boolean|null } | null;
    cost_usd: number | null; rank?: number; total?: number }>;
  winner?: number; picked?: { i: number; merge_commit: string; at: string };
}
```
### 4.2 State machine (advanced lazily by `bestof_status` and by the feature `status()`; idempotent, guarded by a per-run lock)
- `running` → when every candidate job is finished ⇒ `judging`:
  - **tests** (`tests`/`both`) — **through S4 only** (revised 2026-10-25 after S4's review): S1 never executes `.maw/checks.json` itself, because S4 runs a config only after the user trusted its sha256, and an agent or a cloned repo could otherwise make S1 run arbitrary commands. When the `checks` feature is loaded (`ctx.callAction` available, R11): `checks_run { project_path:<wt> }`, then poll `checks_status?project_path=<wt>` in the background until it is no longer pending. `tests.status` = `pass` when `gate.green`, `fail` when red, `error` when S4 reports an error, with `results[]` copied from S4 (`{ id, label, status, exit_code, duration_s, tail }`). Without S4 / R11 ⇒ `tests: { status:"unavailable", results:[] }`, which ranks like `none`. The judge `tests` alone is refused with 400 "Test gate (S4 checks) is not available" when S4 is absent.
  - **council** (`council`/`both`): one job per candidate `ctx.startJob({ mode:"council", project_path:<wt>, reviewers, prompt:"Best-of-N candidate <i> for: <prompt>" })`. Council reviews the worktree's uncommitted diff (`Get-ReviewDiff`); a candidate that committed is first `git reset --soft <base_commit>` (same trick as §2.5, restored afterwards is **not** needed because the merge commits pending work anyway). Verdicts/score parsed from `=== COUNCIL_RESULT <id>=<VERDICT>|<score> … ===` in the council job log; score = minimum.
  - `cost_usd`: sum of `CostUsd` of audit lines whose time is within the candidate job's start/finish and whose agent matches (estimate; `null` when unknown).
- `judging` → `done` when tests and council are finished. Ranking: failed job last; then tests pass > none > fail; then council approved; then score (desc); then smaller diff; then shorter duration. `winner` = rank 1.
### 4.3 Other actions
- `GET bestof_status?id=` → the run (advanced first). `GET bestof_list?project_path=` → newest 20 runs (summary).
- `POST bestof_pick { id, candidate, strategy?: "squash", discard_others?: true, force?: false, confirm: true }` → `worktree_merge` of that candidate (same blocking rules), then `worktree_discard` of the others when requested; state `picked`.
- `POST bestof_cancel { id, confirm: true }` → `cancel_job`-equivalent for running candidate jobs (through the job meta pid, same as the runner's cancel), state `cancelled`; worktrees kept until discarded.
- `feature_data.worktrees.bestof_active` = number of runs in `running|judging`.

---

## 5. V8 — Git actions (HTTP only, used by the S6 agent context menu)
All take `project_path` (any validated project or S1 worktree path).
| Action | Method | Body / query | Git |
| :--- | :--- | :--- | :--- |
| `git_log` | GET | `project_path, ref?, limit? (1–200, 50), path?` | `git log --format=%H%x1f%h%x1f%an%x1f%aI%x1f%s -n <limit> [<ref>] [-- <path>]` ⇒ `commits[]` |
| `git_diff` | GET | `project_path, ref?, staged?, path?` | `git diff [--cached] [<ref>] [-- <path>]` ⇒ `{ files[], patch, truncated }` (same shape as §1.3) |
| `git_pull` | POST | `project_path, remote? (origin), branch?, confirm` | `git pull --ff-only <remote> [<branch>]` (timeout 120 s) |
| `git_push` | POST | `project_path, remote? (origin), branch? (current), set_upstream?, confirm` | `git push [-u] <remote> <branch>`; **never** `--force` |
| `git_branch_switch` | POST | `project_path, branch, confirm` | `git switch <branch>` (fails cleanly when changes would be lost) |
| `git_branch_create` | POST | `project_path, name, base?, switch? (true)` | `git switch -c <name> [<base>]` or `git branch <name> [<base>]` |
Responses: `{ ok, output }` (stdout+stderr tail, 4000 chars) plus the parsed data above. Network actions set `GIT_TERMINAL_PROMPT=0` so a missing credential fails instead of hanging.

---

## 5b. C1 — Cleanup of dashboard-made branches, worktrees and checkpoints (feature `worktrees`, file `server/features/worktrees/cleanup.ts`)

### 5b.1 Settings
`featureDataDir('worktrees')/cleanup-config.json` (defaults in brackets), read by `GET cleanup_config`, written by `POST cleanup_config_save { …partial }` (integers, validated ranges):
- `keep_after_merge_days` [0] (0–90): 0 = `worktree_merge` removes the worktree + deletes `maw/<name>` right away (today's behaviour). N > 0 = keep both; the record gets `remove_after = merged.at + N days` and the sweep removes them later. The merge body's `remove` still overrides per call; the UI checkbox defaults to `keep_after_merge_days === 0`.
- `stale_branch_days` [14] (1–365): unmerged `maw/*` older than this is a (risky) candidate.
- `trash_days` [30] (1–365): age after which `refs/maw/trash/*` backups are purged.
- `sweep_hours` [24] (1–168), `sweep_enabled` [true].

### 5b.2 Candidates — `GET cleanup_preview?project_path=` (dry run, never deletes)
Scope = the repository of `project_path` (its main worktree root, as in §2.1). Only dashboard-made objects are ever listed:
| kind | what | merged | risky (unchecked by default) |
| :--- | :--- | :--- | :--- |
| `merged_branch` | local `maw/*` branch whose tip is an ancestor of its base (`git merge-base --is-ancestor`), or whose S1 record is `merged` (squash merges are not ancestors) | true | no |
| `kept_worktree` | worktree of a `merged` record past `remove_after` | true | no |
| `orphan_worktree` | (a) git-registered worktree under `.maw-wt/<repo>/` whose folder is gone (`prunable` in `git worktree list --porcelain`), (b) folder under `.maw-wt/<repo>/` not registered in git, (c) registered worktree there without an S1 record | — | (b)/(c) with files: yes |
| `stale_worktree` | `active` record whose job meta is gone (or no job) and whose last commit / folder mtime is older than `stale_branch_days` | false | yes |
| `stale_branch` | unmerged `maw/*` branch without an active worktree, last commit older than `stale_branch_days` | false | yes |
| `checkpoint_excess` | `refs/maw/checkpoints/**` beyond `retention` for a workdir (normally pruned at creation) | — | no |
| `checkpoint_orphan` | checkpoint refs whose `MAW-Workdir` folder no longer exists | — | no |
| `trash_expired` | `refs/maw/trash/*` older than `trash_days` | — | no |

Each candidate:
```json
{ "id": "merged_branch:maw/wt-1", "kind": "merged_branch", "name": "maw/wt-1", "path": null,
  "reason": "merged into main", "merged": true, "risky": false, "dirty": false, "protected": false,
  "last_commit_at": "2026-10-20T10:00:00+07:00", "size_bytes": 12345, "default_selected": true }
```
- `id` = `<kind>:<name>`; `name` is the branch, the ref or the worktree folder name. `path` = absolute folder for worktree kinds.
- `size_bytes`: worktree kinds = folder size (walk, `.git` file excluded, stop after 200 000 entries ⇒ approximate `size_approx: true`); branch kinds = `git rev-list --objects --disk-usage <base>..<branch>` (null when git is too old); refs = null.
- `dirty` (worktree kinds): `git status --porcelain` not empty ⇒ `risky: true`, `default_selected: false`.
- Response: `{ ok, project_path, scanned_at, config, candidates[], totals: { count, size_bytes, risky } }`.

### 5b.3 Apply — `POST cleanup_apply { project_path, items: [ids], confirm: true, confirm_risky?: [ids] }`
1. Recompute the candidates (same code as preview). An id that is not in the fresh list is skipped with `reason: "no longer a candidate"` — the client can never name arbitrary refs or folders.
2. A risky or dirty item is deleted only when its id is also in `confirm_risky`; otherwise skipped `"needs confirm_risky"`.
3. **Safety rules (backend, every item, re-checked right before deleting):**
   - branches: name must match `^maw/[a-z0-9][a-z0-9._/-]{0,80}$` and pass `validateRefName`; refuse `main`, `master`, `develop`, `release/*` (defence in depth), any branch checked out in **any** worktree (`git worktree list --porcelain` `branch` lines).
   - worktree folders: realpath must be inside `<dirname(repo)>\.maw-wt\<basename(repo)>\` (no junction/symlink escape); never the main worktree.
   - refs: only `refs/maw/checkpoints/**` and `refs/maw/trash/**`.
   - an unmerged branch (or a dirty worktree's state) is first saved as `refs/maw/trash/<branch-with-/-as-->-<yyyyMMddHHmmss>` (dirty worktree ⇒ snapshot commit of its files, like §2.7). Creating the backup must succeed, else the item fails.
   - git calls with argument arrays only; folder removal via `git worktree remove --force` (registered) or `fs.rmSync` (unregistered folder, after the path check).
   - one audit line per deleted item (`Tool: maw-s1, Action: cleanup_delete, Detail: <kind> <name> [backup <ref>]`) in both audit files.
   - records: branch/worktree items set the S1 record to `discarded` (`cleaned_at`); `git worktree prune` once at the end.
4. Response `{ ok, deleted: [{ id, kind, name, backup_ref? }], skipped: [{ id, reason }], freed_bytes }`.

### 5b.4 Trash — `GET cleanup_trash?project_path=` / `POST cleanup_restore { project_path, ref, confirm: true }`
- List `refs/maw/trash/*` with `{ ref, branch, created_at, expires_at, last_commit_subject }`.
- Restore recreates the branch from the backup (`git branch <branch> <ref>`; when the name exists, `<branch>-restored-<n>`), keeps the trash ref, writes an audit line. Returns `{ ok, branch }`.

### 5b.5 Scan and periodic sweep — `GET cleanup_scan?project_path=` (contract for S2 schedules and S3 inbox)
- Same candidates as preview, never deletes; without `project_path` it scans every repository known to S1 (projects of worktree records + repos with a `.maw-wt/<name>` folder under `projectsRoot`). Stores the latest result in `featureDataDir('worktrees')/cleanup-latest.json`.
- Response: `{ ok, scanned_at, projects: [{ project_path, count, size_bytes, risky }], total: { count, size_bytes } }` (candidates omitted; call preview for them).
- `status.feature_data.worktrees.cleanup = { scanned_at, count, size_bytes, by_project: { <path>: count } }` read from `cleanup-latest.json` (no git in status).
- **Internal sweep** until S2 / S3 are merged: started lazily the first time the feature sees a ctx (first `status()` call, i.e. right after server start), then every `sweep_hours`; timers are `unref()`ed; disabled when env `MAW_CLEANUP_SWEEP=0` (tests) or `sweep_enabled: false`. The sweep runs `cleanup_scan` and performs only the two automatic, non-destructive-to-work actions: removing `kept_worktree` items (merged, past `remove_after`) and purging `trash_expired` refs. Everything else waits for the user.
- S2 can schedule `GET cleanup_scan` weekly; S3 can read `status.feature_data.worktrees.cleanup.count` ("N items can be cleaned").

### 5b.6 Tests
- node (`server/tests/s1-cleanup.test.ts`): candidate detection for every kind; protected branch refused even when its id is forged; checked-out branch refused; dirty worktree skipped without `confirm_risky` and deleted with it (backup ref created); unmerged branch ⇒ trash ref exists and `cleanup_restore` brings it back; items not in the fresh list skipped; path outside `.maw-wt` refused; trash purge after `trash_days`; `keep_after_merge_days` keeps then sweep removes; scan writes `cleanup-latest.json` and feature_data reflects it.
- Pester `tests/S1Cleanup.Tests.ps1`: starts `node server/main.ts` on a free port with temp `--projects-root`, `MAW_HOME`, `TEMP`/`TMP` and `MAW_CLEANUP_SWEEP=0`; creates a temp repo with one merged `maw/*` branch, one unmerged stale branch and one orphan worktree folder; calls `cleanup_preview`, then `cleanup_apply` with only the merged branch + orphan; asserts those are gone and the stale branch is still there.
- Tests never touch the real install, `%TEMP%\maw_jobs` or `~/.maw` (own scriptsDir / jobsDir / MAW_HOME).

---

## 6. `status()` of the two features
- `feature_data.checkpoints = { enabled, retention }`.
- `feature_data.worktrees = { active: <count>, jobs: { <job_id>: { id, branch, path } }, bestof_active, cleanup: { scanned_at, count, size_bytes, by_project } }` — read from the JSON files only (no git calls; status runs every few seconds).

---

## 7. UI (Claude) — `dashboard/feat-checkpoints.js|css`, `dashboard/feat-worktrees.js|css`
Both use only `window.MAW` (`api`, `t`, `toast`, `esc`, `badge`, `fmt`, `on`, `addI18n`, `addTab`, `addJobAction`, `addProjectAction`, `project`, `agents`, `runJob`). Bilingual VI/EN through `addI18n`. Styles use the page's CSS variables only (light / dark / neon), mobile-first, no external assets.
- **Checkpoints tab** (`addTab id:"checkpoints"`): vertical timeline of the selected project grouped by job (event chip, label, agent/role badge, time, `+a −d`, "HEAD moved" warning). Per item: **Diff** (vs working tree, or vs the previous checkpoint) in an in-house diff viewer (file list + coloured patch), **Restore** (confirm dialog that names the safety checkpoint) and a **Undo last restore** banner after a restore. Toolbar: "Checkpoint now", retention setting, refresh. Count badge = number of checkpoints.
- **Job action** "Rollback to before this job" (`when` = job finished and a checkpoint exists — looked up lazily via `checkpoint_rollback_target`) and **"Fork job"** (any job; dialog: agent, model, note, base project/result).
- **Worktrees tab** (`addTab id:"worktrees"`): cards per worktree (branch, origin, job status badge, ahead/behind, `+a −d`, dirty count, port) with **Diff**, **Merge** (dialog: strategy, message, owner, "remove after merge"; shows SPEC Guard block / conflicts with a "Fix conflicts with agent ▾" button), **Discard** (confirm, shows the kept ref), **Open in job** (runs a job there through `MAW.runJob` with the project path set to the worktree).
- **Best-of-N** section in the same tab: launcher (prompt, role, 2–4 candidate rows agent+model, judge) and a **comparison card** per run: one column per candidate with rank, job status, tests, council verdicts + score, cost, time, diff size, "View diff" and **"Merge winner"** (`bestof_pick`).
- **Project actions**: "New worktree" (base, name), "Best-of-N…" (opens the launcher), "Run isolated" (prompt + agent → `worktree_job`).
- **Cleanup sub-view (C1)** — 4th segment "Dọn dẹp / Cleanup" in the Worktrees tab, with the count from `feature_data.worktrees.cleanup.count` on the segment: "Scan" (= `cleanup_preview`), candidates grouped by kind with checkbox, name, reason, merged/risky/dirty badges, last commit (relative), size; a sticky footer with "N selected · X MB reclaimed" and "Clean up…". Risky items start unchecked; the confirm dialog lists the selected items, and when any risky item is selected a second checkbox "I understand these are unmerged / have uncommitted work (a backup ref is kept for 30 days)" must be ticked before the button enables (those ids go in `confirm_risky`). Result toast + skipped reasons. Below: settings (keep after merge days, stale days) and the Trash list with "Restore". The project action "Clean up…" opens it. The merge dialog's "remove after merge" checkbox defaults from `keep_after_merge_days`. Merge `blocked: "checks"` shows S4's gate items.
- **Git panel** (small, inside the Worktrees tab): log (20), current branch, pull / push (confirm) / switch / create branch — the S6 context menu calls the same actions.
- Polling: the tab refreshes on the `data` event only while it is visible, and a running best-of-N card polls `bestof_status` every 5 s.

---

## 8. Tests (Antigravity)
`server/tests/s1-checkpoints.test.ts`, `s1-worktrees.test.ts` (node:test) on throwaway git repos created under a temp `projectsRoot` with a temp `MAW_HOME`; call the route handlers directly with a fake ctx (`startJob` stub records its body):
- checkpoint: create (tracked + untracked + ignored file ⇒ ignored not captured), dedup, list filtered by workdir, diff vs worktree, restore (modified file back, added file deleted, ignored file kept), safety checkpoint, retention pruning, invalid ids / refs rejected, `confirm` required.
- worktree: create (branch, path under `.maw-wt`, `.worktreeinclude` copy, setup script with env + failing setup reported, port unique), list live stats, diff includes uncommitted, merge for each strategy, conflict report + abort leaves both clean, discard keeps `refs/maw/discarded/*`, `worktree_job` passes the worktree path to `startJob`, fork prompt shape, best-of-N state machine with stub jobs (fake meta/log files with `COUNCIL_RESULT`) and ranking, V8 log / diff / branch create / switch, push without remote fails cleanly, option-injection values (`-x`, `--upload-pack=…`) rejected.
- Pester `tests/S1Checkpoint.Tests.ps1`: `New-MawCheckpoint` creates `refs/maw/checkpoints/<job>/0001` with the trailers, dedups, never throws in a non-git folder, and the three hook files return no `Block`.
- `tests/api-smoke.ps1` is shared (Tech Lead); S1 adds nothing there (see R4).

---

## 9. Requests to Tech Lead
- **R1 — `run_job { isolate: true }`** (`server/actions/jobs.ts`): when `isolate === true`, call `prepareIsolatedJob(ctx, body)` from `server/features/worktrees/isolate.ts` before `buildValidatedCommand`, use the returned worktree path as `project_path`, and store `meta.worktree = { id, path, branch }` + `meta.isolated_from = <original project_path>`; `status.jobs[]` and `job_status` echo `worktree`. Until then S1 offers `worktree_job` with the same body.
- **R2 — job id for nested hooks**: the job runner should set `$env:MAW_JOB_ID = '<job_id>'` (and `$env:MAW_PROJECT`) before running the command, so `before-agent` and `round-start` checkpoints are attributed to the job (today they fall back to `agent-<date>` / `autogate-<date>` keys).
- **R3 — `status.jobs[]` `project_path`**: rows carry only `project_name`; S1 reads the job meta by id instead, so this is nice-to-have.
- **R4 — api-smoke**: add one smoke call each for `checkpoint_list`, `worktree_list`, `git_log` on a temp repo once the streams are merged.
- **R5 — install note**: the server prefers the installed scripts dir (`~/.gemini/config/skills/claude-leader/scripts`) when it exists, so the S1 hooks only run after `install.ps1` (which already copies `scripts/hooks/**` recursively). Please re-run it after merging.
- **R6 — SPEC Guard `-DiffBase <ref>`** (optional): would replace the soft-reset trick in §2.5.
- **R7 — `MAW.watchJob(runResponse)`** in `index.html`: jobs started by feature actions (`worktree_job`, `job_fork`, `worktree_fix_conflicts`) cannot be attached to the live job box today; `watchJob` would call the existing `startJob(r)`. The S1 UI already calls it when present and only toasts otherwise.
- **R8 — feature tab restore** (`index.html`): on load, `selectTab([...built-ins].includes(stored) ? stored : 'audit')` overwrites `maw_tab` before the feature scripts call `addTab`, so a selected feature tab (Checkpoints / Worktrees / any stream's tab) is never restored after a reload. Keep the stored value when it is not a built-in tab.
- **R9 — hook output in the job log**: `Invoke-MawHooks` swallows the strings a hook writes, so `[checkpoint] <id>` never reaches the job log (§1.2). Optionally pass non-Block string output through so the runner logs it.
- **R10 — `MAW_PORT` for isolated jobs**: with R1, the runner should export the worktree's `port` as `MAW_PORT` to the job (the setup script already gets it).
- **R11 — `ctx.callAction(action, { query?, body? })`** in `server/lib/feature.ts` / `http.ts`: lets one feature call another feature's route in-process with the same validation (S1 → S4 `checks_run` / `checks_status` / `checks_gate`). Until it exists, best-of-N reports `tests: unavailable` and the merge skips the S4 gate; S1 never runs `.maw/checks.json` itself.
- **R12 — test isolation**: give every test runner its own `TEMP`/`TMP`, `MAW_HOME` and scripts dir (an S1 test once overwrote the installed `invoke-spec-guard.ps1` through `paths.scriptsDir`; fixed in `1ed73af`). A guard in `resolveServerPaths` that refuses the real install when `NODE_TEST_CONTEXT` is set would stop this class of bug.
