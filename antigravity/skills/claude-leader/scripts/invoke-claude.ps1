param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("architect", "frontend", "reviewer", "ui-tweak")]
    [string]$Role,

    [Parameter(Mandatory=$false)]
    [string]$Prompt = "",

    [string]$PromptFile = "",

    [switch]$IncludeGitDiff,

    [switch]$ContinueSession,

    [string]$WorkDir = (Get-Location).Path,

    [string]$ModelOverride = "",

    [string]$EffortOverride = ""
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

# 1. Auto-discover latest claude.exe (handles auto-updates seamlessly)
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeCmd) {
    $claudeExe = $claudeCmd.Source
} else {
    $claudeBase = Join-Path $env:APPDATA "Claude\claude-code"
    if (Test-Path $claudeBase) {
        $latestExe = Get-ChildItem -Path $claudeBase -Filter "claude.exe" -Recurse -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($latestExe) {
            $claudeExe = $latestExe.FullName
        }
    }
}

if (-not $claudeExe -or -not (Test-Path $claudeExe)) {
    Write-Error "Could not locate claude.exe in PATH or $env:APPDATA\Claude\claude-code"
    exit 1
}

# 2. Configure Token-Optimal Flags per Role
$commonFlags = @(
    "-p",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--exclude-dynamic-system-prompt-sections"
)

$sessionFlag = if ($ContinueSession) { "--continue" } else { "--no-session-persistence" }

switch ($Role) {
    "architect" {
        # Opus: Pure architecture, API contract, task delegation & UI design system seed (No tool overhead)
        $model  = if ($ModelOverride) { $ModelOverride } else { "opus" }
        $effort = if ($EffortOverride) { $EffortOverride } else { "high" }
        $roleFlags = @(
            "--model", $model,
            "--effort", $effort,
            "--tools", "",
            "--append-system-prompt", "CRITICAL: All tools are disabled in this session to save tokens. Do NOT output <invoke> or attempt to call any tools (no Read, Grep, Glob, Bash). Provide your complete response directly based solely on the user prompt.",
            $sessionFlag
        )
    }
    "frontend" {
        # Sonnet: 100% Frontend implementation with restricted file tools only (no Bash/Grep wandering)
        $model  = if ($ModelOverride) { $ModelOverride } else { "sonnet" }
        $effort = if ($EffortOverride) { $EffortOverride } else { "medium" }
        $roleFlags = @(
            "--model", $model,
            "--effort", $effort,
            "--tools", "Read,Edit,Write",
            "--add-dir", $WorkDir,
            "--append-system-prompt", "CRITICAL: Only Read, Edit, and Write tools are enabled. Do NOT use Grep, Glob, or Bash. Work only on the exact file paths specified in the prompt.",
            "--permission-mode", "bypassPermissions",
            "--dangerously-skip-permissions",
            $sessionFlag
        )
    }
    "reviewer" {
        # Sonnet: Code review & scoring based on pre-collected git diff + test output (No tool overhead)
        $model  = if ($ModelOverride) { $ModelOverride } else { "sonnet" }
        $effort = if ($EffortOverride) { $EffortOverride } else { "medium" }
        $roleFlags = @(
            "--model", $model,
            "--effort", $effort,
            "--tools", "",
            "--append-system-prompt", "CRITICAL: All tools are disabled in this session to save tokens. Do NOT output <invoke> or attempt to call any tools (no Read, Grep, Glob, Bash). Grade and review directly using ONLY the code/diff provided in the prompt.",
            $sessionFlag
        )
    }
    "ui-tweak" {
        # Haiku: Fast, low-cost minor UI adjustments, CSS fixes, or API variable alignment checks
        $model  = if ($ModelOverride) { $ModelOverride } else { "haiku" }
        $effort = if ($EffortOverride) { $EffortOverride } else { "low" }
        $roleFlags = @(
            "--model", $model,
            "--effort", $effort,
            "--tools", "Read,Edit,Write",
            "--add-dir", $WorkDir,
            "--append-system-prompt", "CRITICAL: Only Read, Edit, and Write tools are enabled. Do NOT use Grep, Glob, or Bash. Work only on the exact file paths specified in the prompt.",
            "--permission-mode", "bypassPermissions",
            "--dangerously-skip-permissions",
            $sessionFlag
        )
    }
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

    if (-not $Prompt -or -not $Prompt.Trim()) {
        Write-Error "Prompt cannot be empty. Provide -Prompt, -PromptFile, or -IncludeGitDiff."
        exit 1
    }

    $allArgs = $commonFlags + $roleFlags
    $outputLines = $Prompt | & $claudeExe @allArgs | Tee-Object -Variable capturedOut
    $outputLines

    try {
        $auditFile = Join-Path $env:USERPROFILE ".gemini\antigravity\multi-ai-audit.jsonl"
        $auditDir = Split-Path -Parent $auditFile
        if (-not (Test-Path $auditDir)) {
            New-Item -ItemType Directory -Path $auditDir -Force | Out-Null
        }
        $fullOut = ($capturedOut -join "`n")
        $verdict = if ($fullOut -match '\bCHANGES_REQUESTED\b') {
            "CHANGES_REQUESTED"
        } elseif ($fullOut -match '\bAPPROVED\b') {
            "APPROVED"
        } else {
            "COMPLETED"
        }
        $score = if ($fullOut -match '\b(\d+(?:\.\d+)?\s*/\s*10)\b') {
            $Matches[1]
        } else {
            ""
        }
        [ordered]@{
            Timestamp   = (Get-Date).ToString("o")
            Tool        = "claude"
            Role        = $Role
            Model       = $model
            WorkDir     = $WorkDir
            PromptChars = $Prompt.Length
            Score       = $score
            Verdict     = $verdict
        } | ConvertTo-Json -Compress | Add-Content -Path $auditFile -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
} finally {
    Pop-Location
}
