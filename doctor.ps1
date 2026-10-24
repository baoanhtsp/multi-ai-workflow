param(
    [switch]$ShowRecentLogs
)

$ErrorActionPreference = "Continue"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Multi-AI Coding Workflow - Environment & Health Check" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

# 1. Antigravity IDE & Bridge
Write-Host "`n[1/6] Antigravity IDE & Self-Healing Bridge" -ForegroundColor Yellow
$agentApi = Join-Path $env:USERPROFILE ".gemini\antigravity\bin\agentapi.bat"
if (Test-Path $agentApi) {
    Write-Host "  [OK] agentapi.bat found: $agentApi" -ForegroundColor Green
} else {
    Write-Host "  [WARN] agentapi.bat NOT found at $agentApi" -ForegroundColor Red
}

$lsProc = Get-CimInstance Win32_Process -Filter "Name = 'language_server.exe'" -ErrorAction SilentlyContinue |
    Sort-Object CreationDate -Descending |
    Select-Object -First 1

if ($lsProc) {
    $ports = @(Get-NetTCPConnection -OwningProcess $lsProc.ProcessId -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty LocalPort |
        Sort-Object -Descending -Unique)
    $hasCsrf = [bool]($lsProc.CommandLine -match '--csrf_token\s+([^\s"]+)')
    Write-Host "  [OK] language_server.exe running (PID: $($lsProc.ProcessId), Ports: $($ports -join ', '), CSRF Extracted: $hasCsrf)" -ForegroundColor Green
} else {
    Write-Host "  [WARN] language_server.exe process is not currently running" -ForegroundColor DarkYellow
}

$bridgeFile = Join-Path $env:USERPROFILE ".gemini\antigravity\agentapi-bridge.json"
if (Test-Path $bridgeFile) {
    try {
        $bridgeData = Get-Content -Path $bridgeFile -Raw -Encoding UTF8 | ConvertFrom-Json
        Write-Host "  [OK] Bridge config exists ($bridgeFile) - LS: $($bridgeData.ANTIGRAVITY_LS_ADDRESS), UpdatedAt: $($bridgeData.UpdatedAt)" -ForegroundColor Green
    } catch {
        Write-Host "  [WARN] Bridge config exists but could not be parsed: $bridgeFile" -ForegroundColor DarkYellow
    }
} else {
    Write-Host "  [INFO] Bridge config not yet created at $bridgeFile (will auto-heal on first run)" -ForegroundColor Gray
}

# 2. Claude Code CLI
Write-Host "`n[2/6] Claude Code CLI" -ForegroundColor Yellow
$claudeExe = $null
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

if ($claudeExe -and (Test-Path $claudeExe)) {
    $claudeVer = (& $claudeExe --version 2>$null) -join " "
    Write-Host "  [OK] claude.exe found: $claudeExe ($claudeVer)" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] claude.exe NOT found in PATH or $env:APPDATA\Claude\claude-code" -ForegroundColor Red
}

# 3. OpenAI Codex CLI
Write-Host "`n[3/6] OpenAI Codex CLI" -ForegroundColor Yellow
$codexExe = $null
$codexCmd = Get-Command codex -ErrorAction SilentlyContinue
if ($codexCmd) {
    $codexExe = $codexCmd.Source
} else {
    $npmCodex = Join-Path $env:APPDATA "npm\codex.ps1"
    if (Test-Path $npmCodex) {
        $codexExe = $npmCodex
    }
}

if ($codexExe -and (Test-Path $codexExe)) {
    $codexVer = (& $codexExe --version 2>$null) -join " "
    Write-Host "  [OK] codex CLI found: $codexExe ($codexVer)" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] codex CLI NOT found in PATH or $env:APPDATA\npm\codex.ps1" -ForegroundColor Red
}

# 4. Git & GitHub CLI
Write-Host "`n[4/6] Git & GitHub CLI" -ForegroundColor Yellow
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) {
    $gitVer = (& git --version 2>$null) -join " "
    Write-Host "  [OK] Git found: $gitVer" -ForegroundColor Green
} else {
    Write-Host "  [FAIL] Git NOT found in PATH" -ForegroundColor Red
}

$ghCmd = Get-Command gh -ErrorAction SilentlyContinue
if ($ghCmd) {
    $ghVer = (& gh --version 2>$null | Select-Object -First 1)
    Write-Host "  [OK] GitHub CLI found: $ghVer" -ForegroundColor Green
} else {
    Write-Host "  [INFO] GitHub CLI (gh) not installed (optional)" -ForegroundColor Gray
}

