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

Wait-Job -Job @($claudeJob, $codexJob) | Out-Null

$claudeOut = (Receive-Job -Job $claudeJob) -join "`n"
$codexOut  = (Receive-Job -Job $codexJob) -join "`n"

Remove-Job -Job @($claudeJob, $codexJob) -Force -ErrorAction SilentlyContinue

$elapsed = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)

Write-Output "================================================================"
Write-Output "  UNIFIED AI COUNCIL REVIEW REPORT (Parallel Execution: ${elapsed}s)"
Write-Output "================================================================"
Write-Output ""
Write-Output "--- [1/2] CLAUDE SONNET (Tech Lead & Architecture Reviewer) ---"
Write-Output $claudeOut
Write-Output ""
Write-Output "--- [2/2] OPENAI CODEX (Security, Edge-Case & Diff Critic) ---"
Write-Output $codexOut
