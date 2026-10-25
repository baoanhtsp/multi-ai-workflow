<#
.SYNOPSIS
    Starts or stops the Multi-AI Mission Control Dashboard Server (Node.js 24 + native TypeScript).
.PARAMETER Port
    TCP port on 127.0.0.1 (default: 4317).
.PARAMETER ProjectsRoot
    Optional root directory containing allowed project subdirectories.
.PARAMETER Stop
    Stops any running Mission Control server listening on the specified port.
.PARAMETER NoBrowser
    Do not open the default web browser after the server is ready.
#>
param(
    [int]$Port = 4317,
    [string]$ProjectsRoot = "",
    [switch]$Stop,
    [switch]$NoBrowser,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs = @()
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Support POSIX-style flags (--stop, --no-browser, --port, --projects-root) if passed
for ($i = 0; $i -lt $RemainingArgs.Count; $i++) {
    $arg = $RemainingArgs[$i]
    switch -Regex ($arg) {
        '^--stop$' { $Stop = $true }
        '^--no-browser$' { $NoBrowser = $true }
        '^--port$' {
            if ($i + 1 -lt $RemainingArgs.Count) {
                $Port = [int]$RemainingArgs[$i + 1]
                $i++
            }
        }
        '^--projects-root$' {
            if ($i + 1 -lt $RemainingArgs.Count) {
                $ProjectsRoot = [string]$RemainingArgs[$i + 1]
                $i++
            }
        }
    }
}

function Get-ListeningProcessIds {
    param([int]$TargetPort)
    $pids = @()
    try {
        $conns = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue
        if ($conns) {
            $pids = @($conns | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 })
        }
    } catch {
        # Fallback to netstat if Get-NetTCPConnection is unavailable
    }
    return $pids
}

if ($Stop) {
    $listeningPids = Get-ListeningProcessIds -TargetPort $Port
    if ($listeningPids.Count -eq 0) {
        Write-Host "[Mission Control] No server is currently listening on 127.0.0.1:$Port." -ForegroundColor Yellow
        exit 0
    }
    foreach ($procId in $listeningPids) {
        try {
            Stop-Process -Id $procId -Force -ErrorAction Stop
            Write-Host "[Mission Control] Stopped server process PID $procId on 127.0.0.1:$Port." -ForegroundColor Green
        } catch {
            Write-Warning "Failed to stop PID ${procId}: $($_.Exception.Message)"
        }
    }
    exit 0
}

# 1. Verify Node.js >= 22.18
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error "Node.js is not installed or not in PATH. Mission Control v3.0 requires Node.js >= 22.18 (Node 24 LTS recommended)."
    exit 1
}

$nodeVerRaw = (& $nodeCmd.Source --version 2>$null | Out-String).Trim()
if ($nodeVerRaw -match '^v?(\d+)\.(\d+)\.(\d+)') {
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 18)) {
        Write-Error "Node.js $nodeVerRaw is too old. Mission Control v3.0 requires Node.js >= 22.18 (native TypeScript support)."
        exit 1
    }
} else {
    Write-Error "Unable to parse Node.js version: '$nodeVerRaw'"
    exit 1
}

# 2. Locate server/main.ts
$candidateRoots = @(
    $PSScriptRoot
)
if ($env:MAW_REPO_ROOT) {
    $candidateRoots += $env:MAW_REPO_ROOT
}
$candidateRoots += "C:\laragon\www\multi-ai-workflow"

$repoRoot = $null
$serverMain = $null
foreach ($cand in $candidateRoots) {
    if ($cand) {
        $testMain = Join-Path $cand "server\main.ts"
        if (Test-Path -LiteralPath $testMain) {
            $repoRoot = (Resolve-Path -LiteralPath $cand).Path
            $serverMain = (Resolve-Path -LiteralPath $testMain).Path
            break
        }
    }
}

if (-not $serverMain) {
    Write-Error "Could not locate server\main.ts relative to '$PSScriptRoot'. Set MAW_REPO_ROOT or run from repository root."
    exit 1
}

$dashboardUrl = "http://127.0.0.1:$Port/"
$statusUrl    = "http://127.0.0.1:$Port/api?action=status"

$mawHome = if ($env:MAW_HOME -and $env:MAW_HOME.Trim() -ne "") {
    $env:MAW_HOME.Trim()
} else {
    Join-Path $env:USERPROFILE ".maw"
}
$logsDir   = Join-Path $mawHome "logs"
$serverLog = Join-Path $logsDir "server.log"
$outLog    = Join-Path $logsDir "server.out.log"
$errLog    = Join-Path $logsDir "server.err.log"

