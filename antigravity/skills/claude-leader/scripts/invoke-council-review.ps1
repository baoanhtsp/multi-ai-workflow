param(
    [string]$WorkDir = (Get-Location).Path,

    [string]$Prompt = "Review the uncommitted changes against SPEC.md. Check architecture, security, race conditions, and edge cases. Provide a score X/10 and final verdict (APPROVED or CHANGES_REQUESTED).",

    [string]$PromptFile = "",

    [string]$Reviewers = "",

    [int]$TimeoutSeconds = 900,

    [string]$CommitSha = "",

    [string]$BaseBranch = "",

    [switch]$ContinueClaudeSession
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot "lib\maw-common.ps1")
. (Join-Path $PSScriptRoot "lib\maw-registry.ps1")

$agentScript = Join-Path $PSScriptRoot "invoke-agent.ps1"
if (-not (Test-Path -LiteralPath $agentScript -PathType Leaf)) {
    Write-Error "Could not locate invoke-agent.ps1 at $agentScript"
    exit 1
}

$reg = Get-AgentRegistry -ScriptsDir $PSScriptRoot
$reviewerList = [System.Collections.Generic.List[string]]::new()

if ($Reviewers -and $Reviewers.Trim()) {
    foreach ($tok in ($Reviewers -split '[,;\s]+')) {
        $id = $tok.Trim().ToLowerInvariant()
        if ($id -and -not $reviewerList.Contains($id)) {
            $reviewerList.Add($id)
        }
    }
} else {
    foreach ($id in @($reg.defaults.council)) {
        $norm = ([string]$id).Trim().ToLowerInvariant()
        if ($norm -and -not $reviewerList.Contains($norm)) {
            $reviewerList.Add($norm)
        }
    }
}

if ($reviewerList.Count -eq 0) {
    Write-Output "ERROR: Council requires at least 1 reviewer."
    exit 1
}

$reviewerEntries = [System.Collections.Generic.List[psobject]]::new()
foreach ($revId in $reviewerList) {
    $entry = Get-AgentEntry -AgentId $revId -Registry $reg
    if ($null -eq $entry) {
        Write-Output "ERROR: Unknown or disabled council reviewer '$revId'."
        exit 1
    }
    if (-not $entry.capabilities.review) {
        Write-Output "ERROR: Agent '$revId' does not support review capability."
        exit 1
    }
    $reviewerEntries.Add($entry)
}

if ($PromptFile) {
    if (-not (Test-Path -LiteralPath $PromptFile -PathType Leaf)) {
        Write-Output "ERROR: PromptFile not found: $PromptFile"
        exit 1
    }
    $fileText = Get-Content -LiteralPath $PromptFile -Raw -Encoding UTF8
    if ($Prompt) {
        $Prompt = "$Prompt`n`n$fileText"
    } else {
        $Prompt = $fileText
    }
}

# Pre-compute diff on the main process (A1 fix: avoids duplicate git calls inside Start-Job and supports CommitSha/BaseBranch)
if ($Prompt -notmatch '---\s*GIT DIFF TO REVIEW\s*---') {
    $diffText = Get-ReviewDiff -WorkDir $WorkDir -CommitSha $CommitSha -BaseBranch $BaseBranch
    if ($diffText -and $diffText.Trim()) {
        $Prompt = "$Prompt`n`n--- GIT DIFF TO REVIEW ---`n$diffText"
    }
}

$sharedPromptFile = Join-Path $env:TEMP ("maw_council_prompt_" + [guid]::NewGuid().ToString("N") + ".txt")
$jobsById = [ordered]@{}
$linesById = [ordered]@{}
$exitById = [ordered]@{}
$timedOutById = [ordered]@{}

