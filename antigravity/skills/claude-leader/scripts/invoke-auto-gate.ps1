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
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ($PromptFile) {
    if (-not (Test-Path $PromptFile)) {
        Write-Error "PromptFile does not exist: $PromptFile"
        exit 1
    }
    $Prompt = Get-Content -Path $PromptFile -Raw -Encoding UTF8
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

# Step 1: Initial Implementation by Antigravity (unless skipped)
if (-not $SkipInitialImplement -and $Prompt) {
    Write-Output "`n[Phase 1] Dispatching implementation task to Antigravity IDE..."
    $initPromptFile = Join-Path $env:TEMP ("autogate_init_" + [guid]::NewGuid().ToString("N") + ".txt")
    [System.IO.File]::WriteAllText($initPromptFile, $Prompt, (New-Object System.Text.UTF8Encoding($true)))
    & powershell -NoProfile -ExecutionPolicy Bypass -File $agyScript -Action send-latest -WorkDir $WorkDir -Title "Auto-Gate Implementation" -PromptFile $initPromptFile
    Remove-Item $initPromptFile -Force -ErrorAction SilentlyContinue
}

$roundsHistory = @()
$finalVerdict = "CHANGES_REQUESTED"
$finalScore = "N/A"

for ($round = 1; $round -le $MaxRounds; $round++) {
    Write-Output "`n------------------------------------------------------------------"
    Write-Output "  [Round $round / $MaxRounds] Running SPEC.md Contract Guard (0 LLM Tokens)..."
    Write-Output "------------------------------------------------------------------"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $guardScript -WorkDir $WorkDir

    Write-Output "`n------------------------------------------------------------------"
    Write-Output "  [Round $round / $MaxRounds] Running Parallel AI Council Review (Claude + Codex)..."
    Write-Output "------------------------------------------------------------------"
    $reviewPrompt = if ($Prompt) { "Round $round Review against SPEC.md for task: $Prompt" } else { "Round $round Review of uncommitted changes against SPEC.md. Score X/10." }
    $councilOut = (& powershell -NoProfile -ExecutionPolicy Bypass -File $councilScr -WorkDir $WorkDir -Prompt $reviewPrompt 2>&1) -join "`n"
    Write-Output $councilOut

    $scoreVal = 0.0
    $scoreStr = "N/A"
    if ($councilOut -match '\b([0-9]+(?:\.[0-9]+)?)\s*/\s*10\b') {
        $scoreVal = [double]$Matches[1]
        $scoreStr = "$($Matches[1])/10"
    }
    $isApproved = ($councilOut -match '\bAPPROVED\b') -and ($councilOut -notmatch '\bCHANGES_REQUESTED\b')
    if ($scoreVal -ge 8.5 -and $councilOut -notmatch '\bCHANGES_REQUESTED\b') {
        $isApproved = $true
    }

    $roundVerdict = if ($isApproved) { "APPROVED" } else { "CHANGES_REQUESTED" }
    $roundsHistory += [PSCustomObject]@{
        round   = $round
        score   = $scoreStr
        verdict = $roundVerdict
    }
    $finalScore = $scoreStr
    $finalVerdict = $roundVerdict

    Write-Output "`n>>> [Round $round Result] Score: $scoreStr | Verdict: $roundVerdict <<<"

    if ($isApproved) {
        Write-Output "`n[Auto-Gate] Target achieved! Code is APPROVED in Round $round."
        break
    }

    if ($round -lt $MaxRounds) {
        Write-Output "`n[Auto-Gate] Sending Council feedback back to Antigravity for automated fixes (Round $($round + 1))..."
        $fixPrompt = @"
AI Council Review (Round $round) returned $roundVerdict ($scoreStr).
Please fix all issues reported below in $WorkDir, re-run verification tests, and report completion:

$councilOut
"@
        $fixFile = Join-Path $env:TEMP ("autogate_fix_" + [guid]::NewGuid().ToString("N") + ".txt")
        [System.IO.File]::WriteAllText($fixFile, $fixPrompt, (New-Object System.Text.UTF8Encoding($true)))
        & powershell -NoProfile -ExecutionPolicy Bypass -File $agyScript -Action send-latest -WorkDir $WorkDir -Title "Auto-Gate Fix Round $($round + 1)" -PromptFile $fixFile
        Remove-Item $fixFile -Force -ErrorAction SilentlyContinue
    }
}

Write-Output "`n=================================================================="
Write-Output "  AUTO-REVIEW GATE SUMMARY"
foreach ($r in $roundsHistory) {
    Write-Output ("  Round {0}: Score {1} -> {2}" -f $r.round, $r.score, $r.verdict)
}
Write-Output "  Final Status: $finalVerdict ($finalScore)"
Write-Output "=================================================================="

if (Test-Path $notifyScr) {
    $projName = Split-Path $WorkDir -Leaf
    $st = if ($finalVerdict -eq "APPROVED") { "success" } else { "warn" }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $notifyScr -Title "Auto-Gate: $projName" -Message "Final Verdict: $finalVerdict ($finalScore) after $($roundsHistory.Count) round(s)." -Status $st | Out-Null
}
