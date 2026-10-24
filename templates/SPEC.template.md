# Project Specification (`SPEC.md`): <Project / Feature Name>

> **Spec-Driven Development (SDD) Contract** — Single Source of Truth for **Antigravity (Gemini 4 Argon)**, **Claude Code (Opus / Sonnet / Haiku)**, and **OpenAI Codex CLI**.
> Keep this document ultra-compact (~100–250 lines) so AI agents never waste tokens scanning the repository.

---

## 1. Architecture & Tech Stack

| Layer | Technology / Choice | Version / Notes |
| :--- | :--- | :--- |
| **Runtime** | `<Node.js / PHP / Python / Go / Rust>` | `<e.g., Node 22 LTS / PHP 8.3>` |
| **Backend Framework** | `<Express / NestJS / Laravel / FastAPI>` | `<REST / GraphQL / RPC>` |
| **Database & ORM** | `<PostgreSQL / MySQL / SQLite + Prisma / Eloquent>` | `<Strict migrations & transactions>` |
| **Frontend & Styling** | `<React / Vue / Blade / Vanilla + Tailwind CSS>` | `100% owned by Claude Sonnet (-Role frontend)` |
| **Testing Framework** | `<Vitest / Jest / PHPUnit / Pytest>` | `<Unit + Integration tests required before review>` |

---

## 2. Database Schema & Data Models

### Table / Collection: `<table_name>`
| Column / Field | Type | Constraints / Indexes | Description |
| :--- | :--- | :--- | :--- |
| `id` | `UUID / BIGINT` | `PK, AUTO_INCREMENT / DEFAULT uuid_generate_v4()` | Primary identifier |
| `<field_name>` | `<VARCHAR(255) / INT / JSONB>` | `NOT NULL, INDEX, UNIQUE` | `<Purpose & validation rules>` |
| `created_at` | `TIMESTAMP` | `NOT NULL, DEFAULT CURRENT_TIMESTAMP` | Creation timestamp |
| `updated_at` | `TIMESTAMP` | `NOT NULL, DEFAULT CURRENT_TIMESTAMP` | Last update timestamp |

* **Foreign Keys & Relations**: `<e.g., user_id REFERENCES users(id) ON DELETE CASCADE>`
* **Concurrency / Locking Notes**: `<e.g., Use SELECT ... FOR UPDATE on balance/inventory mutations>`

---

## 3. API Contract

### `3.1. <Endpoint Name>`
- **Method & Path**: `<POST / GET / PUT / DELETE> /api/v1/<resource>`
- **Auth / Middleware**: `<Bearer JWT / Session / Public / Rate-Limited>`
- **Request Payload / Query Params**:
  ```json
  {
    "field_one": "string (required, max 120 chars)",
    "field_two": 42
  }
  ```
- **Success Response (`200 OK` / `201 Created`)**:
  ```json
  {
    "status": "success",
    "data": {
      "id": "uuid-or-int",
      "field_one": "string",
      "created_at": "2026-01-01T00:00:00Z"
    }
  }
  ```
- **Error Codes**:
  - `400 Bad Request`: Validation failed (`{ "status": "error", "code": "VALIDATION_ERROR", "errors": {} }`)
  - `401 Unauthorized` / `403 Forbidden`: Missing or insufficient permissions
  - `404 Not Found`: Target resource does not exist
  - `409 Conflict` / `422 Unprocessable Entity`: Business rule or state conflict

---

## 4. Strict File Ownership Matrix (Zero-Conflict Boundary)

> **CRITICAL RULE**: No agent or subagent may create, edit, or format files outside its assigned `Allowed File Paths`. In Multi-AI Team Mode (`/claude-leader`), Antigravity is strictly forbidden from touching Frontend files.

