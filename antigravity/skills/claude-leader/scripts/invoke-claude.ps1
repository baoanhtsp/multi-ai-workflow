param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("architect", "leader", "backend", "frontend", "reviewer", "ui-tweak")]
    [string]$Role,

    [Parameter(Mandatory=$false)]
    [string]$Prompt = "",

    [string]$PromptFile = "",

    [switch]$IncludeGitDiff,

    [switch]$ContinueSession,

    [string]$WorkDir = (Get-Location).Path,

    [string]$ModelOverride = "",

    [string]$EffortOverride = "",

    [string]$ResumeId = "",

    [string]$Account = ""
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot "lib\maw-common.ps1")

$effAccInput = if ($Account -and $Account.Trim()) {
    $Account.Trim()
} elseif ($env:MAW_ACCOUNT -and $env:MAW_ACCOUNT.Trim()) {
    $env:MAW_ACCOUNT.Trim()
} else {
    ""
}
$accRes = Resolve-MawAccountEnv -AgentId "claude" -AccountId $effAccInput -Adapter "claude"
if (-not $accRes.Ok) {
    Write-Output $accRes.Error
    exit 1
}

# Auto-sync Antigravity CSRF token & LS address to bridge file for 2-way communication
if ($env:ANTIGRAVITY_CSRF_TOKEN -and $env:ANTIGRAVITY_LS_ADDRESS) {
    $bridgeFile = Join-Path $env:USERPROFILE ".gemini\antigravity\agentapi-bridge.json"
    $bridgeDir = Split-Path -Parent $bridgeFile
    if (-not (Test-Path -LiteralPath $bridgeDir)) {
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
    if (-not (Test-Path -LiteralPath $PromptFile)) {
        Write-Error "PromptFile not found: $PromptFile"
        exit 1
    }
    $fileContent = Get-Content -LiteralPath $PromptFile -Raw -Encoding UTF8
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
    if (Test-Path -LiteralPath $claudeBase) {
        $latestExe = Get-ChildItem -LiteralPath $claudeBase -Filter "claude.exe" -Recurse -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1
        if ($latestExe) {
            $claudeExe = $latestExe.FullName
        }
    }
}

if (-not $claudeExe -or -not (Test-Path -LiteralPath $claudeExe)) {
    Write-Error "Could not locate claude.exe in PATH or $env:APPDATA\Claude\claude-code"
    exit 1
}

# 2. Configure Token-Optimal Flags per Role with Real-Time stream-json Output
$commonFlags = @(
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--exclude-dynamic-system-prompt-sections"
)

$sessionFlags = if ($ResumeId) {
    @("--resume", $ResumeId)
} elseif ($ContinueSession) {
    @("--continue")
} elseif ($Role -ne "reviewer" -and $env:MAW_PERSIST_SESSION -eq "1") {
    @()
} else {
    @("--no-session-persistence")
}

switch ($Role) {
    "architect" {
        $model  = if ($ModelOverride) { $ModelOverride } else { "opus" }
        $effort = if ($EffortOverride) { $EffortOverride } else { "high" }
        $roleFlags = @(
            "--model", $model,
            "--effort", $effort,
            "--tools", "Read,Edit,Write",
            "--add-dir", $WorkDir,
            "--append-system-prompt", "CRITICAL: Only Read, Edit, and Write tools are enabled. Do NOT use Grep, Glob, or Bash. Use the provided workspace snapshot to read key config files and write/update SPEC.md directly.",
            "--permission-mode", "bypassPermissions",
            "--dangerously-skip-permissions"
        ) + $sessionFlags
    }
    "leader" {
        $model  = if ($ModelOverride) { $ModelOverride } else { "opus" }
        $effort = if ($EffortOverride) { $EffortOverride } else { "high" }
        $roleFlags = @(
            "--model", $model,
            "--effort", $effort,
            "--tools", "Read,Edit,Write,Bash",
            "--add-dir", $WorkDir,
            "--append-system-prompt", "CRITICAL: You are the Multi-AI Team Leader. Use Read, Edit, Write, and Bash to lock SPEC.md, delegate tasks via invoke-agent.ps1, run invoke-spec-guard.ps1, and verify results.",
            "--permission-mode", "bypassPermissions",
            "--dangerously-skip-permissions"
        ) + $sessionFlags
    }
    "backend" {
        $model  = if ($ModelOverride) { $ModelOverride } else { "sonnet" }
        $effort = if ($EffortOverride) { $EffortOverride } else { "medium" }
        $roleFlags = @(
            "--model", $model,
            "--effort", $effort,
            "--tools", "Read,Edit,Write,Bash",
            "--add-dir", $WorkDir,
            "--append-system-prompt", "CRITICAL: Read SPEC.md first and strictly obey its File Ownership Matrix. Do NOT edit SPEC.md or frontend UI files.",
            "--permission-mode", "bypassPermissions",
            "--dangerously-skip-permissions"
        ) + $sessionFlags
    }
    "frontend" {
        $model  = if ($ModelOverride) { $ModelOverride } else { "sonnet" }
        $effort = if ($EffortOverride) { $EffortOverride } else { "medium" }
        $roleFlags = @(
            "--model", $model,
            "--effort", $effort,
            "--tools", "Read,Edit,Write",
            "--add-dir", $WorkDir,
            "--append-system-prompt", "CRITICAL: Only Read, Edit, and Write tools are enabled. Do NOT use Grep, Glob, or Bash. Work only on the exact file paths specified in the prompt.",
            "--permission-mode", "bypassPermissions",
            "--dangerously-skip-permissions"
        ) + $sessionFlags
    }
    "reviewer" {
        $model  = if ($ModelOverride) { $ModelOverride } else { "sonnet" }
        $effort = if ($EffortOverride) { $EffortOverride } else { "medium" }
        $roleFlags = @(
            "--model", $model,
            "--effort", $effort,
            "--tools", "Read",
            "--add-dir", $WorkDir,
            "--append-system-prompt", "CRITICAL: Do NOT use Grep, Glob, Bash, Edit, or Write. Grade and review directly using the code/diff provided in the prompt. Finish with exact two lines: SCORE: X/10 and VERDICT: APPROVED or VERDICT: CHANGES_REQUESTED.",
            "--permission-mode", "bypassPermissions",
            "--dangerously-skip-permissions"
        ) + $sessionFlags
    }
    "ui-tweak" {
        $model  = if ($ModelOverride) { $ModelOverride } else { "haiku" }
        $effort = if ($EffortOverride) { $EffortOverride } else { "low" }
        $roleFlags = @(
            "--model", $model,
            "--effort", $effort,
            "--tools", "Read,Edit,Write",
            "--add-dir", $WorkDir,
            "--append-system-prompt", "CRITICAL: Only Read, Edit, and Write tools are enabled. Do NOT use Grep, Glob, or Bash. Work only on the exact file paths specified in the prompt.",
            "--permission-mode", "bypassPermissions",
            "--dangerously-skip-permissions"
        ) + $sessionFlags
    }
}

Push-Location $WorkDir
try {
    if ($Role -in @("architect", "leader", "backend", "frontend") -and (Test-Path -LiteralPath $WorkDir)) {
        $topItems = @(Get-ChildItem -LiteralPath $WorkDir -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -notin @('.git', 'node_modules', 'vendor', '.idea', '.vscode') } |
            ForEach-Object { if ($_.PSIsContainer) { "$($_.Name)/" } else { $_.Name } })
        if ($topItems.Count -gt 0) {
            $snapshot = "[Workspace Root ($WorkDir) Files]: " + ($topItems -join ", ")
            $Prompt = "$snapshot`n`n$Prompt"
        }
    }

    if ($IncludeGitDiff) {
        $gitStatus = (Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $WorkDir, "-c", "core.quotepath=false", "status", "-s")).StdOut.TrimEnd("`r", "`n")
        $gitDiff = Get-ReviewDiff -WorkDir $WorkDir
        $diffSection = "## Git Status`n``````text`n$gitStatus`n```````n`n## Git Diff`n``````diff`n$gitDiff`n``````"
        if ($Prompt) {
            $Prompt = "$Prompt`n`n$diffSection"
        } else {
            $Prompt = $diffSection
        }
    }

    if ($Role -eq "reviewer") {
        $Prompt = Add-ReviewerContract -Prompt $Prompt
    }

    if (-not $Prompt -or -not $Prompt.Trim()) {
        Write-Error "Prompt cannot be empty. Provide -Prompt, -PromptFile, or -IncludeGitDiff."
        exit 1
    }

    $allArgs = $commonFlags + $roleFlags
    $capturedText = [System.Collections.Generic.List[string]]::new()
    $resolvedModel = $model
    $realInTokens  = 0
    $realOutTokens = 0
    $realCostUsd   = 0.0
    $emittedSessionId = $false

    $prevClaudeConfigDir = $env:CLAUDE_CONFIG_DIR
    $prevMawAccount      = $env:MAW_ACCOUNT
    if ($accRes.Env.ContainsKey("CLAUDE_CONFIG_DIR")) {
        $env:CLAUDE_CONFIG_DIR = [string]$accRes.Env["CLAUDE_CONFIG_DIR"]
    }
    $env:MAW_ACCOUNT = $accRes.AccountId
    try {
        $Prompt | & $claudeExe @allArgs 2>&1 | ForEach-Object {
        $rawLine = $_.ToString()
        if (-not $rawLine.Trim().StartsWith("{")) {
            Write-Output $rawLine
            return
        }
        try {
            $ev = $rawLine | ConvertFrom-Json -ErrorAction Stop
            if (-not $emittedSessionId -and $null -ne $ev.session_id -and ([string]$ev.session_id).Trim()) {
                Write-Output ((@{ type = "session"; session_id = ([string]$ev.session_id).Trim() }) | ConvertTo-Json -Compress)
                $emittedSessionId = $true
            }
            switch ($ev.type) {
                "system" {
                    if ($ev.subtype -eq "init") {
                        if ($ev.model) { $resolvedModel = [string]$ev.model }
                        Write-Output "[Connected] Model: $resolvedModel | Role: $Role | Effort: $effort"
                    }
                }
                "assistant" {
                    if ($ev.message -and $ev.message.content) {
                        foreach ($block in $ev.message.content) {
                            if ($block.type -eq "tool_use") {
                                $tName = $block.name
                                $tTarget = if ($block.input.file_path) { $block.input.file_path } elseif ($block.input.path) { $block.input.path } elseif ($block.input.command) { $block.input.command } else { "" }
                                Write-Output "[Action] $tName $tTarget"
                            } elseif ($block.type -eq "text" -and $block.text) {
                                $capturedText.Add([string]$block.text)
                                Write-Output $block.text
                            }
                        }
                    }
                }
                "result" {
                    if ($null -ne $ev.total_cost_usd) {
                        $realCostUsd = [Math]::Round([double]$ev.total_cost_usd, 5)
                    }
                    if ($ev.usage) {
                        $realInTokens  = [int]($ev.usage.input_tokens + $ev.usage.cache_read_input_tokens + $ev.usage.cache_creation_input_tokens)
                        $realOutTokens = [int]$ev.usage.output_tokens
                    }
                    if ($capturedText.Count -eq 0 -and $ev.result) {
                        $capturedText.Add([string]$ev.result)
                        Write-Output $ev.result
                    }
                    $durSec = if ($ev.duration_ms) { [Math]::Round($ev.duration_ms / 1000.0, 1) } else { 0 }
                    Write-Output "`n[Completed in ${durSec}s | Tokens: $realInTokens in / $realOutTokens out | Actual Cost: `$$realCostUsd]"
                }
            }
        } catch {
            Write-Output $rawLine
        }
    }
    } finally {
        if ($null -eq $prevClaudeConfigDir) { Remove-Item Env:\CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue } else { $env:CLAUDE_CONFIG_DIR = $prevClaudeConfigDir }
        if ($null -eq $prevMawAccount)      { Remove-Item Env:\MAW_ACCOUNT       -ErrorAction SilentlyContinue } else { $env:MAW_ACCOUNT       = $prevMawAccount }
    }

    try {
        $fullOut = ($capturedText -join "`n")
        $vr = Get-ReviewVerdict -Text $fullOut
        $effectiveRole = if ($env:MAW_ROLE) { $env:MAW_ROLE } else { $Role }
        $verdict = if ($effectiveRole -eq "reviewer" -or $Role -eq "reviewer") {
            $vr.Verdict
        } elseif ($vr.Verdict -ne "UNKNOWN") {
            $vr.Verdict
        } else {
            "COMPLETED"
        }
        $score = $vr.Score
        if ($realInTokens -le 0)  { $realInTokens  = [Math]::Max(1, [int][Math]::Ceiling($Prompt.Length / 3.8)) }
        if ($realOutTokens -le 0) { $realOutTokens = [Math]::Max(1, [int][Math]::Ceiling($fullOut.Length / 3.8)) }
        if ($realCostUsd -le 0) {
            $realCostUsd = Get-MawTokenCostUsd -Model $resolvedModel -Tool "claude" -InputTokens $realInTokens -OutputTokens $realOutTokens
        }
        $auditEntry = [ordered]@{
            Timestamp    = (Get-Date).ToString("o")
            Tool         = "claude"
            Account      = $accRes.AccountId
            Role         = $effectiveRole
            Model        = $resolvedModel
            Effort       = $effort
            WorkDir      = $WorkDir
            PromptChars  = $Prompt.Length
            OutputChars  = $fullOut.Length
            InputTokens  = $realInTokens
            OutputTokens = $realOutTokens
            CostUsd      = $realCostUsd
            Score        = $score
            Verdict      = $verdict
        }
        if ($env:MAW_AGENT) {
            $auditEntry["Agent"] = $env:MAW_AGENT
        }
        Write-MawAuditEntry -Entry $auditEntry | Out-Null
    } catch {}
} finally {
    Pop-Location
}
