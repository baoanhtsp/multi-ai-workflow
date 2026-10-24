param(
    [Parameter(Mandatory=$true)]
    [string]$WorkDir,

    [Parameter(Mandatory=$false)]
    [string]$Prompt = "",

    [Parameter(Mandatory=$false)]
    [string]$PromptFile = "",

    [Parameter(Mandatory=$false)]
    [int]$MaxRounds = 2,

    [Parameter(Mandatory=$false)]
    [switch]$SkipInitialImplement
)

$ErrorActionPreference = "Continue"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot "lib\maw-common.ps1")

if ($PromptFile) {
    if (-not (Test-Path -LiteralPath $PromptFile)) {
        Write-Error "PromptFile does not exist: $PromptFile"
        exit 1
    }
    $fileContent = Get-Content -LiteralPath $PromptFile -Raw -Encoding UTF8
    if ($Prompt) {
        $Prompt = "$Prompt`n`n$fileContent"
    } else {
        $Prompt = $fileContent
    }
}

$scriptDir   = $PSScriptRoot
$agyScript   = Join-Path $scriptDir "invoke-antigravity.ps1"
$guardScript = Join-Path $scriptDir "invoke-spec-guard.ps1"
$councilScr  = Join-Path $scriptDir "invoke-council-review.ps1"
$notifyScr   = Join-Path $scriptDir "send-notification.ps1"

Write-Output "=================================================================="
Write-Output "  AUTO-REVIEW GATE: IMPLEMENT -> SPEC GUARD -> COUNCIL -> FIX"
Write-Output "  Project   : $WorkDir"
Write-Output "  Max Rounds: $MaxRounds"
Write-Output "=================================================================="

$baselineFile = $null
if (-not $SkipInitialImplement) {
    $baselineFile = Join-Path $env:TEMP ("autogate_baseline_" + [guid]::NewGuid().ToString("N") + ".json")
    Get-DirtySnapshot -WorkDir $WorkDir -OutFile $baselineFile | Out-Null
}

