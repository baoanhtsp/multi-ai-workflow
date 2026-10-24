# Hook: round-start/10-checkpoint.ps1 (Multi-AI Workflow S1 Checkpoints)
$libPath = Join-Path (Split-Path $PSScriptRoot -Parent) "_shared\10-checkpoint-lib.ps1"
if (Test-Path -LiteralPath $libPath) {
    . $libPath
    $jobId = if ($env:MAW_JOB_ID -and $env:MAW_JOB_ID -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$') {
        $env:MAW_JOB_ID
    } else {
        "autogate-" + (Get-Date -Format 'yyyyMMdd')
    }
    $workDir = if ($Context -and $Context.project) {
        [string]$Context.project
    } elseif ($Context -and $Context.workdir) {
        [string]$Context.workdir
    } else {
        $env:MAW_PROJECT
    }
    $round = if ($Context -and $Context.round) { $Context.round } else { $null }
    if ($workDir) {
        $label = "before Auto-Gate round $round"
        $cpId = New-MawCheckpoint -WorkDir $workDir -JobKey $jobId -Event "round-start" -Label $label -Round $round
        if ($cpId) {
            Write-Output "[checkpoint] $cpId"
        }
    }
}
