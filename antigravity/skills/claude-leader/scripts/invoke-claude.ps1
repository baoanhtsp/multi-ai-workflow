param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("architect", "frontend", "reviewer", "ui-tweak")]
    [string]$Role,

    [Parameter(Mandatory=$true)]
    [string]$Prompt,

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
            "--no-session-persistence"
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
            "--append-system-prompt", "CRITICAL: Only Read, Edit, and Write tools are enabled. Do NOT use Grep, Glob, or Bash. Work only on the exact file paths specified in the prompt.",
            "--permission-mode", "bypassPermissions",
            "--dangerously-skip-permissions",
            "--no-session-persistence"
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
            "--no-session-persistence"
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
            "--append-system-prompt", "CRITICAL: Only Read, Edit, and Write tools are enabled. Do NOT use Grep, Glob, or Bash. Work only on the exact file paths specified in the prompt.",
            "--permission-mode", "bypassPermissions",
            "--dangerously-skip-permissions",
            "--no-session-persistence"
        )
    }
}

Push-Location $WorkDir
try {
    $allArgs = $commonFlags + $roleFlags
    $Prompt | & $claudeExe @allArgs
} finally {
    Pop-Location
}
