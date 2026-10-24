# 30-health.ps1 — Pre-flight health and readiness check before agent dispatch (SPEC §9.1 S3, B2+B3)
# Windows PowerShell 5.1 compatible, fails open on unexpected errors.

try {
    if ($env:MAW_SKIP_HEALTH -eq '1') {
        return @{ Block = $false; Reason = "" }
    }

    if ($null -eq $Context -or -not $Context.agent) {
        return @{ Block = $false; Reason = "" }
    }

    $normAgent = [string]$Context.agent.ToString().Trim().ToLowerInvariant()
    if (-not $normAgent) {
        return @{ Block = $false; Reason = "" }
    }

    $mawHome = if ($env:MAW_HOME -and $env:MAW_HOME.Trim()) {
        $env:MAW_HOME.Trim()
    } else {
        $uProf = if ($env:USERPROFILE -and $env:USERPROFILE.Trim()) { $env:USERPROFILE.Trim() } else { [Environment]::GetFolderPath('UserProfile') }
        Join-Path $uProf ".maw"
    }

    $cacheFile = Join-Path $mawHome "data\health\cache.json"
    $hasFreshCache = $false

    if (Test-Path -LiteralPath $cacheFile -PathType Leaf) {
        try {
            $rawJson = Get-Content -LiteralPath $cacheFile -Raw -Encoding UTF8
            $cacheObj = $rawJson | ConvertFrom-Json
            if ($cacheObj -and $cacheObj.agents -and $cacheObj.agents.PSObject.Properties[$normAgent]) {
                $agentCache = $cacheObj.agents.$normAgent
                if ($agentCache.checked_at) {
                    $checkedTime = [DateTime]::Parse($agentCache.checked_at.ToString()).ToUniversalTime()
                    $nowUtc = [DateTime]::UtcNow
                    $ageMinutes = ($nowUtc - $checkedTime).TotalMinutes
                    if ($ageMinutes -ge 0 -and $ageMinutes -le 10) {
                        $hasFreshCache = $true
                        if ($agentCache.status -eq 'error') {
                            $label = if ($agentCache.label) { $agentCache.label } else { $normAgent }
                            $reason = if ($agentCache.reason) { $agentCache.reason } else { "Agent status is error" }
                            $fixCmd = ""
                            if ($agentCache.fix -and $agentCache.fix.command) {
                                $fixCmd = $agentCache.fix.command
                            }
                            $fixPart = if ($fixCmd) { " Fix: $fixCmd (or 'Đăng nhập lại' in the dashboard)." } else { " (or 'Đăng nhập lại' in the dashboard)." }
                            return @{
                                Block  = $true
                                Reason = "$($label): $reason.$fixPart"
                                Agent  = $normAgent
                                Kind   = 'health'
                            }
                        }
                        # Fresh cache and not error -> allow
                        return @{ Block = $false; Reason = "" }
                    }
                }
            }
        } catch {
            # Ignore cache read errors, fall through to minimal probe
        }
    }

    # No fresh cache entry: perform minimal local probe for that agent only
    $scriptsDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    $claudeLeaderDir = Split-Path -Parent $scriptsDir
    $regFile = Join-Path $claudeLeaderDir "agents.json"
    if (-not (Test-Path -LiteralPath $regFile -PathType Leaf)) {
        $regFile = Join-Path $scriptsDir "agents.json"
    }

    $statusCmd = @()
    $agentCmd = $normAgent
    $label = $normAgent
    $agentFound = $null

    if (Test-Path -LiteralPath $regFile -PathType Leaf) {
        try {
            $regObj = (Get-Content -LiteralPath $regFile -Raw -Encoding UTF8) | ConvertFrom-Json
            if ($regObj -and $regObj.agents) {
                foreach ($a in $regObj.agents) {
                    if ($a.id -and $a.id.ToString().ToLowerInvariant() -eq $normAgent) {
                        $agentFound = $a
                        break
                    }
                }
            }
        } catch {
            # Ignore registry parse errors
        }
    }

    # User overrides from $mawHome\agents.json (SPEC §7.1 user status_cmd wins)
    $userRegFile = Join-Path $mawHome "agents.json"
    if (Test-Path -LiteralPath $userRegFile -PathType Leaf) {
        try {
            $userRegObj = (Get-Content -LiteralPath $userRegFile -Raw -Encoding UTF8) | ConvertFrom-Json
            if ($userRegObj -and $userRegObj.agents) {
                foreach ($ua in $userRegObj.agents) {
                    if ($ua.id -and $ua.id.ToString().ToLowerInvariant() -eq $normAgent) {
                        if ($null -eq $agentFound) {
                            $agentFound = $ua
                        } else {
                            if ($ua.label) { $agentFound.label = $ua.label }
                            if ($ua.status_cmd) { $agentFound.status_cmd = $ua.status_cmd }
                            if ($ua.cli) { $agentFound.cli = $ua.cli }
                            if ($ua.detect) { $agentFound.detect = $ua.detect }
                        }
                        break
                    }
                }
            }
        } catch {
            # Ignore user registry parse errors
        }
    }

    if ($null -ne $agentFound) {
        $label = if ($agentFound.label) { $agentFound.label } else { $normAgent }
        if ($agentFound.detect -and $agentFound.detect.command) {
            $agentCmd = $agentFound.detect.command
        } elseif ($agentFound.cli -and $agentFound.cli.command) {
            $agentCmd = $agentFound.cli.command
        }
        if ($agentFound.status_cmd) {
            $statusCmd = @($agentFound.status_cmd)
        }
    }

    # Check installed
    $isInstalled = $false
    if ($normAgent -eq 'claude') {
        if (Get-Command "claude.exe" -ErrorAction SilentlyContinue) {
            $isInstalled = $true
        } else {
            $uProf = if ($env:USERPROFILE -and $env:USERPROFILE.Trim()) { $env:USERPROFILE.Trim() } else { [Environment]::GetFolderPath('UserProfile') }
            $claudeBase = Join-Path $uProf "AppData\Roaming\Claude\claude-code"
            if (Test-Path -LiteralPath $claudeBase) {
                $found = Get-ChildItem -LiteralPath $claudeBase -Filter "claude.exe" -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($null -ne $found) {
                    $isInstalled = $true
                }
            }
        }
    } elseif ($normAgent -eq 'antigravity') {
        $uProf = if ($env:USERPROFILE -and $env:USERPROFILE.Trim()) { $env:USERPROFILE.Trim() } else { [Environment]::GetFolderPath('UserProfile') }
        $bat = Join-Path $uProf ".gemini\antigravity\bin\agentapi.bat"
        $isInstalled = Test-Path -LiteralPath $bat -PathType Leaf
    } else {
        if (Get-Command $agentCmd -ErrorAction SilentlyContinue) {
            $isInstalled = $true
        } else {
            $uProf = if ($env:USERPROFILE -and $env:USERPROFILE.Trim()) { $env:USERPROFILE.Trim() } else { [Environment]::GetFolderPath('UserProfile') }
            $shim = Join-Path $uProf "AppData\Roaming\npm\$agentCmd.cmd"
            if (Test-Path -LiteralPath $shim -PathType Leaf) {
                $isInstalled = $true
            }
        }
    }

    if (-not $isInstalled) {
        return @{
            Block  = $true
            Reason = "$label is not installed."
            Agent  = $normAgent
            Kind   = 'health'
        }
    }

    # If status_cmd is configured, execute minimal check
    if ($statusCmd.Count -gt 0) {
        $bin = $statusCmd[0]
        $cmdArgs = if ($statusCmd.Count -gt 1) { $statusCmd[1..($statusCmd.Count - 1)] } else { @() }

        # Check if Invoke-NativeProcess is available, otherwise run directly
        $out = ""
        $exitCode = 0
        try {
            if (Get-Command "Invoke-NativeProcess" -ErrorAction SilentlyContinue) {
                $procRes = Invoke-NativeProcess -FilePath $bin -ArgumentList $cmdArgs -TimeoutSeconds 5
                $out = "$($procRes.StdOut)`n$($procRes.StdErr)"
                $exitCode = $procRes.ExitCode
            } else {
                $pinfo = New-Object System.Diagnostics.ProcessStartInfo
                $pinfo.FileName = $bin
                $pinfo.Arguments = ($cmdArgs -join " ")
                $pinfo.RedirectStandardOutput = $true
                $pinfo.RedirectStandardError = $true
                $pinfo.UseShellExecute = $false
                $pinfo.CreateNoWindow = $true
                $p = [System.Diagnostics.Process]::Start($pinfo)
                if ($p.WaitForExit(5000)) {
                    $out = "$($p.StandardOutput.ReadToEnd())`n$($p.StandardError.ReadToEnd())"
                    $exitCode = $p.ExitCode
                } else {
                    try { $p.Kill() } catch {}
                    $exitCode = 124
                }
            }

            if ($exitCode -ne 0 -and $out -match 'not (logged|signed) in|login required|unauthenticated|401') {
                return @{
                    Block  = $true
                    Reason = "$($label): Not logged in."
                    Agent  = $normAgent
                    Kind   = 'health'
                }
            }
        } catch {
            # Fail open on unexpected probe failure
        }
    }

    return @{ Block = $false; Reason = "" }
} catch {
    # Fail open on unexpected hook errors
    return @{ Block = $false; Reason = "" }
}
