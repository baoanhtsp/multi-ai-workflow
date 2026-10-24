# 30-timeline.ps1 — job-finish event logger for timeline (SPEC §9.1 S3, N8)
# Windows PowerShell 5.1 compatible, never throws.

try {
    if ($null -eq $Context) {
        return @{ Block = $false; Reason = "" }
    }

    $mawHome = if ($env:MAW_HOME -and $env:MAW_HOME.Trim()) {
        $env:MAW_HOME.Trim()
    } else {
        $uProf = if ($env:USERPROFILE -and $env:USERPROFILE.Trim()) { $env:USERPROFILE.Trim() } else { [Environment]::GetFolderPath('UserProfile') }
        Join-Path $uProf ".maw"
    }

    $dataDir = Join-Path $mawHome "data\timeline"
    if (-not (Test-Path -LiteralPath $dataDir -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $dataDir -Force -ErrorAction SilentlyContinue)
    }

    $eventsFile = Join-Path $dataDir "events.jsonl"
    $nowIso = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

    $exitCode = if ($null -ne $Context.exit_code) { [int]$Context.exit_code } else { $null }
    $status = if ($exitCode -eq 0) { "DONE" } else { "FAILED" }

    $eventObj = [ordered]@{
        ts        = $nowIso
        event     = "job-finish"
        job_id    = [string]$Context.job_id
        mode      = [string]$Context.mode
        agent     = [string]$Context.agent
        role      = [string]$Context.role
        project   = [string]$Context.project
        exit_code = $exitCode
        status    = $status
        end       = $nowIso
    }

    $line = ($eventObj | ConvertTo-Json -Compress) + "`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::AppendAllText($eventsFile, $line, $utf8NoBom)
} catch {
    # Never throw
}

return @{ Block = $false; Reason = "" }
