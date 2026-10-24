# Hook: job-start/10-checkpoint.ps1 (Multi-AI Workflow S1 Checkpoints)
$libPath = Join-Path (Split-Path $PSScriptRoot -Parent) "_shared\10-checkpoint-lib.ps1"
if (Test-Path -LiteralPath $libPath) {
    . $libPath
    $jobId = if ($Context -and $Context.job_id) { [string]$Context.job_id } else { "" }
    $workDir = if ($Context -and $Context.project) { [string]$Context.project } else { "" }
    $agent = if ($Context -and $Context.agent) { [string]$Context.agent } else { "" }
    $role = if ($Context -and $Context.role) { [string]$Context.role } else { "" }
    if ($jobId -and $workDir) {
        $label = "before job $jobId ($agent/$role)"
        $cpId = New-MawCheckpoint -WorkDir $workDir -JobKey $jobId -Event "job-start" -Label $label -Agent $agent -Role $role
        if ($cpId) {
            Write-Output "[checkpoint] $cpId"
        }
    }
}
