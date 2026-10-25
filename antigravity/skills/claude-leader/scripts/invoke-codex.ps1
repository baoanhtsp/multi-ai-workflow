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

    [ValidateSet("", "low", "medium", "high", "xhigh")]
    [string]$EffortOverride = "",

    [string]$ResumeId = "",

    [switch]$UseWorktree
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot "lib\maw-common.ps1")

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

$codexCmd = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codexCmd) {
    $npmCodex = Join-Path $env:APPDATA "npm\codex.ps1"
    if (Test-Path -LiteralPath $npmCodex) {
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
    if ($IncludeGitDiff -or $Role -eq "review-diff") {
        $hasGit = (Test-Path -LiteralPath (Join-Path $WorkDir ".git"))
        if ($hasGit) {
            $gitStatus = (Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $WorkDir, "-c", "core.quotepath=false", "status", "-s")).StdOut.TrimEnd("`r", "`n")
            $gitDiff   = Get-ReviewDiff -WorkDir $WorkDir -CommitSha $CommitSha -BaseBranch $BaseBranch
            $diffSection = "## Git Status`n``````text`n$gitStatus`n```````n`n## Git Diff`n``````diff`n$gitDiff`n``````"
            if ($Prompt) {
                $Prompt = "$Prompt`n`n$diffSection"
            } else {
                $Prompt = "Review the following changes for security flaws, race conditions, logic bugs, and adherence to SPEC.md.`n`n$diffSection"
            }
        } elseif (-not $Prompt) {
            $Prompt = "Inspect the project files in $WorkDir against SPEC.md for security flaws, logic bugs, and edge cases."
        }
    }

    if (-not $Prompt -or -not $Prompt.Trim()) {
        $Prompt = "Inspect the project in $WorkDir and complete the requested $Role task."
    }

    if ($Role -in @("review-diff", "critic")) {
        $Prompt = Add-ReviewerContract -Prompt $Prompt
    }

    if ($ResumeId) {
        $argsList = @(
            "exec",
            "resume",
            $ResumeId,
            "--json",
            "--skip-git-repo-check",
            "-C", $WorkDir
        )
    } else {
        $argsList = @("exec")
        if ($Role -in @("review-diff", "critic") -or $env:MAW_PERSIST_SESSION -ne "1") {
            $argsList += "--ephemeral"
        }
        $argsList += @(
            "--json",
            "--skip-git-repo-check",
            "-C", $WorkDir
        )
    }

    if ($Role -in @("review-diff", "critic")) {
        $argsList += @("-s", "read-only")
    } else {
        $argsList += "--dangerously-bypass-approvals-and-sandbox"
        if ($UseWorktree -and (Test-Path -LiteralPath (Join-Path $WorkDir ".git"))) {
            $argsList += "--worktree"
        }
    }

    if ($ModelOverride) {
        $argsList += @("-m", $ModelOverride)
    }
    if ($EffortOverride) {
        $argsList += @("-c", "model_reasoning_effort=$EffortOverride")
    }

    $effectiveModel  = if ($ModelOverride) { $ModelOverride } else { "gpt-6-sol" }
    $effectiveEffort = if ($EffortOverride) { $EffortOverride } else { "high" }
    Write-Output "[$(Get-Date -Format 'HH:mm:ss')] Invoking OpenAI Codex (Role: $Role | Model: $effectiveModel | Effort: $effectiveEffort | WorkDir: $WorkDir)..."

    $capturedText       = [System.Collections.Generic.List[string]]::new()
    $realInTokens       = 0
    $realCachedInTokens = 0
    $realOutTokens      = 0

    $Prompt | & $codexExe @argsList - 2>&1 | ForEach-Object {
        $rawLine = $_.ToString()
        if (-not $rawLine.Trim().StartsWith("{")) {
            if ($rawLine -notmatch 'codex_core::') {
                Write-Output $rawLine
            }
            return
        }
        try {
            $ev = $rawLine | ConvertFrom-Json -ErrorAction Stop
            switch ($ev.type) {
                "thread.started" {
                    Write-Output "[Connected] OpenAI Codex Thread: $($ev.thread_id) | Model: $effectiveModel"
                }
                "item.started" {
                    if ($ev.item -and $ev.item.type -eq "command_execution" -and $ev.item.command) {
                        Write-Output "[Action] Running: $($ev.item.command)"
                    }
                }
                "item.completed" {
                    if ($ev.item) {
                        if ($ev.item.type -eq "agent_message" -and $ev.item.text) {
                            $capturedText.Add([string]$ev.item.text)
                            Write-Output $ev.item.text
                        } elseif ($ev.item.type -eq "command_execution" -and $ev.item.command) {
                            Write-Output "[Done] $($ev.item.command) (exit: $($ev.item.exit_code))"
                        }
                    }
                }
                "turn.completed" {
                    if ($ev.usage) {
                        $realInTokens  = [int]$ev.usage.input_tokens
                        $realOutTokens = [int]$ev.usage.output_tokens
                        $realCachedInTokens = if ($null -ne $ev.usage.cached_input_tokens) {
                            [int]$ev.usage.cached_input_tokens
                        } elseif ($ev.usage.input_tokens_details -and $null -ne $ev.usage.input_tokens_details.cached_tokens) {
                            [int]$ev.usage.input_tokens_details.cached_tokens
                        } else {
                            0
                        }
                    }
                    $estCost = Get-MawTokenCostUsd -Model $effectiveModel -Tool "codex" -InputTokens $realInTokens -CachedInputTokens $realCachedInTokens -OutputTokens $realOutTokens
                    Write-Output "`n[Completed | Tokens: $realInTokens in ($realCachedInTokens cached) / $realOutTokens out | Cost: `$$estCost]"
                }
            }
        } catch {
            Write-Output $rawLine
        }
    }

    try {
        $fullOut = ($capturedText -join "`n")
        $vr = Get-ReviewVerdict -Text $fullOut
        $effectiveRole = if ($env:MAW_ROLE) { $env:MAW_ROLE } else { $Role }
        $verdict = if ($Role -in @("review-diff", "critic") -or $effectiveRole -eq "reviewer") {
            $vr.Verdict
        } elseif ($vr.Verdict -ne "UNKNOWN") {
            $vr.Verdict
        } else {
            "COMPLETED"
        }
        $score = $vr.Score
        if ($realInTokens -le 0)  { $realInTokens  = [Math]::Max(1, [int][Math]::Ceiling($Prompt.Length / 3.8)) }
        if ($realOutTokens -le 0) { $realOutTokens = [Math]::Max(1, [int][Math]::Ceiling($fullOut.Length / 3.8)) }
        $costUsd = Get-MawTokenCostUsd -Model $effectiveModel -Tool "codex" -InputTokens $realInTokens -CachedInputTokens $realCachedInTokens -OutputTokens $realOutTokens
        $auditEntry = [ordered]@{
            Timestamp         = (Get-Date).ToString("o")
            Tool              = "codex"
            Role              = $effectiveRole
            Model             = $effectiveModel
            Effort            = $effectiveEffort
            WorkDir           = $WorkDir
            PromptChars       = $Prompt.Length
            OutputChars       = $fullOut.Length
            InputTokens       = $realInTokens
            CachedInputTokens = $realCachedInTokens
            OutputTokens      = $realOutTokens
            CostUsd           = $costUsd
            Score             = $score
            Verdict           = $verdict
        }
        if ($env:MAW_AGENT) {
            $auditEntry["Agent"] = $env:MAW_AGENT
        }
        Write-MawAuditEntry -Entry $auditEntry | Out-Null
    } catch {}
} finally {
    Pop-Location
}
