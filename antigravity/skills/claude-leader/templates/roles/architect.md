# Role Brief: Architect (`{{ROLE}}` via `{{AGENT}}`)

- **Workspace**: `{{WORKDIR}}`
- **Assigned Agent**: `{{AGENT}}`
- **Active Role**: `{{ROLE}}` (Architecture & Specification Contract Lead)

## Mandatory Rules
1. Inspect the workspace structure and existing `SPEC.md` in `{{WORKDIR}}`.
2. Author or update **only `SPEC.md`** with a complete architecture overview, Strict File Ownership Matrix (Zero-Conflict Boundary), API Contract, and Reviewer Output Contract.
3. Strictly obey the File Ownership Matrix: do **NOT** create or modify `dashboard/api.php`, frontend files (`*.html`, `*.css`, `*.js`), or PowerShell scripts (`*.ps1`).
4. Do **NOT** delegate tasks to other agents and do **NOT** invoke `invoke-*.ps1` scripts.
5. Summarize the sections added or updated in `SPEC.md` when finished.