# 5. Global Workflow Files Sync Check
Write-Host "`n[5/6] Global Workflow Files Sync Check" -ForegroundColor Yellow
$expectedFiles = @(
    (Join-Path $env:USERPROFILE ".gemini\config\rules\claude-leader-workflow.md"),
    (Join-Path $env:USERPROFILE ".gemini\config\skills\claude-leader\SKILL.md"),
    (Join-Path $env:USERPROFILE ".gemini\config\skills\claude-leader\scripts\invoke-claude.ps1"),
    (Join-Path $env:USERPROFILE ".gemini\config\skills\claude-leader\scripts\invoke-codex.ps1"),
    (Join-Path $env:USERPROFILE ".gemini\config\skills\claude-leader\scripts\invoke-antigravity.ps1"),
    (Join-Path $env:USERPROFILE ".gemini\config\skills\claude-leader\scripts\invoke-council-review.ps1"),
    (Join-Path $env:USERPROFILE ".gemini\config\skills\claude-leader\scripts\save-agentapi-env.ps1"),
    (Join-Path $env:USERPROFILE ".claude\CLAUDE.md"),
    (Join-Path $env:USERPROFILE ".claude\commands\antigravity.md")
)

foreach ($f in $expectedFiles) {
    if (Test-Path $f) {
        Write-Host "  [OK] $f" -ForegroundColor Green
    } else {
        Write-Host "  [MISSING] $f (Run .\install.ps1 to sync)" -ForegroundColor Red
    }
}

# 6. Audit & Token Optimization Summary
Write-Host "`n[6/6] Audit & Token Optimization Summary (multi-ai-audit.jsonl)" -ForegroundColor Yellow
$auditFile = Join-Path $env:USERPROFILE ".gemini\antigravity\multi-ai-audit.jsonl"
if (Test-Path $auditFile) {
    $entries = @()
    foreach ($line in (Get-Content -Path $auditFile -Encoding UTF8 -ErrorAction SilentlyContinue)) {
        if ($line -and $line.Trim()) {
            try {
                $entries += ($line | ConvertFrom-Json)
            } catch {}
        }
    }

    if ($entries.Count -gt 0) {
        $totalChars = ($entries | Measure-Object -Property PromptChars -Sum).Sum
        $approvedCount = @($entries | Where-Object { $_.Verdict -eq "APPROVED" }).Count
        $changesCount  = @($entries | Where-Object { $_.Verdict -eq "CHANGES_REQUESTED" }).Count

        Write-Host "  Total Invocations : $($entries.Count)" -ForegroundColor White
        Write-Host "  Total PromptChars : $totalChars chars" -ForegroundColor White
        Write-Host "  Review Verdicts   : $approvedCount APPROVED | $changesCount CHANGES_REQUESTED" -ForegroundColor White

        Write-Host "`n  Breakdown by Tool & Role:" -ForegroundColor Cyan
        $entries | Group-Object -Property Tool, Role | ForEach-Object {
            $groupChars = ($_.Group | Measure-Object -Property PromptChars -Sum).Sum
            Write-Host ("    - {0,-22} : {1,4} calls ({2} chars)" -f $_.Name, $_.Count, $groupChars) -ForegroundColor Gray
        }

        if ($ShowRecentLogs -or $entries.Count -gt 0) {
            Write-Host "`n  Last $([math]::Min(5, $entries.Count)) Audit Entries:" -ForegroundColor Cyan
            $entries | Select-Object -Last 5 | ForEach-Object {
                $scoreStr = if ($_.Score) { " [Score: $($_.Score)]" } else { "" }
                Write-Host "    [$($_.Timestamp)] $($_.Tool)/$($_.Role) ($($_.Model)) -> $($_.Verdict)$scoreStr ($($_.PromptChars) chars)" -ForegroundColor Gray
            }
        }
    } else {
        Write-Host "  [INFO] Audit log file exists but has no entries yet." -ForegroundColor Gray
    }
} else {
    Write-Host "  [INFO] No audit log file yet at $auditFile (will be created on first Claude/Codex call)." -ForegroundColor Gray
}

Write-Host "`n================================================================" -ForegroundColor Cyan
Write-Host "  Health Check Complete!" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
