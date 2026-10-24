param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("review-diff", "critic", "coder")]
    [string]$Role,

    [string]$Prompt = "",

    [string]$WorkDir = (Get-Location).Path,

    [string]$CommitSha = "",

    [string]$BaseBranch = "",

    [string]$ModelOverride = "",

    [switch]$UseWorktree
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

$codexCmd = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codexCmd) {
    $npmCodex = Join-Path $env:APPDATA "npm\codex.ps1"
    if (Test-Path $npmCodex) {
        $codexExe = $npmCodex
    } else {
        Write-Error "Could not locate codex CLI in PATH or $env:APPDATA\npm\codex.ps1"
        exit 1
    }
} else {
    $codexExe = $codexCmd.Source
}

Push-Location $WorkDir
try {
    switch ($Role) {
        "review-diff" {
            # Native non-interactive git diff / commit code review
            $argsList = @("review")
            if ($ModelOverride) {
                $argsList += @("-c", "model=`"$ModelOverride`"")
            }
            if ($CommitSha) {
                $argsList += @("--commit", $CommitSha)
            } elseif ($BaseBranch) {
                $argsList += @("--base", $BaseBranch)
            } else {
                $argsList += @("--uncommitted")
            }

            if ($Prompt) {
                $Prompt | & $codexExe @argsList -
            } else {
                & $codexExe @argsList
            }
        }
        "critic" {
            # Ephemeral read-only logic/security/spec reviewer (zero disk bloat)
            $argsList = @(
                "exec",
                "--ephemeral",
                "-s", "read-only",
                "--skip-git-repo-check",
                "-C", $WorkDir
            )
            if ($ModelOverride) {
                $argsList += @("-m", $ModelOverride)
            }
            $Prompt | & $codexExe @argsList -
        }
        "coder" {
            # Non-interactive implementation / test writer (optionally in an isolated git worktree)
            $argsList = @(
                "exec",
                "--ephemeral",
                "--dangerously-bypass-approvals-and-sandbox",
                "-C", $WorkDir
            )
            if ($UseWorktree) {
                $argsList += "--worktree"
            }
            if ($ModelOverride) {
                $argsList += @("-m", $ModelOverride)
            }
            $Prompt | & $codexExe @argsList -
        }
    }
} finally {
    Pop-Location
}
