# S4 — Cost & quality: detailed design

Stream lead: Claude (design, frontend, review). Backend: the S4 Antigravity conversation.
Items, in build order: **B5** budgets → **B2 + V6** fallback routing and auto-recovery → **B8** test gate + Checks panel → **N3** scoreboard + `suggest_team` → **N6** policies per role.

## 0. Ground rules and shared building blocks

### 0.1 Owned paths
| Layer | Paths | Owner |
| :--- | :--- | :--- |
| Server features | `server/features/{budget,fallback,checks,scoreboard,policy}/**` (each with its own `index.ts`, helpers and `tests/`) | Antigravity |
| Script hooks | `antigravity/skills/claude-leader/scripts/hooks/<event>/40-s4-<event>.ps1` | Antigravity |
| UI | `dashboard/feat-{budget,checks,scoreboard,policy}.{js,css}` | Claude |
| Design | `specs/s4-*.md` | Claude |

Nothing else is edited. Shared-file needs are listed in §7 "Requests to Tech Lead".

### 0.2 One engine, thin hooks
- All decision logic is TypeScript, so one implementation serves the server, the hooks and the tests.
- Shared S4 code lives in `server/features/policy/lib/` (`s4-core.ts`: config IO, audit reading, spend, redaction, pattern matching, log classifiers). The other four features import it with relative `.ts` imports. Every S4 feature is S4-owned, so cross-imports inside S4 are allowed. S4 never imports another stream's feature.
- **Hook CLI**: `node server/features/policy/hook-cli.ts <event>`.
  - It reads the hook context as JSON on **stdin** and writes exactly one JSON line to stdout: `{ "block": bool, "reason": string, "lines": string[] }`.
  - Exit code is always 0. A crash is reported as `{ "block": false, "reason": "", "lines": ["[S4] hook error: …"] }` (**fail-open**, see 0.4).
- Each `40-s4-<event>.ps1` hook:
  1. builds a hashtable from `$Context`, adds the `MAW_*` env values it needs and serialises it with `ConvertTo-Json -Compress`;
  2. runs `& $node @($cli, '<event>')` with the JSON piped to stdin (argument array, no string command);
  3. writes `lines` with `Write-Host` so they reach the job log (`*>&1`);
  4. returns `@{ Block = $true; Reason = $reason }` when `block` is true.
- **Locating node and the CLI**: the dashboard scripts usually run from the *installed* copy (`~/.gemini/config/skills/claude-leader/scripts`), not from the repo. So the server writes `$MAW_HOME/data/policy/runtime.json` = `{ "repo_root", "node": process.execPath, "port", "pid", "written_at" }` when the policy feature loads and again on every `status` call.
  - The hook reads `$env:MAW_S4_RUNTIME`, else `$env:MAW_HOME\data\policy\runtime.json`, else `~\.maw\data\policy\runtime.json`.
  - If that file is missing, or node / the CLI does not exist, the hook does nothing (prints one `[S4] runtime not found` line).

### 0.3 Data folders (`$MAW_HOME/data/<feature>/`, each feature only writes its own)
| Feature | Files |
| :--- | :--- |
| `budget` | `budgets.json` (config), `ledger.jsonl` (one line per finished job), `audit.jsonl` (S4 admin actions) |
| `fallback` | `routing.json` (config), `recovery.json` (recovery items, newest 500), `cooldowns.json` (agent → until) |
| `checks` | `trusted.json` (sha256 of every trusted `.maw/checks.json`), `results/<sha1(project_path)>.json` (last run), `audit.jsonl` |
| `scoreboard` | `cache.json` (aggregates + signature) |
| `policy` | `policies.json` (config), `violations.jsonl`, `approvals.json`, `runtime.json`, `audit.jsonl` |

- Writes are atomic: write `<file>.tmp`, then rename.
- JSONL appends use `fs.appendFileSync` and one line per record.
- Every config file is validated on read. An invalid file falls back to the defaults and gives a warning in `feature_data.<name>.warnings[]`; it never crashes the server.
- Every "admin" POST (save config, override, approve, cancel, trust) appends `{ ts, action, by: "dashboard", details }` to that feature's `audit.jsonl`. This is the S4 audit line; S4 never writes into `multi-ai-audit.jsonl`, which counts agent calls only.

### 0.4 Failure policy
- Budget, cooldown and policy checks **fail open**: an S4 bug or missing runtime must never stop the user's agents. The failure is logged in the job log and in `feature_data.policy.warnings`.
- The test gate **fails closed**: a check that cannot run counts as red, with the reason. The user can override it explicitly.

### 0.5 Context that reaches the hooks today (F0)
| Event | `$Context` keys | Notes |
| :--- | :--- | :--- |
| `job-start` | `job_id, mode, agent, role, project, exit_code` | runs inside the job runner process |
| `before-agent` | `agent, role, workdir, model, effort` | runs inside `invoke-agent.ps1`, which is a child of the runner |
| `before-review` | `workdir, project, implementer, reviewers, round, max_rounds` | runs inside `invoke-auto-gate.ps1` |
| `job-finish` | as `job-start` plus `exit_code` | runs inside the runner |

`before-agent` gets neither the job id nor the prompt. So the `job-start` hook (same process as the runner) sets process env vars, which every child inherits:
- `MAW_JOB_ID` = the job id;
- `MAW_JOB_MODE` = the job mode;
- `MAW_JOB_ROLE` = the job role;
- `MAW_JOB_PROJECT` = the job project;
- `MAW_S4_AUDIT_OFFSET` = the current byte size of `multi-ai-audit.jsonl`;
- `MAW_TEAM_RUN_ID`, only when it is not set already (S6 may set it), = the recovery chain root (§2.4) or else the job id.

The job prompt file is `<jobsDir>\<job_id>.prompt.txt` (`jobsDir` = `$env:TEMP\maw_jobs`), so hooks can read and rewrite it before the agent starts. Calls made outside a dashboard job (CLI usage of `invoke-agent.ps1`) have no `MAW_JOB_ID`; then only the day / project / agent caps and the role policy apply.

