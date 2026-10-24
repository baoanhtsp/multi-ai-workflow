# Hook: before-agent/10-checkpoint.ps1 (Multi-AI Workflow S1 Checkpoints)
$libPath = Join-Path (Split-Path $PSScriptRoot -Parent) "_shared\10-checkpoint-lib.ps1"
if (Test-Path -LiteralPath $libPath) {
    . $libPath
    $jobId = if ($env:MAW_JOB_ID -and $env:MAW_JOB_ID -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$') {
        $env:MAW_JOB_ID
    } else {
        "agent-" + (Get-Date -Format 'yyyyMMdd')
    }
    $workDir = if ($Context -and $Context.workdir) {
        [string]$Context.workdir
    } elseif ($Context -and $Context.project) {
        [string]$Context.project
    } else {
        $env:MAW_PROJECT
    }
    $agent = if ($Context -and $Context.agent) { [string]$Context.agent } else { "" }
    $role = if ($Context -and $Context.role) { [string]$Context.role } else { "" }
    if ($workDir) {
        $label = "before $agent as $role"
        $cpId = New-MawCheckpoint -WorkDir $workDir -JobKey $jobId -Event "before-agent" -Label $label -Agent $agent -Role $role
        if ($cpId) {
            Write-Output "[checkpoint] $cpId"
        }
    }
}
