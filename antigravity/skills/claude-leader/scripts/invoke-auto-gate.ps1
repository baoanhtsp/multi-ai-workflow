param(
    [Parameter(Mandatory=$true)]
    [string]$WorkDir,

    [Parameter(Mandatory=$false)]
    [string]$Prompt = "",

    [Parameter(Mandatory=$false)]
    [string]$PromptFile = "",

    [Parameter(Mandatory=$false)]
    [string]$Implementer = "",

    [Parameter(Mandatory=$false)]
    [string]$Reviewers = "",

    [Parameter(Mandatory=$false)]
    [int]$MaxRounds = 2,

    [Parameter(Mandatory=$false)]
    [switch]$SkipInitialImplement
)

$ErrorActionPreference = "Continue"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot "lib\maw-common.ps1")
. (Join-Path $PSScriptRoot "lib\maw-registry.ps1")
. (Join-Path $PSScriptRoot "lib\maw-hooks.ps1")

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
$agentScript = Join-Path $scriptDir "invoke-agent.ps1"
$guardScript = Join-Path $scriptDir "invoke-spec-guard.ps1"
$councilScr  = Join-Path $scriptDir "invoke-council-review.ps1"
$notifyScr   = Join-Path $scriptDir "send-notification.ps1"

$reg = Get-AgentRegistry -ScriptsDir $scriptDir
$effImplementer = if ($Implementer -and $Implementer.Trim()) {
    $Implementer.Trim().ToLowerInvariant()
} else {
    ([string]$reg.defaults.implementer).Trim().ToLowerInvariant()
}

$implEntry = Get-AgentEntry -AgentId $effImplementer -Registry $reg
if ($null -eq $implEntry) {
    Write-Output "ERROR: Unknown or disabled implementer '$effImplementer'."
    exit 1
}
if (-not $implEntry.capabilities.write) {
    Write-Output "ERROR: Implementer '$effImplementer' does not have write capability."
    exit 1
}

$effReviewers = if ($Reviewers -and $Reviewers.Trim()) {
    ($Reviewers -split '[,;\s]+' | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ }) -join ","
} else {
    (@($reg.defaults.council) -join ",")
}

Write-Output "=================================================================="
Write-Output "  AUTO-REVIEW GATE: IMPLEMENT -> SPEC GUARD -> COUNCIL -> FIX"
Write-Output "  Project    : $WorkDir"
Write-Output "  Implementer: $effImplementer ($($implEntry.label))"
Write-Output "  Reviewers  : $effReviewers"
Write-Output "  Max Rounds : $MaxRounds"
Write-Output "=================================================================="

$baselineFile = $null
if (-not $SkipInitialImplement) {
    $baselineFile = Join-Path $env:TEMP ("autogate_baseline_" + [guid]::NewGuid().ToString("N") + ".json")
    Get-DirtySnapshot -WorkDir $WorkDir -OutFile $baselineFile | Out-Null
}

function Invoke-AutoGateHookOrExit {
    param(
        [Parameter(Mandatory=$true)]
        [string]$EventName,

        [int]$RoundNum = 1
    )

    $hookRes = Invoke-MawHooks -Event $EventName -Context @{
        workdir     = $WorkDir
        project     = $WorkDir
        implementer = $effImplementer
        reviewers   = $effReviewers
        round       = $RoundNum
        max_rounds  = $MaxRounds
    }
    if ($hookRes -and $hookRes.Block) {
        Write-Output "[Auto-Gate HOOK BLOCKED: $EventName] $($hookRes.Reason)"
        exit 4
    }
}

