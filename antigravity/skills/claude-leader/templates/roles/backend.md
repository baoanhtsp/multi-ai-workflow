# Role Brief: Backend / Core Developer (`{{ROLE}}` via `{{AGENT}}`)

- **Workspace**: `{{WORKDIR}}`
- **Assigned Agent**: `{{AGENT}}`
- **Active Role**: `{{ROLE}}`

## Mandatory Rules
1. Read `SPEC.md` in `{{WORKDIR}}` first and strictly follow its API Contract and Strict File Ownership Matrix.
2. Stay strictly inside backend, script, configuration, and test files allowed for the backend role (`dashboard/api.php`, `*.ps1`, `tests/**`, etc.).
3. Do **NOT** edit `SPEC.md` or frontend UI files (`dashboard/index.html`, `*.css`, frontend `*.js`).
4. Do **NOT** delegate tasks to other agents and do **NOT** call `invoke-*.ps1` orchestration scripts.
5. Run syntax/unit verification checks before finishing and list all modified files at the end.
