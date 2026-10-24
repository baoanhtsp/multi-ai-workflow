param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("review-diff", "critic", "coder")]
    [string]$Role,

    [string]$Prompt = "",

    [string]$PromptFile = "",

    [switch]$IncludeGitDiff,

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

# Auto-sync Antigravity CSRF token & LS address to bridge file for 2-way communication
if ($env:ANTIGRAVITY_CSRF_TOKEN -and $env:ANTIGRAVITY_LS_ADDRESS) {
    $bridgeFile = Join-Path $env:USERPROFILE ".gemini\antigravity\agentapi-bridge.json"
    $bridgeDir = Split-Path -Parent $bridgeFile
    if (-not (Test-Path $bridgeDir)) {
        New-Item -ItemType Directory -Path $bridgeDir -Force | Out-Null
    }
    @{
        ANTIGRAVITY_AGENT        = $env:ANTIGRAVITY_AGENT
        ANTIGRAVITY_AGENTAPI_EXE = $env:ANTIGRAVITY_AGENTAPI_EXE
        ANTIGRAVITY_APP_DATA_DIR = $env:ANTIGRAVITY_APP_DATA_DIR
        ANTIGRAVITY_CSRF_TOKEN   = $env:ANTIGRAVITY_CSRF_TOKEN
        ANTIGRAVITY_LS_ADDRESS   = $env:ANTIGRAVITY_LS_ADDRESS
        ANTIGRAVITY_LS_VERSION   = $env:ANTIGRAVITY_LS_VERSION
        UpdatedAt                = (Get-Date).ToString("o")
    } | ConvertTo-Json | Set-Content -Path $bridgeFile -Encoding UTF8 -ErrorAction SilentlyContinue
}

if ($PromptFile) {
    if (-not (Test-Path $PromptFile)) {
        Write-Error "PromptFile not found: $PromptFile"
        exit 1
    }
    $fileContent = Get-Content -Path $PromptFile -Raw -Encoding UTF8
    if ($Prompt) {
        $Prompt = "$Prompt`n`n$fileContent"
    } else {
        $Prompt = $fileContent
    }
}

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
    if ($IncludeGitDiff) {
        $gitStatus = (git status -s 2>$null) -join "`n"
        $gitDiff = (git diff HEAD 2>$null) -join "`n"
        if (-not $gitDiff) {
            $gitDiff = (git diff 2>$null) -join "`n"
        }
        $diffSection = "## Git Status`n``````text`n$gitStatus`n```````n`n## Git Diff`n``````diff`n$gitDiff`n``````"
        if ($Prompt) {
            $Prompt = "$Prompt`n`n$diffSection"
        } else {
            $Prompt = $diffSection
        }
    }

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