try {
    [System.IO.File]::WriteAllText($sharedPromptFile, $Prompt, (New-Object System.Text.UTF8Encoding($true)))

    $startTime = Get-Date
    $namesJoined = ($reviewerEntries | ForEach-Object { "$($_.label) ($($_.id))" }) -join " + "
    Write-Output "[$(Get-Date -Format 'HH:mm:ss')] Launching Parallel AI Council ($namesJoined) in $WorkDir..."

    $mawHomeVal = if ($env:MAW_HOME) { $env:MAW_HOME } else { "" }

    foreach ($entry in $reviewerEntries) {
        $rid = $entry.id
        $linesById[$rid] = [System.Collections.Generic.List[string]]::new()
        $exitById[$rid] = 0
        $timedOutById[$rid] = $false

        $jobsById[$rid] = Start-Job -ScriptBlock {
            param($agentScriptPath, $agentId, $workDir, $promptFilePath, $timeoutSec, $mawHome)
            $OutputEncoding = [System.Text.Encoding]::UTF8
            [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
            if ($mawHome) {
                $env:MAW_HOME = $mawHome
            }
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $agentScriptPath -Agent $agentId -Role reviewer -WorkDir $workDir -PromptFile $promptFilePath -TimeoutSeconds $timeoutSec 2>&1
            $code = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
            Write-Output "__JOB_EXIT_CODE__:$code"
        } -ArgumentList $agentScript, $rid, $WorkDir, $sharedPromptFile, $TimeoutSeconds, $mawHomeVal
    }

    $deadlineMs = [Math]::Max(2000, ($TimeoutSeconds + 15) * 1000)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    while ($true) {
        $anyRunning = $false
        foreach ($entry in $reviewerEntries) {
            $rid = $entry.id
            $job = $jobsById[$rid]
            $chunk = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
            foreach ($line in $chunk) {
                $s = $line.ToString()
                if ($s -match '^__JOB_EXIT_CODE__:(-?\d+)$') {
                    $exitById[$rid] = [int]$Matches[1]
                    continue
                }
                $linesById[$rid].Add($s)
                if ($s -match '^\[(Connected|Action|Done|Completed)') {
                    Write-Output "[$($entry.label)] $s"
                }
            }
            if ($job.State -eq "Running") {
                if ($sw.ElapsedMilliseconds -ge $deadlineMs) {
                    $timedOutById[$rid] = $true
                    $exitById[$rid] = 124
                    try { Stop-Job -Job $job -ErrorAction SilentlyContinue } catch {}
                } else {
                    $anyRunning = $true
                }
            }
        }
        if (-not $anyRunning) {
            break
        }
        Start-Sleep -Milliseconds 300
    }

    foreach ($entry in $reviewerEntries) {
        $rid = $entry.id
        $job = $jobsById[$rid]
        foreach ($line in @(Receive-Job -Job $job -ErrorAction SilentlyContinue)) {
            $s = $line.ToString()
            if ($s -match '^__JOB_EXIT_CODE__:(-?\d+)$') {
                $exitById[$rid] = [int]$Matches[1]
                continue
            }
            $linesById[$rid].Add($s)
        }
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }

    $elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
    Write-Output ""
    Write-Output "================================================================"
    Write-Output "  UNIFIED AI COUNCIL REVIEW REPORT (Parallel Execution: ${elapsed}s)"
    Write-Output "================================================================"

    $resultTokens = [System.Collections.Generic.List[string]]::new()
    $anyUnknown = $false
    $anyChanges = $false
    $minScore = $null

    $idx = 0
    $totalRev = $reviewerEntries.Count
    foreach ($entry in $reviewerEntries) {
        $idx++
        $rid = $entry.id
        $outText = ($linesById[$rid] -join "`n")
        $jobFailed = ($timedOutById[$rid] -or $exitById[$rid] -ne 0)

        $parsed = if ($jobFailed) {
            @{ Verdict = "UNKNOWN"; Score = ""; ScoreValue = $null }
        } else {
            Get-ReviewVerdict -Text $outText
        }

        $verdict = if ($parsed.Verdict -in @("APPROVED", "CHANGES_REQUESTED")) { $parsed.Verdict } else { "UNKNOWN" }
        $scoreStr = if ($parsed.Score) { $parsed.Score } else { "" }

        if ($verdict -eq "UNKNOWN") {
            $anyUnknown = $true
        } elseif ($verdict -eq "CHANGES_REQUESTED") {
            $anyChanges = $true
        }

        if ($null -ne $parsed.ScoreValue) {
            $val = [double]$parsed.ScoreValue
            if ($null -eq $minScore -or $val -lt $minScore) {
                $minScore = $val
            }
        } else {
            $anyChanges = $true
        }

        Write-Output ""
        Write-Output "--- [$idx/$totalRev] $($entry.label.ToUpperInvariant()) ($rid) ---"
        Write-Output $outText

        $resultTokens.Add("${rid}=${verdict}|${scoreStr}")
    }

    Write-Output ""
    Write-Output "=== COUNCIL_RESULT $($resultTokens -join ' ') ==="

    if ($anyUnknown) {
        exit 3
    }
    if ($anyChanges -or $null -eq $minScore -or $minScore -lt 8.5) {
        exit 2
    }
    exit 0
} finally {
    if (Test-Path -LiteralPath $sharedPromptFile) {
        Remove-Item -LiteralPath $sharedPromptFile -Force -ErrorAction SilentlyContinue
    }
}