function Rotate-MawLogFile {
    param(
        [string]$FilePath,
        [long]$MaxBytes = 5242880,
        [int]$Keep = 3,
        [switch]$ArchiveForStartProcess
    )
    if (-not (Test-Path -LiteralPath $FilePath)) {
        return
    }
    try {
        $item = Get-Item -LiteralPath $FilePath -ErrorAction Stop
        if ($item.Length -le 0) {
            return
        }
        $rot1 = "$FilePath.1"
        $rot1Len = if (Test-Path -LiteralPath $rot1) { (Get-Item -LiteralPath $rot1).Length } else { 0 }

        # Rotate .1 -> .2 -> .3 when current file >= 5 MB, or when archiving into .1 would exceed 5 MB
        if ($item.Length -ge $MaxBytes -or ($ArchiveForStartProcess -and ($rot1Len + $item.Length) -ge $MaxBytes)) {
            for ($i = $Keep; $i -ge 1; $i--) {
                $src = if ($i -eq 1) { $FilePath } else { "$FilePath.$($i - 1)" }
                $dst = "$FilePath.$i"
                if (Test-Path -LiteralPath $src) {
                    if (Test-Path -LiteralPath $dst) {
                        Remove-Item -LiteralPath $dst -Force -ErrorAction SilentlyContinue
                    }
                    Move-Item -LiteralPath $src -Destination $dst -Force -ErrorAction SilentlyContinue
                }
            }
        } elseif ($ArchiveForStartProcess) {
            # Start-Process -RedirectStandardOutput overwrites target; append prior log to .1 so history is retained
            $bytes = [System.IO.File]::ReadAllBytes($FilePath)
            $fs = [System.IO.File]::Open($rot1, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
            try {
                $fs.Write($bytes, 0, $bytes.Length)
            } finally {
                $fs.Close()
            }
        }
    } catch {
        # Best-effort rotation
    }
}

function Test-DashboardReady {
    param([string]$Url)
    try {
        $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        return ($resp.StatusCode -eq 200)
    } catch {
        return $false
    }
}

# 3. Check if already running on $Port
if (-not (Test-DashboardReady -Url $statusUrl)) {
    $existingPids = Get-ListeningProcessIds -TargetPort $Port
    if ($existingPids.Count -gt 0) {
        Write-Error "Port $Port is already in use by PID $($existingPids -join ', '), and it did not respond to $statusUrl."
        exit 1
    }

    $qMain = if ($serverMain -match '\s') { '"' + $serverMain + '"' } else { $serverMain }
    $nodeArgs = @($qMain, "--port", "$Port")
    if ($ProjectsRoot -and $ProjectsRoot.Trim() -ne "") {
        $trimmedRoot = $ProjectsRoot.Trim()
        $qRoot = if ($trimmedRoot -match '\s') { '"' + $trimmedRoot + '"' } else { $trimmedRoot }
        $nodeArgs += @("--projects-root", $qRoot)
    }

    if (-not (Test-Path -LiteralPath $logsDir)) {
        New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    }
    Rotate-MawLogFile -FilePath $serverLog
    Rotate-MawLogFile -FilePath $outLog -ArchiveForStartProcess
    Rotate-MawLogFile -FilePath $errLog -ArchiveForStartProcess

    Write-Host "[Mission Control] Starting Node.js ($nodeVerRaw) server on $dashboardUrl ..." -ForegroundColor Cyan
    Write-Host "[Mission Control] Logs: $serverLog | stdout: $outLog | stderr: $errLog" -ForegroundColor DarkGray
    $proc = Start-Process -FilePath $nodeCmd.Source -ArgumentList $nodeArgs -WorkingDirectory $repoRoot -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru

    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Test-DashboardReady -Url $statusUrl) {
            $ready = $true
            break
        }
        if ($proc.HasExited) {
            throw "Mission Control server process (PID $($proc.Id)) exited prematurely with code $($proc.ExitCode)."
        }
    }

    if (-not $ready) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
        throw "Mission Control server on $dashboardUrl did not become ready within 10 seconds."
    }
    Write-Host "[Mission Control] Server is ONLINE (PID $($proc.Id)) -> $dashboardUrl" -ForegroundColor Green
} else {
    Write-Host "[Mission Control] Server is already running -> $dashboardUrl" -ForegroundColor Green
}

if (-not $NoBrowser) {
    Start-Process $dashboardUrl | Out-Null
}
exit 0
