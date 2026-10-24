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
    # For review-diff or -IncludeGitDiff, automatically attach git status & diff (works even when custom $Prompt is provided!)
    if ($IncludeGitDiff -or $Role -eq "review-diff") {
        $hasGit = (Test-Path (Join-Path $WorkDir ".git"))
        if ($hasGit) {
            $gitStatus = (git status -s 2>$null) -join "`n"
            if ($CommitSha) {
                $gitDiff = (git show $CommitSha 2>$null) -join "`n"
            } elseif ($BaseBranch) {
                $gitDiff = (git diff "$BaseBranch...HEAD" 2>$null) -join "`n"
            } else {
                $gitDiff = (git diff HEAD 2>$null) -join "`n"
                if (-not $gitDiff) {
                    $gitDiff = (git diff 2>$null) -join "`n"
                }
            }
            $diffSection = "## Git Status`n``````text`n$gitStatus`n```````n`n## Git Diff`n``````diff`n$gitDiff`n``````"
            if ($Prompt) {
                $Prompt = "$Prompt`n`n$diffSection"
            } else {
                $Prompt = "Review the following changes for security flaws, race conditions, logic bugs, and adherence to SPEC.md. Provide a score X/10 and verdict (APPROVED or CHANGES_REQUESTED).`n`n$diffSection"
            }
        } elseif (-not $Prompt) {
            $Prompt = "Inspect the project files in $WorkDir against SPEC.md for security flaws, logic bugs, and edge cases. Provide a score X/10 and verdict (APPROVED or CHANGES_REQUESTED)."
        }
    }

    if (-not $Prompt -or -not $Prompt.Trim()) {
        $Prompt = "Inspect the project in $WorkDir and complete the requested $Role task."
    }

    # Build codex exec --json arguments (unified across review-diff, critic, and coder so custom prompts,
    # non-git directories, model/effort overrides, and real-time JSONL streaming work 100% reliably!)
    $argsList = @(
        "exec",
        "--ephemeral",
        "--json",
        "--skip-git-repo-check",
        "-C", $WorkDir
    )

    if ($Role -in @("review-diff", "critic")) {
        $argsList += @("-s", "read-only")
    } else {
        $argsList += "--dangerously-bypass-approvals-and-sandbox"
        if ($UseWorktree -and (Test-Path (Join-Path $WorkDir ".git"))) {
            $argsList += "--worktree"
        }
    }

    if ($ModelOverride) {
        $argsList += @("-m", $ModelOverride)
    }
    if ($EffortOverride) {
        # No embedded quotes needed: TOML parser falls back to literal string if unquoted
        $argsList += @("-c", "model_reasoning_effort=$EffortOverride")
    }

    $effectiveModel  = if ($ModelOverride) { $ModelOverride } else { "gpt-6-sol" }
    $effectiveEffort = if ($EffortOverride) { $EffortOverride } else { "high" }
    Write-Output "[$(Get-Date -Format 'HH:mm:ss')] Invoking OpenAI Codex (Role: $Role | Model: $effectiveModel | Effort: $effectiveEffort | WorkDir: $WorkDir)..."

    $capturedText  = [System.Collections.Generic.List[string]]::new()
    $realInTokens  = 0
    $realOutTokens = 0

    $Prompt | & $codexExe @argsList - 2>&1 | ForEach-Object {
        $rawLine = $_.ToString()
        if (-not $rawLine.Trim().StartsWith("{")) {
            # Filter out benign startup log lines if any
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
                    }
                    $estCost = [Math]::Round(($realInTokens * 2.5 + $realOutTokens * 10.0) / 1000000.0, 5)
                    Write-Output "`n[Completed | Tokens: $realInTokens in / $realOutTokens out | Cost: `$$estCost]"
                }
            }
        } catch {
            Write-Output $rawLine
        }
    }

    try {
        $auditFile = Join-Path $env:USERPROFILE ".gemini\antigravity\multi-ai-audit.jsonl"
        $auditDir = Split-Path -Parent $auditFile
        if (-not (Test-Path $auditDir)) {
            New-Item -ItemType Directory -Path $auditDir -Force | Out-Null
        }
        $fullOut = ($capturedText -join "`n")
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
        if ($realInTokens -le 0)  { $realInTokens  = [Math]::Max(1, [int][Math]::Ceiling($Prompt.Length / 3.8)) }
        if ($realOutTokens -le 0) { $realOutTokens = [Math]::Max(1, [int][Math]::Ceiling($fullOut.Length / 3.8)) }
        $costUsd = [Math]::Round(($realInTokens * 2.5 + $realOutTokens * 10.0) / 1000000.0, 5)
        [ordered]@{
            Timestamp    = (Get-Date).ToString("o")
            Tool         = "codex"
            Role         = $Role
            Model        = $effectiveModel
            Effort       = $effectiveEffort
            WorkDir      = $WorkDir
            PromptChars  = $Prompt.Length
            OutputChars  = $fullOut.Length
            InputTokens  = $realInTokens
            OutputTokens = $realOutTokens
            CostUsd      = $costUsd
            Score        = $score
            Verdict      = $verdict
        } | ConvertTo-Json -Compress | Add-Content -Path $auditFile -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
} finally {
    Pop-Location
}
