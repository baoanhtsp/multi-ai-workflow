param(
    [string]$WorkDir = (Get-Location).Path,

    [string]$Prompt = "Review the uncommitted changes against SPEC.md. Check architecture, security, race conditions, and edge cases. Provide a score X/10 and final verdict (APPROVED or CHANGES_REQUESTED).",

    [string]$PromptFile = "",

    [string]$CommitSha = "",

    [string]$BaseBranch = "",

    [switch]$ContinueClaudeSession
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

$claudeScript = Join-Path $PSScriptRoot "invoke-claude.ps1"
$codexScript  = Join-Path $PSScriptRoot "invoke-codex.ps1"

if (-not (Test-Path $claudeScript)) {
    Write-Error "Could not locate invoke-claude.ps1 at $claudeScript"
    exit 1
}
if (-not (Test-Path $codexScript)) {
    Write-Error "Could not locate invoke-codex.ps1 at $codexScript"
    exit 1
}

$startTime = Get-Date
Write-Output "[$(Get-Date -Format 'HH:mm:ss')] Launching Parallel AI Council (Claude Sonnet + OpenAI Codex) in $WorkDir..."

$claudeJob = Start-Job -ScriptBlock {
    param($scriptPath, $workDir, $prompt, $promptFile, $continueSession)
    $OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $invokeParams = @{
        Role           = "reviewer"
        WorkDir        = $workDir
        IncludeGitDiff = $true
        Prompt         = $prompt
    }
    if ($promptFile) {
        $invokeParams["PromptFile"] = $promptFile
    }
    if ($continueSession) {
        $invokeParams["ContinueSession"] = $true
    }
    & $scriptPath @invokeParams 2>&1
} -ArgumentList $claudeScript, $WorkDir, $Prompt, $PromptFile, $ContinueClaudeSession.IsPresent

$codexJob = Start-Job -ScriptBlock {
    param($scriptPath, $workDir, $prompt, $promptFile, $commitSha, $baseBranch)
    $OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $invokeParams = @{
        Role    = "review-diff"
        WorkDir = $workDir
    }
    if ($commitSha) {
        $invokeParams["CommitSha"] = $commitSha
    }
    if ($baseBranch) {
        $invokeParams["BaseBranch"] = $baseBranch
    }
    if ($prompt) {
        $invokeParams["Prompt"] = $prompt
    }
    if ($promptFile) {
        $invokeParams["PromptFile"] = $promptFile
    }
    & $scriptPath @invokeParams 2>&1
} -ArgumentList $codexScript, $WorkDir, $Prompt, $PromptFile, $CommitSha, $BaseBranch

$claudeLines = [System.Collections.Generic.List[string]]::new()
$codexLines  = [System.Collections.Generic.List[string]]::new()

while ($claudeJob.State -eq "Running" -or $codexJob.State -eq "Running") {
    $cChunk = @(Receive-Job -Job $claudeJob -ErrorAction SilentlyContinue)
    foreach ($line in $cChunk) {
        $s = $line.ToString()
        $claudeLines.Add($s)
        if ($s -match '^\[(Connected|Action|Completed)') {
            Write-Output "[Claude] $s"
        }
    }
    $xChunk = @(Receive-Job -Job $codexJob -ErrorAction SilentlyContinue)
    foreach ($line in $xChunk) {
        $s = $line.ToString()
        $codexLines.Add($s)
        if ($s -match '^\[(Connected|Action|Done|Completed)') {
            Write-Output "[Codex] $s"
        }
    }
    Start-Sleep -Milliseconds 800
}

foreach ($line in @(Receive-Job -Job $claudeJob -ErrorAction SilentlyContinue)) {
    $claudeLines.Add($line.ToString())
}
foreach ($line in @(Receive-Job -Job $codexJob -ErrorAction SilentlyContinue)) {
    $codexLines.Add($line.ToString())
}

Remove-Job -Job @($claudeJob, $codexJob) -Force -ErrorAction SilentlyContinue

$claudeOut = ($claudeLines -join "`n")
$codexOut  = ($codexLines -join "`n")
$elapsed   = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)

Write-Output ""
Write-Output "================================================================"
Write-Output "  UNIFIED AI COUNCIL REVIEW REPORT (Parallel Execution: ${elapsed}s)"
Write-Output "================================================================"
Write-Output ""
Write-Output "--- [1/2] CLAUDE SONNET (Tech Lead & Architecture Reviewer) ---"
Write-Output $claudeOut
Write-Output ""
Write-Output "--- [2/2] OPENAI CODEX (Security, Edge-Case & Diff Critic) ---"
Write-Output $codexOut
