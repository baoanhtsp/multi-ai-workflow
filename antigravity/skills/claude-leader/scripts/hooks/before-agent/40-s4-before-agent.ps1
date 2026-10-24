# 40-s4-before-agent.ps1 - S4 Before-Agent Hook (SPEC §9.0 / S4 Design §0.2, §1.3, §2.3)
try {
    $runtimePath = ""
    if ($env:MAW_S4_RUNTIME -and (Test-Path -LiteralPath $env:MAW_S4_RUNTIME -PathType Leaf)) {
        $runtimePath = $env:MAW_S4_RUNTIME
    } elseif ($env:MAW_HOME) {
        $cand = Join-Path $env:MAW_HOME "data\policy\runtime.json"
        if (Test-Path -LiteralPath $cand -PathType Leaf) { $runtimePath = $cand }
    }

    if (-not $runtimePath) {
        $userHome = if ($env:USERPROFILE) { $env:USERPROFILE } else { "~" }
        $cand = Join-Path $userHome ".maw\data\policy\runtime.json"
        if (Test-Path -LiteralPath $cand -PathType Leaf) { $runtimePath = $cand }
    }

    if (-not $runtimePath) {
        Write-Host "[S4] runtime not found"
        return @{ Block = $false; Reason = "" }
    }

    $runtime = Get-Content -LiteralPath $runtimePath -Raw -ErrorAction Stop | ConvertFrom-Json
    $node = if ($runtime.node) { [string]$runtime.node } else { "node" }
    $repoRoot = if ($runtime.repo_root) { [string]$runtime.repo_root } else { "" }
    $cli = if ($repoRoot) { Join-Path $repoRoot "server\features\policy\hook-cli.ts" } else { "" }

    if (-not $cli -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        Write-Host "[S4] runtime not found"
        return @{ Block = $false; Reason = "" }
    }

    $ctxCopy = @{}
    if ($Context -is [System.Collections.IDictionary]) {
        foreach ($k in $Context.Keys) {
            $ctxCopy[$k] = $Context[$k]
        }
    }
    if ($env:MAW_JOB_ID -and -not $ctxCopy.ContainsKey("job_id")) { $ctxCopy["job_id"] = $env:MAW_JOB_ID }
    if ($env:MAW_JOB_MODE -and -not $ctxCopy.ContainsKey("mode")) { $ctxCopy["mode"] = $env:MAW_JOB_MODE }
    if ($env:MAW_JOB_ROLE -and -not $ctxCopy.ContainsKey("role")) { $ctxCopy["role"] = $env:MAW_JOB_ROLE }
    if ($env:MAW_JOB_PROJECT -and -not $ctxCopy.ContainsKey("project")) { $ctxCopy["project"] = $env:MAW_JOB_PROJECT }
    if ($env:MAW_S4_AUDIT_OFFSET -and -not $ctxCopy.ContainsKey("audit_offset")) { $ctxCopy["audit_offset"] = $env:MAW_S4_AUDIT_OFFSET }
    if ($env:MAW_TEAM_RUN_ID -and -not $ctxCopy.ContainsKey("team_run_id")) { $ctxCopy["team_run_id"] = $env:MAW_TEAM_RUN_ID }
    if ($env:WorkDir -and -not $ctxCopy.ContainsKey("workdir")) { $ctxCopy["workdir"] = $env:WorkDir }

    $json = $ctxCopy | ConvertTo-Json -Compress
    $rawOut = $json | & $node @($cli, "before-agent")
    $outText = if ($rawOut -is [array]) { ($rawOut -join "`n").Trim() } else { [string]$rawOut.Trim() }

    if (-not $outText) {
        return @{ Block = $false; Reason = "" }
    }

    $parsed = $outText | ConvertFrom-Json
    if ($parsed.lines) {
        foreach ($line in $parsed.lines) {
            if ($line) { Write-Host $line }
        }
    }

    if ($parsed.block) {
        return @{ Block = $true; Reason = [string]$parsed.reason }
    }
} catch {
    Write-Host "[S4] hook error: $($_.Exception.Message)"
}

return @{ Block = $false; Reason = "" }