| Module / Layer | Owner AI | Branch / Worktree | Allowed File Paths (Strict) | Forbidden Files |
| :--- | :--- | :--- | :--- | :--- |
| **Architecture & Spec** | **Claude Opus** (`-Role architect`) + **Antigravity** | `main` / `master` | `SPEC.md` | All source code files (`--tools ""`) |
| **100% Frontend UI** | **Claude Sonnet** (`-Role frontend`) / **Haiku** (`-Role ui-tweak`) | `main` (or `feat/frontend-ui`) | `*.html`, `*.css`, `*.scss`, `*.tsx`, `*.jsx`, `*.vue`, `*.blade.php`, `*.ejs`, `src/components/**`, `src/pages/**`, `resources/views/**` | Backend controllers, DB migrations, API services, test runners |
| **Backend Core / DB** | **Antigravity Subagent 1** | `feat/db-core` | `database/**`, `prisma/**`, `src/models/**`, `src/repositories/**`, `app/Models/**` | All Frontend UI files (`*.html`, `*.css`, `*.tsx`, `*.vue`, `*.blade.php`), API routes |
| **API / Services** | **Antigravity Subagent 2** | `feat/api-services` | `src/controllers/**`, `src/services/**`, `src/routes/**`, `src/middleware/**`, `app/Http/**`, `routes/**` | All Frontend UI files, DB migration files |
| **Automated Tests** | **Antigravity Subagent 3** / **Codex** (`-Role coder`) | `feat/tests` | `tests/**`, `**/*.test.ts`, `**/*.spec.ts`, `phpunit.xml`, `vitest.config.ts` | Production Frontend & Backend source files |

---

## 5. UI Design System Seed (For Claude Frontend)

- **Aesthetic Direction**: `<Modern Minimalist / High-Contrast SaaS / Glassmorphic Dashboard / Editorial>`
- **Color Palette (CSS Variables / Tailwind Tokens)**:
  - Background Primary / Surface: `<#0F172A / #1E293B>` (Dark) or `<#F8FAFC / #FFFFFF>` (Light)
  - Accent Primary / Secondary: `<#6366F1 (Indigo-500) / #10B981 (Emerald-500)>`
  - Semantic Status: Success `#22C55E`, Warning `#F59E0B`, Danger `#EF4444`
- **Typography**:
  - Heading Font: `<Inter / Plus Jakarta Sans / Space Grotesk>`, semi-bold, tight tracking (`-0.02em`)
  - Body / Monospace Font: `<Inter / JetBrains Mono>`, `14px–16px` base, line-height `1.5`
- **Spacing & Layout**: `4px/8px` spatial grid, max container width `1280px`, card border-radius `12px`, subtle `1px` borders
- **Responsive Breakpoints**: Mobile (`< 640px`), Tablet (`640px–1024px`), Desktop (`> 1024px`)
- **Required Component States**:
  - `Loading`: Skeleton shimmer or inline spinner on submit buttons (disable double-click)
  - `Empty State`: Illustration/icon + clear call-to-action message
  - `Error State`: Field-level validation message + accessible toast/banner for API errors
  - `Success State`: Optimistic UI update or confirmation feedback

---

## 6. Acceptance Criteria & Automated Test Checklist

- [ ] **AC-1 (Schema & Migrations)**: All database migrations run cleanly (`up` & `down`) with proper foreign keys and indexes.
- [ ] **AC-2 (API Contract Compliance)**: Every endpoint matches exact status codes, JSON structure, and validation rules in Section 3.
- [ ] **AC-3 (Security & Edge Cases)**: Input sanitization, auth guards, SQLi/XSS prevention, and race-condition locks verified.
- [ ] **AC-4 (Frontend Integration)**: UI consumes exact API payload keys from Section 3 and handles Loading, Empty, Error, and Success states.
- [ ] **AC-5 (Automated Tests Pass)**: 100% of Unit and Integration tests pass prior to invoking Council Review (`invoke-council-review.ps1`).

---

## 7. Bounded Review & Grading Log (Max 2 Rounds)

> Run `invoke-council-review.ps1 -WorkDir "<project_path>"` (or `invoke-claude.ps1 -Role reviewer -IncludeGitDiff` + `invoke-codex.ps1 -Role review-diff`) after automated tests pass. Target score: **>= 8.5/10 (`APPROVED`)**.

| Round | Reviewer (Claude Sonnet / Codex) | Score (X/10) | Verdict (PENDING / CHANGES_REQUESTED / APPROVED) | Key Findings & Fixes |
| :---: | :--- | :---: | :---: | :--- |
| **1** | **Claude Sonnet** (`-Role reviewer`) | `- / 10` | `PENDING` | `<Awaiting initial git diff submission>` |
| **1** | **OpenAI Codex** (`-Role review-diff`) | `- / 10` | `PENDING` | `<Awaiting initial git diff submission>` |
| **2** | **Claude Sonnet** (`-Role reviewer`) | `- / 10` | `PENDING` | `<Populated only if Round 1 requested changes>` |
| **2** | **OpenAI Codex** (`-Role review-diff`) | `- / 10` | `PENDING` | `<Populated only if Round 1 requested changes>` |