### 0.6 Common log classifiers (`s4-core.ts`, unit-tested)
`classifyFailure(logTail: string, exitCode: number)` returns one of:
- `{ kind: 'blocked', by: 's4'|'other', reason, suggested? }`
  - Source: a `HOOK_BLOCKED (before-agent): …` line, or exit 5.
  - S4's own reasons carry a machine tag `[S4:<code> agent=<id> fallback=<id|none>]`. `<code>` is one of `budget`, `cooldown`, `policy`, `approval`.
  - Another hook's block (for example S3 health, `30-*`) is `by: 'other'` and is treated as "agent unhealthy".
- `{ kind: 'usage_limit', reset_at: ISO|null, raw }`
  - Patterns (case-insensitive): `usage limit`, `limit reached`, `quota exceeded`, `exceeded your current quota`, `you've hit your limit`, `out of credits`, `insufficient_quota`, `RESOURCE_EXHAUSTED`.
  - Reset parsing, tried in this order:
    1. ISO timestamp;
    2. `resets? (at)? 14:05` / `3pm` / `3:00 PM` (local time; if that time has already passed, use tomorrow);
    3. `(try again|retry|resets?) in 2h 13m` / `in 45 minutes` / `in 30s`;
    4. `retry-after: 120`;
    5. epoch seconds after `reset`.
  - No reset time found ⇒ treated as `transient` with the longest backoff step.
- `{ kind: 'transient', code: '429'|'529'|'503'|'overloaded'|'rate_limit'|'network' }`
  - Patterns: `\b429\b`, `\b529\b`, `\b503\b`, `overloaded`, `Too Many Requests`, `rate.?limit`, `ECONNRESET`, `ETIMEDOUT`, `socket hang up`, `temporarily unavailable`.
  - A transient match is only counted in the **last 40 lines** of the log, so a successful job that mentions `429` in its source diff is not retried.
- `{ kind: 'auth' }`: S3's V7 territory. Patterns `OAuth session expired`, `Please set an Auth method`, `\b401\b`, `not logged in`. S4 neither retries nor falls back on it; it leaves it to S3 and only counts it as a failure in the scoreboard.
- `{ kind: 'timeout' }`: exit 124.
- `{ kind: 'other' }`.

Order matters: blocked → usage_limit → auth → transient → timeout → other.

---

## 1. B5 — Budgets (`server/features/budget/`)

### 1.1 Config `budgets.json`
```jsonc
{
  "version": 1,
  "enabled": true,
  "caps": {
    "job":      { "usd": { "warn": 1.0,  "block": 2.0 },  "tokens": { "warn": 0, "block": 0 } },
    "team_run": { "usd": { "warn": 3.0,  "block": 5.0 } },
    "day":      { "usd": { "warn": 10.0, "block": 20.0 }, "tokens": { "warn": 0, "block": 4000000 } },
    "project":  { "usd": { "warn": 0,    "block": 0 }, "period": "month" },   // "day" | "week" | "month" | "all"
    "agent_day": { "usd": { "warn": 0,   "block": 0 } }                       // per agent per day, makes fallback meaningful
  },
  "projects": {                                    // per-project overrides (key = normalised absolute path, lower-case)
    "c:\\laragon\\www\\shop": { "project": { "usd": { "warn": 20, "block": 30 }, "period": "month" } }
  },
  "estimate_next_call": true                       // add the agent's average cost per call before comparing with block
}
```
- `0` means "no cap". Each threshold is a number ≥ 0 with at most 4 decimals; `warn` must be ≤ `block` when both are > 0.
- Tokens = `in_tokens + out_tokens`.
- Missing scopes use these defaults: everything is 0 (off), except `day.usd = { warn: 10, block: 0 }`.