try {
    # Step 1: Initial Implementation via invoke-agent.ps1 -Role backend (unless skipped)
    if (-not $SkipInitialImplement -and $Prompt) {
        Write-Output "`n[Phase 1] Dispatching implementation task to $($implEntry.label) ($effImplementer) (Timeout: 1800s)..."
        $initPromptFile = Join-Path $env:TEMP ("autogate_init_" + [guid]::NewGuid().ToString("N") + ".txt")
        [System.IO.File]::WriteAllText($initPromptFile, $Prompt, (New-Object System.Text.UTF8Encoding($true)))
        & powershell -NoProfile -ExecutionPolicy Bypass -File $agentScript -Agent $effImplementer -Role backend -WorkDir $WorkDir -PromptFile $initPromptFile -TimeoutSeconds 1800
        $implCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
        Remove-Item -LiteralPath $initPromptFile -Force -ErrorAction SilentlyContinue
        if ($implCode -ne 0) {
            Write-Output "[Auto-Gate] Initial implementation by $effImplementer failed or timed out (exit code $implCode). Aborting before review."
            exit $implCode
        }
        Invoke-AutoGateHookOrExit -EventName "after-implement" -RoundNum 1
    }

    $roundsHistory = @()
    $finalVerdict = "CHANGES_REQUESTED"
    $finalScore = "N/A"
    $finalExitCode = 2

    for ($round = 1; $round -le $MaxRounds; $round++) {
        Invoke-AutoGateHookOrExit -EventName "round-start" -RoundNum $round
        if ($SkipInitialImplement -or (-not $Prompt -and $round -eq 1)) {
            Invoke-AutoGateHookOrExit -EventName "after-implement" -RoundNum $round
        }

        Write-Output "`n------------------------------------------------------------------"
        if ($SkipInitialImplement) {
            Write-Output "  [Round $round / $MaxRounds] Running SPEC.md Contract Guard (review-only mode)..."
        } else {
            Write-Output "  [Round $round / $MaxRounds] Running SPEC.md Contract Guard (-Owner $effImplementer with baseline)..."
        }
        Write-Output "------------------------------------------------------------------"

        $guardArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $guardScript, "-WorkDir", $WorkDir, "-Json")
        if (-not $SkipInitialImplement) {
            $guardArgs += @("-Owner", $effImplementer, "-Baseline", $baselineFile)
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

        Invoke-AutoGateHookOrExit -EventName "before-review" -RoundNum $round

        Write-Output "`n------------------------------------------------------------------"
        Write-Output "  [Round $round / $MaxRounds] Running Parallel AI Council Review ($effReviewers)..."
        Write-Output "------------------------------------------------------------------"
        $reviewPrompt = if ($Prompt) { "Round $round Review against SPEC.md for task: $Prompt" } else { "Round $round Review of uncommitted changes against SPEC.md." }
        $councilOut = (& powershell -NoProfile -ExecutionPolicy Bypass -File $councilScr -WorkDir $WorkDir -Reviewers $effReviewers -Prompt $reviewPrompt 2>&1) -join "`n"
        $councilExit = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
        Write-Output $councilOut

        $anyUnknown = $false
        $allApproved = $true
        $minScore = $null
        $summaryParts = [System.Collections.Generic.List[string]]::new()

        if ($councilOut -match '===\s*COUNCIL_RESULT\s+(.+?)\s*===') {
            $pairsText = $Matches[1].Trim()
            $pairMatches = [regex]::Matches($pairsText, '([a-z0-9-]+)=([A-Z_]+)\|([^\s]*)')
            if ($pairMatches.Count -eq 0) {
                $anyUnknown = $true
            }
            foreach ($pm in $pairMatches) {
                $rId = $pm.Groups[1].Value
                $rVerd = $pm.Groups[2].Value
                $rScoreRaw = $pm.Groups[3].Value
                $summaryParts.Add("${rId}: $rVerd")

                if ($rVerd -eq "UNKNOWN") {
                    $anyUnknown = $true
                }
                if ($rVerd -ne "APPROVED") {
                    $allApproved = $false
                }
                if ($rScoreRaw -match '^(\d+(?:\.\d+)?)') {
                    $sVal = [double]::Parse($Matches[1], [System.Globalization.CultureInfo]::InvariantCulture)
                    if ($null -eq $minScore -or $sVal -lt $minScore) {
                        $minScore = $sVal
                    }
                } else {
                    $allApproved = $false
                }
            }
        } else {
            $anyUnknown = $true
        }

        if ($councilExit -eq 3 -or $anyUnknown) {
            Write-Output "`n[Auto-Gate ERROR] Council review incomplete or failed ($($summaryParts -join ', ')). Refusing to send broken review output to implementer."
            exit 3
        }

        $scoreStr = if ($null -ne $minScore) { "$minScore/10" } else { "N/A" }

        $isApproved = (
            $allApproved -and
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

        Write-Output "`n>>> [Round $round Result] Min Score: $scoreStr ($($summaryParts -join ', ')) | Verdict: $roundVerdict <<<"

        if ($isApproved) {
            Write-Output "`n[Auto-Gate] Target achieved! Code is APPROVED by all reviewers (min score >= 8.5) in Round $round."
            $finalExitCode = 0
            break
        }

        if ($round -lt $MaxRounds -and -not $SkipInitialImplement) {
            Write-Output "`n[Auto-Gate] Sending Council feedback back to $($implEntry.label) ($effImplementer) for automated fixes (Round $($round + 1), Timeout: 1800s)..."

            $cleanLines = foreach ($line in ($councilOut -replace "`r`n", "`n" -split "`n")) {
                if ($line -notmatch '^\[[^\]]+\]\s+\[(Connected|Action|Done|Completed)') {
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
            & powershell -NoProfile -ExecutionPolicy Bypass -File $agentScript -Agent $effImplementer -Role backend -WorkDir $WorkDir -PromptFile $fixFile -TimeoutSeconds 1800
            $fixExit = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
            Remove-Item -LiteralPath $fixFile -Force -ErrorAction SilentlyContinue
            if ($fixExit -ne 0) {
                Write-Output "[Auto-Gate] Implementer ($effImplementer) fix turn failed or timed out (exit code $fixExit). Stopping."
                exit $fixExit
            }
            Invoke-AutoGateHookOrExit -EventName "after-implement" -RoundNum ($round + 1)
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