try {
    # Step 1: Initial Implementation by Antigravity (unless skipped)
    if (-not $SkipInitialImplement -and $Prompt) {
        Write-Output "`n[Phase 1] Dispatching implementation task to Antigravity IDE (Timeout: 1800s)..."
        $initPromptFile = Join-Path $env:TEMP ("autogate_init_" + [guid]::NewGuid().ToString("N") + ".txt")
        [System.IO.File]::WriteAllText($initPromptFile, $Prompt, (New-Object System.Text.UTF8Encoding($true)))
        & powershell -NoProfile -ExecutionPolicy Bypass -File $agyScript -Action send-latest -WorkDir $WorkDir -Title "Auto-Gate Implementation" -PromptFile $initPromptFile -TimeoutSeconds 1800
        $agyCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
        Remove-Item -LiteralPath $initPromptFile -Force -ErrorAction SilentlyContinue
        if ($agyCode -ne 0) {
            Write-Output "[Auto-Gate] Antigravity initial implementation failed or timed out (exit code $agyCode). Aborting before review."
            exit $agyCode
        }
    }

    $roundsHistory = @()
    $finalVerdict = "CHANGES_REQUESTED"
    $finalScore = "N/A"
    $finalExitCode = 2

    for ($round = 1; $round -le $MaxRounds; $round++) {
        Write-Output "`n------------------------------------------------------------------"
        if ($SkipInitialImplement) {
            Write-Output "  [Round $round / $MaxRounds] Running SPEC.md Contract Guard (review-only mode)..."
        } else {
            Write-Output "  [Round $round / $MaxRounds] Running SPEC.md Contract Guard (-Owner antigravity with baseline)..."
        }
        Write-Output "------------------------------------------------------------------"

        $guardArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $guardScript, "-WorkDir", $WorkDir, "-Json")
        if (-not $SkipInitialImplement) {
            $guardArgs += @("-Owner", "antigravity", "-Baseline", $baselineFile)
        }
        $guardJsonRaw = (& powershell @guardArgs 2>&1) -join "`n"
        $guardViolations = @()
        try {
            $guardObj = $guardJsonRaw | ConvertFrom-Json -ErrorAction Stop
            Write-Output "SPEC Guard Verdict: $($guardObj.verdict) | Modified: $($guardObj.total_modified) | Violations: $(@($guardObj.violations).Count) | Warnings: $(@($guardObj.warnings).Count)"
            if ($guardObj.violations) {
                foreach ($v in $guardObj.violations) {
                    $guardViolations += [string]$v
                    Write-Output "  [SPEC VIOLATION] $v"
                }
            }
        } catch {
            Write-Output $guardJsonRaw
        }

        Write-Output "`n------------------------------------------------------------------"
        Write-Output "  [Round $round / $MaxRounds] Running Parallel AI Council Review (Claude + Codex)..."
        Write-Output "------------------------------------------------------------------"
        $reviewPrompt = if ($Prompt) { "Round $round Review against SPEC.md for task: $Prompt" } else { "Round $round Review of uncommitted changes against SPEC.md." }
        $councilOut = (& powershell -NoProfile -ExecutionPolicy Bypass -File $councilScr -WorkDir $WorkDir -Prompt $reviewPrompt 2>&1) -join "`n"
        $councilExit = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
        Write-Output $councilOut

        $cVerdict = "UNKNOWN"
        $xVerdict = "UNKNOWN"
        $cScoreVal = $null
        $xScoreVal = $null

        if ($councilOut -match '===\s*COUNCIL_RESULT\s+claude=([A-Z_]+)\|([^\s]*)\s+codex=([A-Z_]+)\|([^\s=]*)\s*===') {
            $cVerdict = $Matches[1]
            $cScoreRaw = $Matches[2]
            $xVerdict = $Matches[3]
            $xScoreRaw = $Matches[4]

            if ($cScoreRaw -match '^(\d+(?:\.\d+)?)') {
                $cScoreVal = [double]::Parse($Matches[1], [System.Globalization.CultureInfo]::InvariantCulture)
            }
            if ($xScoreRaw -match '^(\d+(?:\.\d+)?)') {
                $xScoreVal = [double]::Parse($Matches[1], [System.Globalization.CultureInfo]::InvariantCulture)
            }
        }

        if ($councilExit -eq 3 -or $cVerdict -eq "UNKNOWN" -or $xVerdict -eq "UNKNOWN") {
            Write-Output "`n[Auto-Gate ERROR] Council review incomplete or failed (claude=$cVerdict, codex=$xVerdict). Refusing to send broken review output to Antigravity."
            exit 3
        }

        $minScore = $null
        if ($null -ne $cScoreVal -and $null -ne $xScoreVal) {
            $minScore = [Math]::Min($cScoreVal, $xScoreVal)
        }

        $scoreStr = if ($null -ne $minScore) { "$minScore/10" } else { "N/A" }

        $isApproved = (
            $cVerdict -eq "APPROVED" -and
            $xVerdict -eq "APPROVED" -and
            $null -ne $minScore -and
            $minScore -ge 8.5 -and
            $guardViolations.Count -eq 0
        )

        $roundVerdict = if ($isApproved) { "APPROVED" } else { "CHANGES_REQUESTED" }
        $roundsHistory += [PSCustomObject]@{
            round   = $round
            score   = $scoreStr
            verdict = $roundVerdict
        }
        $finalScore = $scoreStr
        $finalVerdict = $roundVerdict

        Write-Output "`n>>> [Round $round Result] Min Score: $scoreStr (Claude: $cVerdict, Codex: $xVerdict) | Verdict: $roundVerdict <<<"

        if ($isApproved) {
            Write-Output "`n[Auto-Gate] Target achieved! Code is APPROVED by both reviewers (min score >= 8.5) in Round $round."
            $finalExitCode = 0
            break
        }

        if ($round -lt $MaxRounds) {
            Write-Output "`n[Auto-Gate] Sending Council feedback back to Antigravity for automated fixes (Round $($round + 1), Timeout: 1800s)..."

            $cleanLines = foreach ($line in ($councilOut -replace "`r`n", "`n" -split "`n")) {
                if ($line -notmatch '^\[(Claude|Codex)\]\s+\[(Connected|Action|Done|Completed)') {
                    $line
                }
            }
            $cleanReview = ($cleanLines -join "`n").Trim()
            if ($cleanReview.Length -gt 20000) {
                $cleanReview = $cleanReview.Substring(0, 20000) + "`n`n[...review truncated at 20000 chars...]"
            }

            $specViolationBlock = ""
            if ($guardViolations.Count -gt 0) {
                $specViolationBlock = "`nSPEC.md Ownership / Contract Violations to fix:`n- " + ($guardViolations -join "`n- ") + "`n"
            }

            $fixPrompt = @"
AI Council Review (Round $round) returned $roundVerdict (Min Score: $scoreStr).
$specViolationBlock
Please fix all issues reported below in $WorkDir, re-run verification tests, and report completion:

$cleanReview
"@
            $fixFile = Join-Path $env:TEMP ("autogate_fix_" + [guid]::NewGuid().ToString("N") + ".txt")
            [System.IO.File]::WriteAllText($fixFile, $fixPrompt, (New-Object System.Text.UTF8Encoding($true)))
            & powershell -NoProfile -ExecutionPolicy Bypass -File $agyScript -Action send-latest -WorkDir $WorkDir -Title "Auto-Gate Fix Round $($round + 1)" -PromptFile $fixFile -TimeoutSeconds 1800
            $fixExit = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
            Remove-Item -LiteralPath $fixFile -Force -ErrorAction SilentlyContinue
            if ($fixExit -ne 0) {
                Write-Output "[Auto-Gate] Antigravity fix turn failed or timed out (exit code $fixExit). Stopping."
                exit $fixExit
            }
        }
    }

    Write-Output "`n=================================================================="
    Write-Output "  AUTO-REVIEW GATE SUMMARY"
    foreach ($r in $roundsHistory) {
        Write-Output ("  Round {0}: Score {1} -> {2}" -f $r.round, $r.score, $r.verdict)
    }
    Write-Output "  Final Status: $finalVerdict ($finalScore)"
    Write-Output "=================================================================="

    if (Test-Path -LiteralPath $notifyScr) {
        $projName = Split-Path $WorkDir -Leaf
        $st = if ($finalVerdict -eq "APPROVED") { "success" } else { "warn" }
        & powershell -NoProfile -ExecutionPolicy Bypass -File $notifyScr -Title "Auto-Gate: $projName" -Message "Final Verdict: $finalVerdict ($finalScore) after $($roundsHistory.Count) round(s)." -Status $st | Out-Null
    }

    exit $finalExitCode
} finally {
    if ($baselineFile -and (Test-Path -LiteralPath $baselineFile)) {
        Remove-Item -LiteralPath $baselineFile -Force -ErrorAction SilentlyContinue
    }
}