### 1.2 Where the spend comes from
- Rows come from `multi-ai-audit.jsonl` (`paths.auditFile`). Cost and tokens come from `estimateEntryTelemetry()` in `server/lib/audit.ts` (import only, no edit), so the numbers match the dashboard stats.
  - **day**: rows whose `Timestamp` falls on the current **local** calendar day.
  - **project**: rows whose `WorkDir` is the project path or inside it (case-insensitive, normalised `\`), within `period`. A worktree under `<project>\.claude\worktrees\…` counts for its project, and so does any path that starts with the project path.
  - **agent_day**: day rows where `Agent` (else `Tool`) equals the agent.
  - **job**:
    - while the job runs: rows after byte `MAW_S4_AUDIT_OFFSET` whose `WorkDir` is inside the job's project;
    - once it has finished: the ledger line.
    - Two jobs running on the same project at the same time can be mixed up; this is accepted and documented in the UI tooltip.
  - **team_run**: ledger lines with the same `team_run_id`, plus the current job's running spend.
- **Ledger** (`ledger.jsonl`), written by the server (`syncLedger`) for every finished job not yet in it. It runs on `status`, `budget_spend` and the scoreboard, and is idempotent by `job_id`. A line looks like:
  ```jsonc
  { "job_id", "team_run_id", "mode", "agent", "role", "team", "implementer", "reviewers", "project_path",
    "status", "exit_code", "started_at", "finished_at", "duration_s",
    "calls", "in_tokens", "out_tokens", "cost_usd",
    "review": { "verdict": "APPROVED|CHANGES_REQUESTED|UNKNOWN|null", "score": 8.7|null, "rounds": 2|null },
    "failure": { "kind": "transient|usage_limit|blocked|auth|timeout|other" } | null,
    "recovery_of": "<job id>|null" }
  ```
  - Cost: audit rows with `Timestamp` in `[started_at − 5 s, finished_at + 5 s]` and `WorkDir` inside the project.
  - `review`:
    1. Use `meta.review` when S5 stored one (`{ verdict, score }`).
    2. Else parse the log: the last `=== COUNCIL_RESULT a=APPROVED|9.0 b=… ===` line (verdict = all approved and minimum score ≥ 8.5 ⇒ APPROVED; the minimum score is used); or the last reviewer `VERDICT: X` / `Score: n/10` pair; `rounds` = the highest `[Round n /` seen.
  - The server must sync *before* jobs are cleaned up (2 h), so `syncLedger` also runs on a 60 s timer once the feature has a ctx (§2.5).

### 1.3 Enforcement (`before-agent`, CLI `before-agent`)
1. For each enabled scope, compute `spent`. If `estimate_next_call` is on, compute `est` = the mean cost of the last 20 audit rows of this agent (fallback $0.02).
2. If `spent + est ≥ block` (USD), or `spent ≥ block` (tokens) ⇒ **block**. The reason is
   `Budget <scope> exceeded: $<spent> of $<block> [S4:budget agent=<id> fallback=<id|none>]`.
   - `fallback` is filled only for the `agent_day` scope; other scopes are not fixed by switching agent.
3. Else, if `spent ≥ warn` ⇒ no block. Print the line `[S4] budget warning: <scope> $<spent> / warn $<warn>` and add an attention item `budget_warn` (deduplicated per scope per day).
4. Every block adds an attention item `budget_block` (§6).

### 1.4 Actions
| Action | Method | Request | Response |
| :--- | :--- | :--- | :--- |
| `budget_get` | GET | – | `{ ok, config, defaults, warnings[] }` |
| `budget_save` | POST | `{ config }` (full object, validated) | `{ ok, config }`. `400` with a field path on invalid input |
| `budget_spend` | GET | `?project_path=&days=14` | `{ ok, today: { usd, tokens, calls, cap: {warn, block}, tokens_cap }, project: { path, period, usd, tokens, cap }, by_day: [{ date: "YYYY-MM-DD", usd, tokens, calls }] (oldest→newest, `days` 1..90), by_agent_today: [{ agent, usd, calls, cap }], running_jobs: [{ job_id, usd, cap }], recent_blocks: [attention items] }` |

`status` → `feature_data.budget = { enabled, today_usd, today_cap_usd, today_warn_usd, level: "ok"|"warn"|"block", warnings[] }` (cheap: cached by audit mtime + size).

---

## 2. B2 + V6 — Fallback routing and auto-recovery (`server/features/fallback/`)

### 2.1 Config `routing.json`
```jsonc
{
  "version": 1,
  "roles": {
    "backend":  { "fallbacks": ["antigravity", "codex", "gemini"], "auto_fallback": false },
    "frontend": { "fallbacks": ["claude", "cursor"], "auto_fallback": false },
    "reviewer": { "fallbacks": ["codex", "claude", "gemini"], "auto_fallback": true }
    // architect | leader | tester likewise; missing role = no fallback
  },
  "recovery": {
    "enabled": true,
    "backoff_s": [30, 60, 120, 300, 900, 1800],   // one step per attempt; the last step repeats; each 5..86400
    "max_attempts": 6,                           // 0..20
    "wait_for_reset": true,                      // usage limit with a reset time ⇒ wait until the reset, then continue
    "reset_grace_s": 60,                         // added after the parsed reset time
    "max_wait_s": 21600,                         // a reset further away than this ⇒ inbox instead of waiting
    "prefer_fallback_on_limit": false            // usage limit + auto_fallback ⇒ switch agent now instead of waiting
  }
}
```
- Fallback ids must be enabled registry ids. Unknown ids are dropped with a warning.
- Every listed id must be distinct.

### 2.2 Choosing the fallback
`pickFallback(role, blockedAgent, ctx)` walks `roles[role].fallbacks` in order and skips:
- the blocked agent itself;
- agents that are disabled or not `installed` (`detectRegistryAgents` result, cached);
- agents in `cooldowns.json` whose `until` is in the future;
- agents whose `agent_day` cap is already at `block`;
- for reviewers, agents without `capabilities.review`; for write roles (`backend`, `frontend`, `tester`), agents without `capabilities.write`.

It returns `{ agent, skipped: [{ agent, why }] }` or `null`.

### 2.3 Cooldowns (rate-limit tracking)
- Each `usage_limit` result sets `cooldowns[agent] = { until: reset_at ?? now + last backoff step, reason, source_job_id }`.
- Each `transient` 429 / 529 result sets a short cooldown: `now + backoff_s[attempt]`.
- `before-agent` (CLI) blocks an agent that is cooling down. The reason is `<label> is rate-limited until 14:05 [S4:cooldown agent=<id> fallback=<pick|none>]`.
- `fallback_cooldown_clear { agent }` (POST) clears it ("I re-logged in / topped up").

### 2.4 Recovery engine
It runs in the server and needs no change to the runner.
- **Trigger**: `scanFinishedJobs()` runs every 5 s once a ctx has been seen, and also on every `status` / `recovery_list` call.
  - For each job with `status ∈ {FAILED}` and `exit_code ≠ 0` (never `CANCELLED`), finished less than 30 min ago and not seen yet, it reads the last 64 KB of the log and calls `classifyFailure`.
  - `seen` is stored in `recovery.json` as `processed_jobs` (bounded at the newest 1000).
- **Decision**:
  | Kind | Auto action (when allowed) | Otherwise |
  | :--- | :--- | :--- |
  | `blocked` by `budget` (not agent_day), `policy` | none | attention item, no retry |
  | `blocked` by `approval` | none, waits for `policy_approve` (§5.5) | attention item with "Approve" |
  | `blocked` by `cooldown` / `budget agent_day` / other hook (unhealthy) | `auto_fallback[role]` and a fallback exists ⇒ **re-run with the fallback agent** | attention item `fallback_suggest` with "Run with <fallback>" |
  | `usage_limit` + reset ≤ `max_wait_s` | `wait_for_reset` ⇒ item `waiting`, `next_at = reset + grace`, then re-run the same body (or switch now if `prefer_fallback_on_limit` and auto-fallback) | attention item |
  | `transient` | `recovery.enabled` and `attempt < max_attempts` ⇒ item `waiting`, `next_at = now + backoff_s[attempt]`, then re-run the same body | attention item `recovery_gave_up` |
  | `auth`, `timeout`, `other` | none (S3 handles auth) | nothing from S4 |
- **Rebuilding the request**: `rebuildRunBody(meta, promptFile)` returns `{ mode, agent?, role, project_path, prompt, team?, reviewers?, implementer?, model?, effort?, new_session? }` from the job meta.
  - The prompt is the job prompt file with the BOM removed and any S4 policy block (between `<!-- MAW-S4-POLICY:BEGIN -->` and `<!-- MAW-S4-POLICY:END -->`) removed. The block is added again at the next `job-start`.
  - **Agent replacement** for a fallback, `replaceAgent(body, from, to)`:
    - `task` / direct modes: replace `agent`;
    - `team`: every `team[role] == from`;
    - `auto-gate`: `implementer`, and any entry of `reviewers`;
    - `council`: entries of `reviewers` (duplicates are removed).
    - Model / effort overrides are **dropped** when the agent changes; `new_session` is kept only if the new agent supports it.
  - The new job starts through `ctx.startJob(body)`. It inherits the same validation and errors; a start error marks the item `failed` with the message.
- **Recovery item** (`recovery.json.items[]`):
  ```jsonc
  { "id": "rec_<ts>_<hex>", "root_job_id", "source_job_id", "kind": "fallback|transient|usage_limit",
    "agent", "role", "fallback_agent": null, "attempt": 1, "status": "waiting|started|done|cancelled|failed|gave_up|suggested",
    "next_at": "ISO|null", "reason", "created_at", "new_job_id": null, "error": null }
  ```
  - The chain: `root_job_id` is carried over, so a third retry still points at the first job.
  - `attempt` counts per chain.
  - The re-run job's id is stored as `new_job_id`. The ledger line of the new job gets `recovery_of` and the same `team_run_id` (looked up from the recovery items).
  - `MAW_TEAM_RUN_ID` for re-runs: the engine writes `new_job_id` into the item right after `ctx.startJob` returns. The `job-start` CLI looks in `recovery.json` for an item whose `new_job_id` is this job (retry 5 × 300 ms for the race), uses that item's `root_job_id`, and otherwise falls back to the job id. The ledger sync applies the same lookup, so the ledger is right even if the hook lost the race.
- **Timers**: one `setInterval` per server process, created lazily when a feature handler / status first gets a ctx (`ensureEngine(ctx)`), `unref()`-ed. Due items (`next_at ≤ now`, `status = waiting`) are started one at a time, at most 3 per tick.
- **Server restart**: items survive in `recovery.json`, and the timer resumes on the first status call.

### 2.5 Actions
| Action | Method | Request | Response |
| :--- | :--- | :--- | :--- |
| `fallback_get` | GET | – | `{ ok, config, roles: ["architect","leader","backend","frontend","reviewer","tester"], agents: [{ id, label, installed, cooldown_until }], warnings[] }` |
| `fallback_save` | POST | `{ config }` | `{ ok, config }` |
| `fallback_suggest` | GET | `?role=&agent=` | `{ ok, suggestion: { agent, skipped[] } \| null }` |
| `recovery_list` | GET | `?job_id=` (optional; matches `source_job_id`, `root_job_id` or `new_job_id`) | `{ ok, items: [newest first, max 100], cooldowns: { agent: { until, reason } } }` |
| `recovery_cancel` | POST | `{ id }` | `{ ok, item }`. Only `waiting` / `suggested` items |
| `recovery_apply` | POST | `{ id, agent? }` | `{ ok, item, job_id }`. Run a `suggested` / `waiting` item **now** (optionally with another agent) |
| `fallback_cooldown_clear` | POST | `{ agent }` | `{ ok }` |

`status` → `feature_data.fallback = { waiting: [{ id, source_job_id, next_at, kind, agent }], cooldowns: { agent: until }, auto_roles: ["reviewer"] }`.

The UI shows **"Đang chờ hồi phục (đến 14:05)"** in the job header from `waiting` (job action, §6.2).

---

## 3. B8 — Test gate + Checks panel (`server/features/checks/`)

### 3.1 Project config `<project>/.maw/checks.json`
```jsonc
{
  "version": 1,
  "checks": [
    { "id": "typecheck", "label": "npm run typecheck", "command": ["npm", "run", "typecheck"], "timeout_s": 300, "required": true },
    { "id": "test",      "label": "npm test",          "command": ["npm", "test"],              "timeout_s": 900, "required": true },
    { "id": "phpunit",   "label": "phpunit",           "command": ["vendor/bin/phpunit"],       "timeout_s": 900, "required": false, "cwd": "." }
  ],
  "todo_patterns": ["TODO", "FIXME", "XXX", "HACK"],   // default
  "todo_max": 0,                                       // -1 = report only; n ≥ 0 = red when more than n
  "require_clean_git": false,
  "min_review_score": 8.5,                             // 0 = ignore the review score
  "spec_guard": true
}
```
- Validation:
  - `id` matches `^[a-z][a-z0-9_-]{0,31}$` and is unique; at most 20 checks;
  - `command` is a non-empty array of at most 64 strings, each ≤ 1000 chars, with no NUL;
  - `timeout_s` is 5..3600 (default 600);
  - `cwd` is relative and must stay inside the project.
- **Trust**: the file comes from the repo, so a changed file (by sha256) must be trusted once in the UI (`checks_trust`) before it runs. An untrusted config ⇒ checks state `untrusted` (red, "Trust this config"). Saving through the UI (`checks_save`) trusts automatically.
- **No config file**: S4 proposes defaults (`checks_detect`) from `package.json` scripts (`typecheck`, `lint`, `test`), `composer.json` / `vendor/bin/phpunit`, `pytest.ini` / `pyproject.toml`, `Cargo.toml`, `go.mod`. They are never run until the user saves them.

### 3.2 Running a check (no shell, ever)
- Resolve `command[0]`:
  - an absolute or relative path with an extension ⇒ use it;
  - else search `PATH` × `PATHEXT` (`.COM;.EXE;.BAT;.CMD`).
- `.exe` / `.com` ⇒ `spawn(file, args, { shell: false, windowsHide: true, cwd })`.
- `.cmd` / `.bat` (npm, npx, pnpm, yarn are `.cmd` on Windows). Node refuses to spawn these without a shell, so:
  1. **npm / npx / pnpm / yarn shims**: resolve the JS entry and run `process.execPath <entry> …args`. For npm: `<dir of npm.cmd>\node_modules\npm\bin\npm-cli.js`; for npx: `npx-cli.js`. pnpm and yarn the same way when found.
  2. Other `.cmd` / `.bat` files: run `cmd.exe /d /s /c <file> <args…>` **only if** every argument matches `^[A-Za-z0-9_\-.:/\\=@+,]*$`. Otherwise the check is red with "unsafe argument for a .cmd script".
- `.ps1` ⇒ `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <file> <args…>`.
- Timeout ⇒ kill the process tree (`taskkill.exe /PID <pid> /T /F`, argument array) and mark the check `timeout`.
- Output: keep the last 64 KB of stdout + stderr per check, redacted (§5.4).
- One run per project at a time: a second `checks_run` while one is running returns `409 { error: "Checks are already running for this project." }`.

### 3.3 Gate items and the gate verdict
`computeGate(project_path)` returns `{ green: bool, items: [...] }`, where each item is `{ id, label, state: "pass"|"fail"|"warn"|"skip"|"running"|"untrusted", detail, at }`:
| Item | Pass when | Fail when |
| :--- | :--- | :--- |
| `git` | `git status --porcelain` is empty | dirty and `require_clean_git` (else `warn` with the count). Not a git repo ⇒ `skip` |
| each check `<id>` | exit 0 in the last run, and that run happened at the **current `HEAD` + current dirty-file signature** | exit ≠ 0, timeout, cannot start. A result from older code ⇒ `stale`; never run ⇒ `pending`. For a `required` check both count as **not green** (a gate is only green when every required check passed on the current code). A `required: false` failure / stale / pending ⇒ `warn` |
| `spec_guard` | SPEC Guard verdict ok (reuse `server/actions/specGuard.ts` `handleSpecGuard` with `owner: ""`; never edit it) | violations. No `SPEC.md` ⇒ `skip` |
| `review` | the last reviewer score for this project (ledger `review`, else the last audit reviewer row with `WorkDir` inside the project) ≥ `min_review_score` and verdict APPROVED | below the threshold / CHANGES_REQUESTED. No review yet ⇒ `warn` |
| `todo` | count of `todo_patterns` matches (word boundary) in **tracked** text files (`git ls-files`, skip files > 512 KB and binaries, max 5000 files) ≤ `todo_max` | above it. `todo_max = -1` ⇒ `warn`/`pass`, report only. Shows the top 20 `file:line` |

`green` = no item is in `fail` / `timeout` / `untrusted` / `running`, and no required check is `stale` / `pending`. Item states: `pass | fail | warn | skip | running | untrusted | timeout | stale | pending`.

### 3.4 Enforcement
- **Auto-Gate**: the `before-review` hook (CLI `before-review`) runs the configured checks **synchronously** in `workdir` (same runner code, same timeouts), saves the result and blocks the review when the gate is not green. The reason is `Test gate red: test (exit 1), todo (3 > 0) [S4:gate]`.
  - No `.maw/checks.json` ⇒ no block (prints `[S4] no checks configured`).
  - SPEC Guard is already run by Auto-Gate itself, so the hook skips the `spec_guard` item.
  - It also skips `review`, because the review has not happened yet in that round.
- **S1 merge / S6 handoff merge** call `checks_gate`:
  - if `green: false` and the request has no `override: true`, they must refuse;
  - an override requires a UI confirmation and is recorded with `checks_override` (audit line).

### 3.5 Actions
| Action | Method | Request | Response |
| :--- | :--- | :--- | :--- |
| `checks_config` | GET | `?project_path=` | `{ ok, exists, config, trusted, sha256, detected: {config}\|null, warnings[] }` |
| `checks_save` | POST | `{ project_path, config }` | `{ ok, config, sha256 }`. Writes `<project>/.maw/checks.json` (creates `.maw/`), trusts it, audit line |
| `checks_trust` | POST | `{ project_path, sha256 }` | `{ ok }`. The sha must match the current file, audit line |
| `checks_run` | POST | `{ project_path, ids? }` | `202`-style `{ ok, run_id, started_at }`; runs in the background |
| `checks_status` | GET | `?project_path=&refresh=0\|1` | `{ ok, project_path, branch, head, running, run_id, gate: { green, items[] }, results: [{ id, label, state, exit_code, duration_ms, output_tail, at, head }] }`. `refresh=1` recomputes git / todo / spec / review (checks are never re-run by a GET) |
| `checks_gate` | GET | `?project_path=` | `{ ok, green, items[] }`, used by S1 / S6 |
| `checks_override` | POST | `{ project_path, reason, scope: "merge"\|"review" }` | `{ ok, token, expires_at }` (15 min). S1 passes `override_token`; a valid token makes `checks_gate` return `green: true, overridden: true` once |
| `checks_cancel` | POST | `{ project_path }` | `{ ok }`. Kills the running checks |

`status` → `feature_data.checks = { running: [project_path], last: { "<project_path>": { green, at } } }`, limited to the 20 most recent projects.

---

## 4. N3 — Agent scoreboard + `suggest_team` (`server/features/scoreboard/`)

### 4.1 Aggregation (agent × role)
- **Sources**:
  - the **ledger** (§1.2), one line per job;
  - the **audit** rows (per call: agent, role, verdict, score, cost).
- Window: `?days=30` (1..365, default 30).
- Attribution of a job:
  - `task` ⇒ (`agent`, `role`);
  - `auto-gate` ⇒ (`implementer`, `backend`) is the implementer row, and each reviewer gets (`reviewer`, `reviewer`) rows from the audit;
  - `team` ⇒ (`team.<role>`, role) for each member, from the audit rows of that job window (Agent + Role);
  - `council` ⇒ reviewer rows only.
- **Metrics per (agent, role)**:
  | Metric | Definition |
  | :--- | :--- |
  | `tasks` | number of jobs attributed (implementer side), or calls for reviewers |
  | `reviewed` | jobs with a `review.verdict` |
  | `approval_rate` | approved / reviewed (null when reviewed = 0) |
  | `avg_score` | mean `review.score` of reviewed jobs (null when none) |
  | `avg_fix_rounds` | mean `review.rounds − 1` for auto-gate jobs (null when none) |
  | `cost_usd` | total |
  | `cost_per_approved_usd` | cost_usd / approved (null when approved = 0) |
  | `median_duration_s` | median of `duration_s` |
  | `failure_rate` | (jobs with exit ≠ 0, excluding cancelled and S4 budget / policy blocks) / tasks |
  | `last_at` | most recent job / call |
  - For a reviewer row: `tasks` = review calls, `approval_rate` = share of APPROVED verdicts given, `avg_score` = mean score given. The UI labels these "given".
- Cached in `cache.json` by (ledger size + audit size + mtime + days).

### 4.2 `suggest_team`
- Request: `GET ?project_path=&roles=backend,frontend,reviewer&days=30`.
- For each role, the candidates are enabled + installed registry agents with the capability the role needs (`review` for reviewer, `write` for backend / frontend / tester; any agent for architect / leader), not cooling down.
- **Score** (0..1) = `0.45·approval_rate + 0.25·(avg_score/10) + 0.15·(1 − failure_rate) + 0.15·speed`
  - `speed` = 1 − (median / max median among candidates).
  - Missing metrics take neutral values: 0.5 for rates and speed, 0.75 for the score.
  - `confidence` = min(1, tasks / 5).
  - final = `confidence·score + (1−confidence)·0.5`.
  - Ties (|Δ| < 0.02) go to the lower `cost_per_approved_usd` (null = mean cost per task), then to the registry default team, then to the id.
- No data at all ⇒ the registry `defaults.team[role]` (or `defaults.implementer`), with `reason: "no history, registry default"`.
- Response:
  ```jsonc
  { "ok": true, "team": { "backend": "codex", "frontend": "claude", "reviewer": "gemini" },
    "details": { "backend": { "agent": "codex", "score": 0.81, "confidence": 1, "reason": "approval 92% · avg 9.1 · $0.42/approved",
                              "candidates": [{ "agent", "score", "tasks", "approval_rate", "avg_score", "cost_per_approved_usd" }] } },
    "days": 30 }
  ```

### 4.3 Actions
| Action | Method | Request | Response |
| :--- | :--- | :--- | :--- |
| `scoreboard` | GET | `?days=30&role=&project_path=` (filters optional) | `{ ok, days, rows: [{ agent, label, color, role, ...metrics }], totals: { jobs, cost_usd, approved }, generated_at }` |
| `suggest_team` | GET | as above | as above |

`status` → `feature_data.scoreboard = { top: { role: agent } }`, the best agent per role over 30 days (from the cache, no recompute while the cache is valid).

---

## 5. N6 — Policies per role (`server/features/policy/`)

### 5.1 Config `policies.json`
```jsonc
{
  "version": 1,
  "enabled": true,
  "global": {
    "protected_paths": [".env", ".env.*", "**/*.pem", "**/*.key", ".git/**", "**/id_rsa*"],   // glob, relative to the workdir
    "deny_commands":   ["git push --force", "git push -f", "git reset --hard origin", "rm -rf /", "format c:"],
    "approve_commands": ["rm -rf", "Remove-Item -Recurse -Force", "git push --force", "git push -f", "DROP TABLE", "DROP DATABASE", "TRUNCATE TABLE"],
    "allow_commands":  [],
    "redact_secrets": true,
    "secret_patterns": [],           // extra regex sources, each validated with new RegExp
    "redact_env_files": true         // values of .env* files in the workdir are redacted too
  },
  "roles": {
    "reviewer": { "read_only": true, "deny_commands": ["git commit", "git push"] },
    "tester":   { "deny_commands": ["git push"] },
    "hacker":   { "deny_commands": ["git push", "rm -rf"] }    // any role / S6 profile key ^[a-z][a-z0-9-]{1,31}$
  },
  "sandbox": { "enabled": false }    // documentation + request to Tech Lead (§5.6); no effect today
}
```
- **Applied rule set** = `global` + `roles[<role>]` + `roles[<MAW_ROLE_PROFILE>]` (env set by S6 for its role profiles, when present).
- Lists are concatenated; booleans in a role override global ones.
- **Command pattern semantics** (`matchCommand(text, pattern)`, case-insensitive):
  - plain pattern = its whitespace-separated tokens appear **in this order** on one line, with anything between them. So `git push --force` matches `git push origin main --force`.
  - `re:<regex>` = a regex (validated; an invalid one is dropped with a warning).
  - A line that matches an `allow_commands` pattern is never flagged.
- **Protected path globs**:
  - `*` = within one path segment, `**` = any depth, `?` = one char;
  - matched against `/`-normalised paths relative to the workdir, case-insensitive;
  - a pattern without `/` matches the basename at any depth.

### 5.2 Enforcement points
1. **Brief** (`job-start` CLI)
   - Prepends the rule block to the job prompt file:
     ```
     <!-- MAW-S4-POLICY:BEGIN -->
     ## Policy for role <role> (enforced by Mission Control)
     - Never modify: <protected paths>
     - Never run: <deny commands>
     - Ask for approval before running: <approve commands> (stop and explain instead)
     - Read-only role: do not write files.          (only if read_only)
     - Never print secrets, tokens or .env values.
     <!-- MAW-S4-POLICY:END -->
     ```
     It is idempotent: an existing block is replaced. A file that would grow beyond 20000 chars only gets the short form "protected paths + deny" (the SPEC prompt limit).
   - Redacts secrets in the prompt file (§5.4). The file keeps its UTF-8 BOM.
2. **`before-agent`** (CLI)
   - It reads the job prompt (`MAW_JOB_ID`); without a job id there is no prompt check.
   - **block** when the prompt asks the agent to run a `deny_commands` match:
     `Policy: role <role> may not run "git push --force" [S4:policy agent=<id> fallback=none]`.
   - **needs approval** when it matches `approve_commands` and no approval exists:
     - It creates a pending approval `{ id: "apr_<hex>", job_id, role, agent, project, command, prompt_sha256, created_at, status: "pending" }`.
     - It blocks with `Approval needed: "rm -rf" for role <role> — approve in the dashboard (apr_xxx) [S4:approval agent=<id> fallback=none]`.
     - An approval matches by `prompt_sha256 + role` (the prompt is hashed without the policy block), so the re-run after approval passes. Approvals are single-use and expire after 24 h.
   - **read_only** roles: no block here (the post-hoc scan flags writes).
3. **Post-hoc scan** (`job-finish` CLI, and again server-side in `syncLedger` when the hook did not run)
   - **Log scan**: lines of the job log matching `deny_commands` / `approve_commands` (not `allow`). These are heuristic hits ("the log mentions …"), severity `warn`.
   - **Diff scan**: `git status --porcelain` in the project. Changed files matching `protected_paths` ⇒ severity `high`. A `read_only` role with any change ⇒ `high`.
     - Changes that already existed before the job are excluded. The `job-start` CLI stores the porcelain snapshot in `$MAW_HOME/data/policy/snapshots/<job_id>.txt` (deleted after the scan).
   - **Redaction**: rewrites the job log in place with secrets redacted, before the runner appends `JOB_FINISHED` and sends the notification. The live stream may already have shown the text; see Requests §7.
   - Each finding ⇒ one `violations.jsonl` line `{ id, ts, job_id, project, agent, role, kind: "protected_path|deny_command|approve_command|read_only_write|secret", severity: "high|warn", detail, file?, line? }`, plus an attention item for `high`.
   - The CLI prints `[S4] policy: <n> violation(s)` into the log.
4. **Review**: the `before-review` CLI blocks the review round when an unresolved `high` violation exists for this workdir since the round started:
   `Policy violation: modified protected path .env [S4:policy]`. `policy_resolve { id }` (with a UI confirmation) clears it.

### 5.3 Approvals
Approving does not start anything by itself. `policy_approve { id, rerun: true }` marks it approved and, when `rerun`, re-runs the blocked job through the recovery machinery (a recovery item of kind `approval`, started immediately).

### 5.4 Secret redaction (`redactSecrets(text, extraValues[])` in `s4-core.ts`)
- Built-in patterns, each replaced with `[REDACTED:<kind>]`:

  | Kind | Pattern |
  | :--- | :--- |
  | `anthropic` | `sk-ant-[A-Za-z0-9_\-]{20,}` |
  | `openai` | `sk-(proj-)?[A-Za-z0-9_\-]{20,}` |
  | `github` | `gh[pousr]_[A-Za-z0-9]{36,}`, `github_pat_[A-Za-z0-9_]{50,}` |
  | `aws` | `AKIA[0-9A-Z]{16}` |
  | `google` | `AIza[0-9A-Za-z_\-]{35}` |
  | `slack` | `xox[baprs]-[A-Za-z0-9-]{10,}` |
  | `telegram` | `\b\d{8,10}:[A-Za-z0-9_\-]{35}\b` |
  | `jwt` | `eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+` |
  | `private_key` | `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----` |
  | `assignment` | `(?i)(api[_-]?key\|secret\|token\|password\|passwd)\s*[:=]\s*["']?([^\s"']{8,})`, which keeps the key name and redacts only the value |
- `extraValues`: the values (≥ 8 chars) of `KEY=VALUE` lines in `.env`, `.env.*` in the workdir (when `redact_env_files`), plus `secret_patterns`. Values are matched literally (escaped).
- It must never touch the S4 policy markers, and redacting twice gives the same result.

### 5.5 Actions
| Action | Method | Request | Response |
| :--- | :--- | :--- | :--- |
| `policy_get` | GET | – | `{ ok, config, defaults, roles_known: [...6 roles + S6 profiles if any], warnings[] }` |
| `policy_save` | POST | `{ config }` | `{ ok, config }` |
| `policy_preview` | POST | `{ role, text? }` | `{ ok, brief, redacted?, matches: { deny: [], approve: [] } }`, a dry run for the UI |
| `policy_violations` | GET | `?project_path=&job_id=&limit=100&include_resolved=0` | `{ ok, items[] }` |
| `policy_resolve` | POST | `{ id, note? }` | `{ ok }`, audit line |
| `policy_approvals` | GET | `?status=pending` | `{ ok, items[] }` |
| `policy_approve` | POST | `{ id, rerun?: true }` | `{ ok, item, job_id? }`, audit line |
| `policy_reject` | POST | `{ id }` | `{ ok }`, audit line |

`status` → `feature_data.policy = { enabled, pending_approvals: n, open_high: n, warnings[], runtime_ok: bool }`.

### 5.6 Platform sandbox flags (documented; applying them needs the Tech Lead, §7)
| Platform | Flag | Effect |
| :--- | :--- | :--- |
| Claude Code | `--disallowedTools "Bash(git push:*)" "Edit(.env)"`, `--permission-mode plan` (reviewer) | per-tool deny rules |
| Codex | `--sandbox read-only` (reviewer) / `workspace-write`, `--ask-for-approval on-request` | OS sandbox |
| Gemini CLI | `--approval-mode plan` (reviewer, already used) / `default` instead of `yolo` for approve-roles, `--sandbox` | approval mode, container sandbox |
| Cursor Agent | no `--force` for read-only roles | approval prompts |
| Aider | `--dry-run` (reviewer, already used) | no writes |
| Antigravity | none (IDE agent); brief + post-hoc scan only | – |

---

## 6. Attention items (S3 inbox contract) and UI

### 6.1 Attention items
S3's inbox API is not defined yet. To stay decoupled, S4 **publishes** its items and S3 **pulls** them.
- `GET s4_attention?since=<ISO>` returns `{ ok, items: [{ id, ts, source: "budget|fallback|checks|policy", kind, severity: "info|warn|error", title, detail, job_id?, project_path?, actions: [{ id, label, action, body }] }] }`.
  - `action` is an S4 POST action name.
  - `body` is the JSON to send, e.g. `{ "action": "recovery_apply", "body": { "id": "rec_…" } }`.
- The items are derived from:
  - budget blocks / warnings;
  - recovery items (`suggested`, `waiting`, `gave_up`, `failed`);
  - pending approvals;
  - open `high` violations;
  - red gates after a `before-review` block.
- `status.feature_data.policy.attention_count` = the number of open items.
- The action lives in the policy feature (it aggregates).
- If S3 later exposes `inbox_add` (an in-process function or HTTP), S4 adds a push. Until then, S3 reads `s4_attention` (note left in the shared notes folder).

### 6.2 Frontend (Claude, `dashboard/feat-*.js`, all through `window.MAW`)
- **`feat-budget.js`** — tab "Chi phí & định tuyến" / "Cost & routing":
  - **Header item**: today's spend `$3.20 / $20` with a small bar (ok / warn / block colours). A click opens the tab.
  - **Spend**: per-day bars (14 days) with a cap line; per-project spend vs cap; by agent today; running jobs.
  - **Budgets form**: every scope with USD / token warn / block; a per-project override for the selected project.
  - **Routing form**: per role, an ordered fallback list (add / remove / ↑↓ from registry agents) plus an "auto fallback" toggle.
  - **Recovery settings**: backoff steps, max attempts, wait for reset, max wait.
  - **Recovery queue**: waiting / suggested items with countdown, "Run now", "Cancel" (confirm); cooldowns with "Clear".
  - **Job header** (`MAW.addJobAction`):
    - when the shown job has a waiting recovery item: label `⏳ Đang chờ hồi phục (đến 14:05)` / `Waiting to recover (until 14:05)`, click ⇒ a small dialog with Run now / Cancel;
    - when a re-run job exists: `↪ Đã chạy lại: job_…`.
- **`feat-checks.js`** — tab "Kiểm tra" / "Checks" for the selected project:
  - gate summary (green / red), item rows (git, each check, SPEC Guard, review, TODO);
  - "Run checks", "Cancel", "Override…" (with a reason and a confirmation);
  - config editor: a list of checks (label, command as tokens, timeout, required), "Detect", "Save", and "Trust" when the config is untrusted;
  - output tail per check (collapsible);
  - **project action** "Run checks".
- **`feat-scoreboard.js`** — tab "Bảng xếp hạng" / "Scoreboard":
  - a sortable table (agent · role · tasks · approval · avg score · fix rounds · $/approved · median time · failure), with role and days filters;
  - a "Suggested team" card from `suggest_team`, with the reason per role.
- **`feat-policy.js`** — tab "Chính sách" / "Policies":
  - an editor for global + per-role rules (chips for paths / commands);
  - a preview of the brief for a role, and a redaction tester;
  - pending approvals (Approve & re-run / Reject, with confirmation);
  - violations (Resolve, with confirmation);
  - the S4 attention list, with counts in the tab badge;
  - the platform sandbox table (read-only doc).

All four are bilingual through `MAW.addI18n` and use the theme CSS variables only, so they work in light, dark and neon. They are mobile-first (tables scroll horizontally inside their card) and have no inline event handlers (CSP-safe, `addEventListener`).

---

## 7. Requests to Tech Lead
1. **`npm test` glob**: add `server/features/*/tests/*.test.ts` to `package.json` `test` (today only `server/tests/*.test.ts`). Pester: add `server/features/*/tests/*.Tests.ps1` to the CI `Invoke-Pester` paths. Until then, run S4's tests with `node --test server/features/*/tests/*.test.ts`.
2. **`before-agent` context** (`invoke-agent.ps1`): add `job_id = $env:MAW_JOB_ID`, `prompt_file` (the file actually used) and `team = $Team`. Also allow a hook result `@{ PrependPrompt = '…' }`, prepended to `$fullPrompt`, so the policy brief also reaches direct CLI calls and every Auto-Gate / Council child.
3. **Fallback suggestion field**: when a `before-agent` hook returns `@{ Block = $true; Reason; Suggest = '<agent>' }`, print `HOOK_BLOCKED_SUGGEST: <agent>` as well. S4 already encodes it in the reason tag, so this is optional.
4. **Live log redaction**: the runner (`jobs.ts`) could pipe each line through a redaction function before `AppendAllText`, or the server could redact in `job_status` / `job_stream`. Today S4 can only redact after the job finishes.
5. **Sandbox flags**: an optional registry field `policy_args: { read_only: [...], approve: [...] }` per agent, which `invoke-agent.ps1` / `invoke-cli-agent.ps1` add when the role policy says so (§5.6 table).
6. **`MAW.followJob(jobId)`** and **`MAW.refreshJobHead()`** in `index.html`.
   - `followJob` lets the job header switch to the automatic re-run job. Until it exists, S4 shows a toast with the new job id.
   - `refreshJobHead` repaints the job actions after S4 learns about a recovery item. Until it exists, `feat-budget.js` calls the global `renderJobHead` when it is there.
7. **`install.ps1`** must copy `scripts/hooks/**` to the installed scripts folder. Otherwise the S4 / S1 / S2 / S3 hooks never run from the dashboard (it prefers the installed scripts). For development, start the server with `MAW_HOOKS_DIR=<worktree>\antigravity\skills\claude-leader\scripts\hooks`.
8. **S3 inbox**: pull `s4_attention` (§6.1), or tell S4 the `inbox_add` contract.
9. **S1 `worktree_merge` / S6 handoff merge**: call `checks_gate` and refuse when `green: false` unless the request carries an `override_token` from `checks_override` (§3.4).
10. **S5**: store the review verdict in the job meta as `review: { verdict, score }`, which the S4 ledger reads.
11. **Job ownership**: `%TEMP%\maw_jobs` is shared by every dashboard process (main server, stream test servers, api-smoke), so a feature cannot tell which server started a job.
    - Request: add `server_id` (for example `pid@port`) and `projects_root` to the job meta.
    - Until then, S4 limits recovery to jobs inside its own projects root and claims each failed job with an exclusive file (`%TEMP%\maw_s4_claims\<job_id>`), so only one process ever retries it.
12. **S1 best-of-N judge**: S1's notes say it reads `.maw/checks.json` itself, as `{ name, command: string|array }`.
    - It must use S4's shape (`id` / `label` / array `command`), and better still call `checks_run` / `checks_status` / `checks_gate`. Running the file directly bypasses S4's sha256 trust check.
    - S1 was told so (message + `s4-contracts.md` in the shared notes).
13. **S3 inbox at merge**: S4's bridge feature-detects `server/features/inbox/store.ts` and uses `addInboxItem(paths, input, { onlyIfAbsent })`, `onInboxResolved(item)` and `updateInboxItemStatus`.
    - If S3 renames any of these, `status.feature_data.policy.inbox_bridge` turns `false`.
    - The test `inbox bridge: integration with real S3 store.ts` covers it once both streams are merged.
