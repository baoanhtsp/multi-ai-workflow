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
        [int]$Keep = 3
    )
    if (-not (Test-Path -LiteralPath $FilePath)) {
        return
    }
    try {
        $item = Get-Item -LiteralPath $FilePath -ErrorAction Stop
        if ($item.Length -lt $MaxBytes) {
            return
        }
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
    } catch {
        # Best-effort rotation
    }
}

function Quote-CmdArg {
    param([string]$Value)
    return '"' + ($Value -replace '"', '""') + '"'
}

function Get-ChildNodeProcess {
    param([int]$WrapperPid, [int]$TargetPort)
    $listenPids = Get-ListeningProcessIds -TargetPort $TargetPort
    if ($listenPids.Count -gt 0) {
        $p = Get-Process -Id $listenPids[0] -ErrorAction SilentlyContinue
        if ($p) { return $p }
    }
    try {
        $cim = Get-CimInstance Win32_Process -Filter "ParentProcessId = $WrapperPid AND Name = 'node.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cim -and $cim.ProcessId) {
            $p = Get-Process -Id ([int]$cim.ProcessId) -ErrorAction SilentlyContinue
            if ($p) { return $p }
        }
    } catch {}
    return $null
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

    $nodeArgs = @((Quote-CmdArg $serverMain), "--port", "$Port")
    if ($ProjectsRoot -and $ProjectsRoot.Trim() -ne "") {
        $nodeArgs += @("--projects-root", (Quote-CmdArg $ProjectsRoot.Trim()))
    }

    if (-not (Test-Path -LiteralPath $logsDir)) {
        New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    }
    Rotate-MawLogFile -FilePath $serverLog
    Rotate-MawLogFile -FilePath $outLog
    Rotate-MawLogFile -FilePath $errLog

    Write-Host "[Mission Control] Starting Node.js ($nodeVerRaw) server on $dashboardUrl ..." -ForegroundColor Cyan
    Write-Host "[Mission Control] Logs: $serverLog | stdout: $outLog | stderr: $errLog" -ForegroundColor DarkGray
    # Launch via ShellExecute (no -RedirectStandard*) so cmd.exe/node.exe do not inherit caller stdout/stderr pipe handles (H7)
    $cmdInner = "$(Quote-CmdArg $nodeCmd.Source) $($nodeArgs -join ' ') 1>>$(Quote-CmdArg $outLog) 2>>$(Quote-CmdArg $errLog)"
    $cmdArgLine = "/d /s /c `"$cmdInner`""
    $wrapperProc = Start-Process -FilePath $env:ComSpec -ArgumentList $cmdArgLine -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru

    $nodeProc = $null
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (-not $nodeProc) {
            $nodeProc = Get-ChildNodeProcess -WrapperPid $wrapperProc.Id -TargetPort $Port
        }
        if (Test-DashboardReady -Url $statusUrl) {
            if (-not $nodeProc) {
                $nodeProc = Get-ChildNodeProcess -WrapperPid $wrapperProc.Id -TargetPort $Port
            }
            $ready = $true
            break
        }
        $wrapperProc.Refresh()
        if ($wrapperProc.HasExited) {
            $deadPid = if ($nodeProc) { $nodeProc.Id } else { $wrapperProc.Id }
            throw "Mission Control server process (PID $deadPid) exited prematurely with code $($wrapperProc.ExitCode)."
        }
        if ($nodeProc) {
            $nodeProc.Refresh()
            if ($nodeProc.HasExited) {
                throw "Mission Control server process (PID $($nodeProc.Id)) exited prematurely with code $($nodeProc.ExitCode)."
            }
        }
    }

    if (-not $ready) {
        if ($nodeProc) {
            try { Stop-Process -Id $nodeProc.Id -Force -ErrorAction SilentlyContinue } catch {}
        }
        try { Stop-Process -Id $wrapperProc.Id -Force -ErrorAction SilentlyContinue } catch {}
        throw "Mission Control server on $dashboardUrl did not become ready within 10 seconds."
    }
    $onlinePid = if ($nodeProc) { $nodeProc.Id } else {
        $listenPids = Get-ListeningProcessIds -TargetPort $Port
        if ($listenPids.Count -gt 0) { $listenPids[0] } else { $wrapperProc.Id }
    }
    Write-Host "[Mission Control] Server is ONLINE (PID $onlinePid) -> $dashboardUrl" -ForegroundColor Green
} else {
    Write-Host "[Mission Control] Server is already running -> $dashboardUrl" -ForegroundColor Green
}

if (-not $NoBrowser) {
    Start-Process $dashboardUrl | Out-Null
}
exit 0
