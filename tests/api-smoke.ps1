$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Net.Http

$repoRoot = Split-Path -Parent $PSScriptRoot
$serverMain = Join-Path $repoRoot "server\main.ts"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Error "Could not locate node.exe in PATH"
    exit 1
}
$nodeExe = $nodeCmd.Source

$origTmp  = $env:TMP
$origTemp = $env:TEMP
$origMawHome = $env:MAW_HOME
$origUserProfile = $env:USERPROFILE
$origMawTest = $env:MAW_TEST
$origSkipHealth = $env:MAW_SKIP_HEALTH
$baseTemp = if ($origTemp) { $origTemp } else { [System.IO.Path]::GetTempPath() }
$spaceTempDir = Join-Path $baseTemp ("maw smoke space " + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $spaceTempDir -Force | Out-Null

$smokeMawHome = Join-Path $spaceTempDir ".maw"
$smokeUserProfile = Join-Path $spaceTempDir "user-profile"
New-Item -ItemType Directory -Path $smokeMawHome -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $smokeUserProfile "AppData\Local\Microsoft\Windows\PowerShell\ScheduledJobs") -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $smokeUserProfile "AppData\Roaming\Microsoft\Windows\PowerShell") -Force | Out-Null
$smokeUserRegistry = @{
    version = 1
    agents  = @(
        @{
            id           = "fake-reviewer"
            label        = "Fake Smoke Reviewer"
            color        = "#10b981"
            enabled      = $true
            adapter      = "cli"
            detect       = @{ command = "powershell.exe"; version_args = @() }
            models       = @("auto")
            efforts      = @()
            capabilities = @{ write = $true; review = $true; new_session = $false; sessions = $false; ide_send = $false }
            cli          = @{
                command     = "powershell.exe"
                prompt_via  = "stdin"
                args        = @("-NoProfile", "-Command", "[void][Console]::In.ReadToEnd(); Write-Output 'Smoke council review passed.'; Write-Output 'SCORE: 9.5/10'; Write-Output 'VERDICT: APPROVED'")
                role_args   = @{}
                model_args  = @()
                effort_args = @()
                output      = "text"
            }
        },
        @{
            id           = "uninstalled-smoke-ai"
            label        = "Uninstalled Smoke AI"
            color        = "#ef4444"
            enabled      = $true
            adapter      = "cli"
            detect       = @{ command = "uninstalled-smoke-cli-99999"; version_args = @("--version") }
            models       = @("auto")
            efforts      = @()
            capabilities = @{ write = $true; review = $true; new_session = $false; sessions = $false; ide_send = $false }
            cli          = @{
                command     = "uninstalled-smoke-cli-99999"
                prompt_via  = "stdin"
                args        = @()
                role_args   = @{}
                model_args  = @()
                effort_args = @()
                output      = "text"
            }
        }
    )
} | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText((Join-Path $smokeMawHome "agents.json"), $smokeUserRegistry, (New-Object System.Text.UTF8Encoding($false)))

$port = Get-Random -Minimum 18100 -Maximum 18999
$rootUrl = "http://127.0.0.1:$port"
$baseUrl = "http://127.0.0.1:$port/api"

function Start-SmokeNodeServer {
    param(
        [string]$ProjectsRootArg = ""
    )
    $env:TMP             = $spaceTempDir
    $env:TEMP            = $spaceTempDir
    $env:MAW_HOME        = $smokeMawHome
    $env:USERPROFILE     = $smokeUserProfile
    $env:MAW_TEST        = "1"
    $env:MAW_SKIP_HEALTH = "1"
    try {
        $qMain = if ($serverMain -match '\s') { '"' + $serverMain + '"' } else { $serverMain }
        $argList = @($qMain, "--port", "$port")
        if ($ProjectsRootArg) {
            $qRoot = if ($ProjectsRootArg -match '\s') { '"' + $ProjectsRootArg + '"' } else { $ProjectsRootArg }
            $argList += @("--projects-root", $qRoot)
        }
        return Start-Process -FilePath $nodeExe -ArgumentList $argList -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden
    } finally {
        $env:TMP         = $origTmp
        $env:TEMP        = $origTemp
        $env:MAW_HOME    = $origMawHome
        $env:USERPROFILE = $origUserProfile
        if ($null -eq $origMawTest) { Remove-Item Env:\MAW_TEST -ErrorAction SilentlyContinue } else { $env:MAW_TEST = $origMawTest }
        if ($null -eq $origSkipHealth) { Remove-Item Env:\MAW_SKIP_HEALTH -ErrorAction SilentlyContinue } else { $env:MAW_SKIP_HEALTH = $origSkipHealth }
    }
}

Write-Host "[api-smoke] Starting Node.js v4.0 server using $nodeExe on 127.0.0.1:$port (TMP='$spaceTempDir')..." -ForegroundColor Cyan
$serverProc = Start-SmokeNodeServer

$httpClient = New-Object System.Net.Http.HttpClient
$httpClient.Timeout = [TimeSpan]::FromSeconds(25)

function Invoke-SmokeRequest {
    param(
        [string]$Method,
        [string]$Url,
        [hashtable]$Headers = @{},
        [string]$ContentType = "application/json",
        [string]$Body = ""
    )

    $httpMethod = New-Object System.Net.Http.HttpMethod($Method)
    $req = New-Object System.Net.Http.HttpRequestMessage($httpMethod, $Url)

    foreach ($k in $Headers.Keys) {
        if ($k -ieq "Host") {
            $req.Headers.Host = [string]$Headers[$k]
        } else {
            [void]$req.Headers.TryAddWithoutValidation($k, [string]$Headers[$k])
        }
    }

    if ($Method -eq "POST") {
        $byteContent = New-Object System.Net.Http.ByteArrayContent(,[System.Text.Encoding]::UTF8.GetBytes($Body))
        $byteContent.Headers.Remove("Content-Type") | Out-Null
        [void]$byteContent.Headers.TryAddWithoutValidation("Content-Type", $ContentType)
        $req.Content = $byteContent
    }

    $resp = $httpClient.SendAsync($req).GetAwaiter().GetResult()
    $respBody = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $code = [int]$resp.StatusCode
    $respHeaders = @{}
    foreach ($h in $resp.Headers) {
        $respHeaders[$h.Key.ToLowerInvariant()] = ($h.Value -join ", ")
    }
    foreach ($h in $resp.Content.Headers) {
        $respHeaders[$h.Key.ToLowerInvariant()] = ($h.Value -join ", ")
    }
    $resp.Dispose()
    $req.Dispose()

    return @{
        StatusCode = $code
        Headers    = $respHeaders
        Body       = $respBody
    }
}

function Wait-SmokeServerReady {
    Start-Sleep -Milliseconds 250
    $ready = $false
    $lastErr = ""
    for ($i = 0; $i -lt 30; $i++) {
        try {
            $r = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=status"
            if ($r.StatusCode -eq 200) {
                $ready = $true
                break
            }
            $lastErr = "HTTP $($r.StatusCode): $($r.Body)"
        } catch {
            $lastErr = $_.Exception.ToString()
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $ready) {
        throw "Node server on 127.0.0.1:$port did not become ready in time. Last error: $lastErr"
    }
}

function Invoke-RawTcpPathRequest {
    param(
        [int]$Port,
        [string]$RawPath
    )
    $client = New-Object System.Net.Sockets.TcpClient("127.0.0.1", $Port)
    try {
        $stream = $client.GetStream()
        $reqText = "GET $RawPath HTTP/1.1`r`nHost: 127.0.0.1:$Port`r`nConnection: close`r`n`r`n"
        $reqBytes = [System.Text.Encoding]::ASCII.GetBytes($reqText)
        $stream.Write($reqBytes, 0, $reqBytes.Length)
        $stream.Flush()
        $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
        $rawResp = $reader.ReadToEnd()
        if ($rawResp -match '^HTTP/1\.[01]\s+(\d{3})') {
            return [int]$Matches[1]
        }
        return 0
    } finally {
        $client.Close()
    }
}

try {
    Wait-SmokeServerReady

    # 1. GET status -> 200, api_version 4.0, features contains 'agents', 'sse', 'registry', status.agents lists all 6 shipped agents with installed flags
    $r1 = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=status"
    if ($r1.StatusCode -ne 200) { throw "Test 1 failed: expected 200, got $($r1.StatusCode)" }
    $j1 = $r1.Body | ConvertFrom-Json
    if (-not $j1.ok) { throw "Test 1 failed: ok is false" }
    if ($j1.api_version -ne "4.0") { throw "Test 1 failed: expected api_version 4.0, got $($j1.api_version)" }
    if (@($j1.features) -notcontains "agents") { throw "Test 1 failed: status.features does not contain 'agents'" }
    if (@($j1.features) -notcontains "sse") { throw "Test 1 failed: status.features does not contain 'sse'" }
    if (@($j1.features) -notcontains "registry") { throw "Test 1 failed: status.features does not contain 'registry'" }
    if (-not $j1.agents -or @($j1.agents).Count -lt 6) { throw "Test 1 failed: status.agents has fewer than 6 entries" }
    foreach ($shippedId in @("claude", "codex", "antigravity", "gemini", "cursor", "aider")) {
        $agObj = @($j1.agents | Where-Object { $_.id -eq $shippedId }) | Select-Object -First 1
        if (-not $agObj) {
            throw "Test 1 failed: status.agents missing shipped agent '$shippedId'"
        }
        if ($null -eq $agObj.installed -or ($agObj.installed -isnot [bool])) {
            throw "Test 1 failed: status.agents['$shippedId'].installed is not a boolean"
        }
    }
    if (-not $j1.tools.node.version) { throw "Test 1 failed: tools.node.version is missing" }
    $notifyProps = @($j1.notify_config.PSObject.Properties.Name)
    if ($notifyProps -contains "telegram_bot_token") {
        throw "Test 1 failed: notify_config leaked raw telegram_bot_token key!"
    }
    if ($notifyProps -notcontains "telegram_bot_token_set") {
        throw "Test 1 failed: notify_config missing telegram_bot_token_set!"
    }
    $auditProps = @($j1.audit.PSObject.Properties.Name)
    if ($auditProps -contains "estimated_tokens_saved") {
        throw "Test 1 failed: audit still contains fabricated estimated_tokens_saved!"
    }
    if ($auditProps -notcontains "avg_cost_per_call_usd") {
        throw "Test 1 failed: audit missing avg_cost_per_call_usd!"
    }
    Write-Host "  [PASS] 1. GET status -> 200, api_version 4.0, features=['agents','sse','registry'], 6 shipped agents with installed flags" -ForegroundColor Green

    # 1b. Wrong Host header -> 403 (DNS-rebinding guard, SPEC §3.0 & §6.2)
    $rHost = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=status" -Headers @{ "Host" = "evil.example.com" }
    if ($rHost.StatusCode -ne 403) { throw "Test 1b failed: wrong Host header expected 403, got $($rHost.StatusCode)" }
    Write-Host "  [PASS] 1b. Wrong Host header -> 403 (DNS-rebinding guard)" -ForegroundColor Green

    # 1c. GET / -> 200 dashboard HTML with Content-Security-Policy header (SPEC §3.0 & §6.2)
    $rIndex = Invoke-SmokeRequest -Method "GET" -Url "${rootUrl}/"
    if ($rIndex.StatusCode -ne 200) { throw "Test 1c failed: GET / expected 200, got $($rIndex.StatusCode)" }
    if (-not $rIndex.Headers["content-security-policy"] -or $rIndex.Headers["content-security-policy"] -notmatch "default-src 'self'") {
        throw "Test 1c failed: missing or invalid Content-Security-Policy header on GET /"
    }
    if ($rIndex.Body -notmatch "<!DOCTYPE html>") {
        throw "Test 1c failed: GET / did not return dashboard HTML"
    }
    Write-Host "  [PASS] 1c. GET / -> 200 dashboard HTML + Content-Security-Policy header" -ForegroundColor Green

    # 1d. Path traversal & source protection: GET /../SPEC.md and GET /server/main.ts -> 404 (SPEC §1 & §6.2)
    $rawTravStatus = Invoke-RawTcpPathRequest -Port $port -RawPath "/../SPEC.md"
    if ($rawTravStatus -ne 404) { throw "Test 1d failed: raw GET /../SPEC.md expected 404, got $rawTravStatus" }
    $rServerTs = Invoke-SmokeRequest -Method "GET" -Url "${rootUrl}/server/main.ts"
    if ($rServerTs.StatusCode -ne 404) { throw "Test 1d failed: GET /server/main.ts expected 404, got $($rServerTs.StatusCode)" }
    Write-Host "  [PASS] 1d. GET /../SPEC.md and GET /server/main.ts -> 404" -ForegroundColor Green

    $validBody = (@{ project_path = $repoRoot } | ConvertTo-Json -Compress)

    # 2. POST without X-MAW-Request -> 403
    $r2 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=spec_guard" -ContentType "application/json" -Body $validBody
    if ($r2.StatusCode -ne 403) { throw "Test 2 failed: POST without X-MAW-Request expected 403, got $($r2.StatusCode)" }
    Write-Host "  [PASS] 2. POST without X-MAW-Request -> 403" -ForegroundColor Green

    # 3. POST with Origin: null -> 403
    $r3 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=spec_guard" -Headers @{
        "X-MAW-Request" = "1"
        "Origin"        = "null"
    } -ContentType "application/json" -Body $validBody
    if ($r3.StatusCode -ne 403) { throw "Test 3 failed: POST with Origin: null expected 403, got $($r3.StatusCode)" }
    Write-Host "  [PASS] 3. POST with Origin: null -> 403" -ForegroundColor Green

    # 4. POST with Content-Type: text/plain; x=application/json -> 415
    $r4 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=spec_guard" -Headers @{
        "X-MAW-Request" = "1"
    } -ContentType "text/plain; x=application/json" -Body $validBody
    if ($r4.StatusCode -ne 415) { throw "Test 4 failed: POST with text/plain; x=application/json expected 415, got $($r4.StatusCode)" }
    Write-Host "  [PASS] 4. POST with text/plain; x=application/json -> 415" -ForegroundColor Green

    # 5. POST with foreign Origin -> 403
    $r5 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=spec_guard" -Headers @{
        "X-MAW-Request" = "1"
        "Origin"        = "http://evil.example.com"
    } -ContentType "application/json" -Body $validBody
    if ($r5.StatusCode -ne 403) { throw "Test 5 failed: POST with foreign Origin expected 403, got $($r5.StatusCode)" }
    Write-Host "  [PASS] 5. POST with foreign Origin -> 403" -ForegroundColor Green

    # 6. Valid spec_guard POST -> 200
    $r6 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=spec_guard" -Headers @{
        "X-MAW-Request" = "1"
        "Origin"        = "http://127.0.0.1:$port"
    } -ContentType "application/json; charset=utf-8" -Body $validBody
    if ($r6.StatusCode -ne 200) { throw "Test 6 failed: valid spec_guard POST expected 200, got $($r6.StatusCode) ($($r6.Body))" }
    $j6 = $r6.Body | ConvertFrom-Json
    if (-not $j6.ok) { throw "Test 6 failed: spec_guard ok is false" }
    Write-Host "  [PASS] 6. Valid POST spec_guard -> 200 (verdict: $($j6.verdict))" -ForegroundColor Green

    # 7. cancel_job on unknown id -> 404
    $cancelBody = (@{ job_id = "job_99999999_999999_deadbe" } | ConvertTo-Json -Compress)
    $r7 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=cancel_job" -Headers @{
        "X-MAW-Request" = "1"
    } -ContentType "application/json" -Body $cancelBody
    if ($r7.StatusCode -ne 404) { throw "Test 7 failed: cancel_job on unknown id expected 404, got $($r7.StatusCode)" }
    Write-Host "  [PASS] 7. POST cancel_job on unknown id -> 404" -ForegroundColor Green

    # 8. POST dispatch with mode: task -> 200 and command contains invoke-agent.ps1
    $taskBody = (@{
        mode         = "task"
        agent        = "claude"
        role         = "backend"
        project_path = $repoRoot
        prompt       = "Implement backend validation."
    } | ConvertTo-Json -Compress)
    $r8 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=dispatch" -Headers @{ "X-MAW-Request" = "1" } -Body $taskBody
    if ($r8.StatusCode -ne 200) { throw "Test 8 failed: dispatch mode=task expected 200, got $($r8.StatusCode) ($($r8.Body))" }
    $j8 = $r8.Body | ConvertFrom-Json
    if ($j8.command -notmatch 'invoke-agent\.ps1' -or $j8.command -notmatch "-Agent 'claude'" -or $j8.command -notmatch "-Role 'backend'") {
        throw "Test 8 failed: unexpected command $($j8.command)"
    }
    Write-Host "  [PASS] 8. POST dispatch mode=task -> 200 (invoke-agent.ps1)" -ForegroundColor Green

    # 9. POST dispatch with mode: team -> 200 and command contains invoke-agent.ps1 + -Role 'leader' + -Team
    $teamBody = (@{
        mode         = "team"
        agent        = "claude"
        team         = @{ backend = "antigravity"; frontend = "claude"; reviewer = "codex" }
        project_path = $repoRoot
        prompt       = "Coordinate full-stack feature."
    } | ConvertTo-Json -Compress)
    $r9 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=dispatch" -Headers @{ "X-MAW-Request" = "1" } -Body $teamBody
    if ($r9.StatusCode -ne 200) { throw "Test 9 failed: dispatch mode=team expected 200, got $($r9.StatusCode) ($($r9.Body))" }
    $j9 = $r9.Body | ConvertFrom-Json
    if ($j9.command -notmatch 'invoke-agent\.ps1' -or $j9.command -notmatch "-Role 'leader'" -or $j9.command -notmatch "-Team 'backend=antigravity,frontend=claude,reviewer=codex'") {
        throw "Test 9 failed: unexpected command $($j9.command)"
    }
    Write-Host "  [PASS] 9. POST dispatch mode=team -> 200 (invoke-agent.ps1 -Role 'leader' -Team)" -ForegroundColor Green

    # 10. POST dispatch with invalid agent -> 400
    $badAgentBody = (@{
        mode         = "task"
        agent        = "invalid-agent"
        role         = "backend"
        project_path = $repoRoot
        prompt       = "Test invalid agent"
    } | ConvertTo-Json -Compress)
    $r10 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=dispatch" -Headers @{ "X-MAW-Request" = "1" } -Body $badAgentBody
    if ($r10.StatusCode -ne 400) { throw "Test 10 failed: invalid agent expected 400, got $($r10.StatusCode)" }
    Write-Host "  [PASS] 10. POST dispatch with invalid agent -> 400" -ForegroundColor Green

    # 11. POST dispatch with mode: team and empty team -> 400
    $emptyTeamBody = (@{
        mode         = "team"
        agent        = "claude"
        team         = @{}
        project_path = $repoRoot
        prompt       = "Test empty team"
    } | ConvertTo-Json -Compress)
    $r11 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=dispatch" -Headers @{ "X-MAW-Request" = "1" } -Body $emptyTeamBody
    if ($r11.StatusCode -ne 400) { throw "Test 11 failed: empty team expected 400, got $($r11.StatusCode)" }
    Write-Host "  [PASS] 11. POST dispatch with empty team -> 400" -ForegroundColor Green

    # 12. C1: Space-path run_job (spec-guard) + SSE job_stream + job_status -> DONE, exit_code: 0, AND real SPEC.md CONTRACT GUARD REPORT in log
    $jobBody = (@{
        mode         = "spec-guard"
        project_path = $repoRoot
    } | ConvertTo-Json -Compress)
    $r12 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=run_job" -Headers @{ "X-MAW-Request" = "1" } -Body $jobBody
    if ($r12.StatusCode -ne 200) { throw "Test 12 failed: run_job expected 200, got $($r12.StatusCode) ($($r12.Body))" }
    $j12 = $r12.Body | ConvertFrom-Json
    $jobId = [string]$j12.job_id
    if (-not $jobId) { throw "Test 12 failed: missing job_id" }

    # Consume SSE job_stream until stream closes on terminal status
    $rStream = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=job_stream&job_id=$jobId&offset=0"
    if ($rStream.StatusCode -ne 200) {
        throw "Test 12 failed: job_stream returned HTTP $($rStream.StatusCode) ($($rStream.Body))"
    }
    if ($rStream.Body -notmatch "event: log") {
        throw "Test 12 failed: job_stream did not emit 'event: log'. Body: $($rStream.Body)"
    }
    if ($rStream.Body -notmatch "SPEC\.md CONTRACT GUARD REPORT") {
        throw "Test 12 failed (C1): job_stream log did not contain 'SPEC.md CONTRACT GUARD REPORT'. Body: $($rStream.Body)"
    }
    if ($rStream.Body -notmatch "event: status") {
        throw "Test 12 failed: job_stream did not emit 'event: status'. Body: $($rStream.Body)"
    }
    if ($rStream.Body -notmatch '"status"\s*:\s*"DONE"' -or $rStream.Body -notmatch '"exit_code"\s*:\s*0') {
        throw "Test 12 failed: job_stream did not end with status DONE and exit_code 0. Body: $($rStream.Body)"
    }

    # Also verify job_status fallback returns DONE + exit_code 0 + full report in log_chunk
    $rj = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=job_status&job_id=$jobId&offset=0"
    if ($rj.StatusCode -ne 200) {
        throw "Test 12 failed: job_status returned HTTP $($rj.StatusCode) ($($rj.Body))"
    }
    $jj = $rj.Body | ConvertFrom-Json
    if ($jj.status -ne "DONE" -or $jj.exit_code -ne 0) {
        throw "Test 12 failed: expected DONE with exit_code 0 from space-path temp dir '$spaceTempDir', got status=$($jj.status) exit_code=$($jj.exit_code)"
    }
    if ($jj.log_chunk -notmatch "SPEC\.md CONTRACT GUARD REPORT") {
        throw "Test 12 failed (C1): job_status log_chunk missing 'SPEC.md CONTRACT GUARD REPORT'. Log: $($jj.log_chunk)"
    }
    Write-Host "  [PASS] 12. C1 space-path run_job + SSE job_stream + job_status -> DONE (exit 0) with full SPEC Guard report" -ForegroundColor Green

    # 13. C2: Job survives server stop/restart (run_job -> kill server immediately -> wait -> restart server -> job DONE with exit 0 & report)
    $r13 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=run_job" -Headers @{ "X-MAW-Request" = "1" } -Body $jobBody
    if ($r13.StatusCode -ne 200) { throw "Test 13 failed: run_job expected 200, got $($r13.StatusCode)" }
    $surviveJobId = [string]($r13.Body | ConvertFrom-Json).job_id
    if (-not $surviveJobId) { throw "Test 13 failed: missing surviveJobId" }

    # Kill Node server immediately while job is still running
    if ($serverProc -and -not $serverProc.HasExited) {
        Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
        $serverProc.WaitForExit(5000) | Out-Null
    }

    # Wait for the independent grandchild PowerShell runner to finish while server is offline
    Start-Sleep -Milliseconds 1500

    # Restart Node server (with --projects-root $spaceTempDir so Test 14 can run against a temp repo inside $spaceTempDir)
    $serverProc = Start-SmokeNodeServer -ProjectsRootArg $spaceTempDir
    Wait-SmokeServerReady

    $rj13 = $null
    $jj13 = $null
    for ($poll = 0; $poll -lt 40; $poll++) {
        $rj13 = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=job_status&job_id=$surviveJobId&offset=0"
        if ($rj13.StatusCode -ne 200) {
            throw "Test 13 failed: job_status after restart returned HTTP $($rj13.StatusCode) ($($rj13.Body))"
        }
        $jj13 = $rj13.Body | ConvertFrom-Json
        if ($jj13.status -ne "RUNNING") {
            break
        }
        Start-Sleep -Milliseconds 300
    }
    if ($jj13.status -ne "DONE" -or $jj13.exit_code -ne 0) {
        throw "Test 13 failed (C2): job $surviveJobId did not survive server restart! Expected DONE/0, got status=$($jj13.status) exit_code=$($jj13.exit_code) log=$($jj13.log_chunk)"
    }
    if ($jj13.log_chunk -notmatch "SPEC\.md CONTRACT GUARD REPORT") {
        throw "Test 13 failed (C2): survived job log missing 'SPEC.md CONTRACT GUARD REPORT'. Log: $($jj13.log_chunk)"
    }
    Write-Host "  [PASS] 13. C2 server-restart survival: run_job -> kill server -> restart -> DONE (exit 0) with full report" -ForegroundColor Green

    # 14. Deterministic non-zero exit_code test: spec-guard with -Owner antigravity on a temp git repo with a forbidden file modified -> FAILED, exit_code: 1
    $failRepoDir = Join-Path $spaceTempDir "fail-project"
    New-Item -ItemType Directory -Path (Join-Path $failRepoDir "dashboard") -Force | Out-Null
    & git -C $failRepoDir init 2>$null | Out-Null
    & git -C $failRepoDir config user.email "smoke@example.com"
    & git -C $failRepoDir config user.name "Smoke"
    $specContent = @"
# Project Specification: Fail Test

## Strict File Ownership Matrix

| Layer | Owner AI | Allowed File Paths | Forbidden Files |
| :--- | :--- | :--- | :--- |
| Frontend | Claude (Frontend) | ``dashboard/index.html`` | ``server/**`` |
| Backend | Antigravity | ``server/**`` | ``SPEC.md``, ``dashboard/*.html`` |
"@
    [System.IO.File]::WriteAllText((Join-Path $failRepoDir "SPEC.md"), $specContent, (New-Object System.Text.UTF8Encoding($false)))
    [System.IO.File]::WriteAllText((Join-Path $failRepoDir "dashboard\index.html"), "<html>v1</html>", (New-Object System.Text.UTF8Encoding($false)))
    & git -C $failRepoDir add -A
    & git -C $failRepoDir commit -m "initial" 2>$null | Out-Null
    # Modify forbidden frontend file and run spec-guard with role='antigravity'
    [System.IO.File]::WriteAllText((Join-Path $failRepoDir "dashboard\index.html"), "<html>forbidden edit</html>", (New-Object System.Text.UTF8Encoding($false)))

    $failJobBody = (@{
        mode         = "spec-guard"
        role         = "antigravity"
        project_path = $failRepoDir
    } | ConvertTo-Json -Compress)
    $r14 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=run_job" -Headers @{ "X-MAW-Request" = "1" } -Body $failJobBody
    if ($r14.StatusCode -ne 200) { throw "Test 14 failed: run_job expected 200, got $($r14.StatusCode) ($($r14.Body))" }
    $failJobId = [string]($r14.Body | ConvertFrom-Json).job_id

    $rFailStream = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=job_stream&job_id=$failJobId&offset=0"
    if ($rFailStream.StatusCode -ne 200) {
        throw "Test 14 failed: job_stream returned HTTP $($rFailStream.StatusCode)"
    }
    if ($rFailStream.Body -notmatch '"status"\s*:\s*"FAILED"' -or $rFailStream.Body -notmatch '"exit_code"\s*:\s*1') {
        throw "Test 14 failed: expected FAILED and exit_code 1 in SSE stream, got: $($rFailStream.Body)"
    }

    $rj14 = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=job_status&job_id=$failJobId&offset=0"
    $jj14 = $rj14.Body | ConvertFrom-Json
    if ($jj14.status -ne "FAILED" -or $jj14.exit_code -ne 1) {
        throw "Test 14 failed: expected job_status FAILED with exit_code 1, got status=$($jj14.status) exit_code=$($jj14.exit_code)"
    }
    if ($jj14.log_chunk -notmatch "SPEC\.md CONTRACT GUARD REPORT" -or $jj14.log_chunk -notmatch "\[FAIL\]") {
        throw "Test 14 failed: expected violation report in log_chunk, got: $($jj14.log_chunk)"
    }
    Write-Host "  [PASS] 14. Non-zero exit_code: spec-guard violation -> FAILED with exit_code: 1 and [FAIL] report" -ForegroundColor Green

    # 15. v4.0 dispatch task & team with gemini, cursor, aider, and council with reviewers -> builds invoke-agent.ps1 & -Reviewers (SPEC §8.3)
    foreach ($cliAg in @("gemini", "cursor", "aider")) {
        $cliTaskBody = (@{
            mode         = "task"
            agent        = $cliAg
            role         = "backend"
            project_path = $failRepoDir
            prompt       = "Implement backend with $cliAg"
        } | ConvertTo-Json -Compress)
        $rCliTask = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=dispatch" -Headers @{ "X-MAW-Request" = "1" } -Body $cliTaskBody
        if ($rCliTask.StatusCode -ne 200) {
            throw "Test 15 failed: dispatch task for $cliAg expected 200, got $($rCliTask.StatusCode) ($($rCliTask.Body))"
        }
        $jCliTask = $rCliTask.Body | ConvertFrom-Json
        if ($jCliTask.command -notmatch 'invoke-agent\.ps1' -or $jCliTask.command -notmatch "-Agent '$cliAg'") {
            throw "Test 15 failed: unexpected command for ${cliAg}: $($jCliTask.command)"
        }
    }

    $cliTeamBody = (@{
        mode         = "team"
        agent        = "gemini"
        team         = @{ backend = "aider"; frontend = "cursor"; reviewer = "gemini" }
        project_path = $failRepoDir
        prompt       = "Lead CLI team"
    } | ConvertTo-Json -Compress)
    $rCliTeam = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=dispatch" -Headers @{ "X-MAW-Request" = "1" } -Body $cliTeamBody
    if ($rCliTeam.StatusCode -ne 200) {
        throw "Test 15 failed: dispatch team with gemini/cursor/aider expected 200, got $($rCliTeam.StatusCode) ($($rCliTeam.Body))"
    }
    $jCliTeam = $rCliTeam.Body | ConvertFrom-Json
    if ($jCliTeam.command -notmatch 'invoke-agent\.ps1' -or $jCliTeam.command -notmatch "-Team 'backend=aider,frontend=cursor,reviewer=gemini'") {
        throw "Test 15 failed: unexpected team command: $($jCliTeam.command)"
    }

    $councilDispBody = (@{
        mode         = "council"
        reviewers    = @("claude", "gemini")
        project_path = $failRepoDir
        prompt       = "Council review diff"
    } | ConvertTo-Json -Compress)
    $rCouncilDisp = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=dispatch" -Headers @{ "X-MAW-Request" = "1" } -Body $councilDispBody
    if ($rCouncilDisp.StatusCode -ne 200) {
        throw "Test 15 failed: dispatch council with reviewers expected 200, got $($rCouncilDisp.StatusCode) ($($rCouncilDisp.Body))"
    }
    $jCouncilDisp = $rCouncilDisp.Body | ConvertFrom-Json
    if ($jCouncilDisp.command -notmatch 'invoke-council-review\.ps1' -or $jCouncilDisp.command -notmatch "-Reviewers 'claude,gemini'") {
        throw "Test 15 failed: expected -Reviewers 'claude,gemini' in council command, got: $($jCouncilDisp.command)"
    }
    Write-Host "  [PASS] 15. v4.0 dispatch task/team with gemini/cursor/aider and council with -Reviewers" -ForegroundColor Green

    # 16. v4.0 run_job for an agent that is not installed -> 400 (SPEC §8.3)
    $uninstJobBody = (@{
        mode         = "task"
        agent        = "uninstalled-smoke-ai"
        role         = "backend"
        project_path = $failRepoDir
        prompt       = "Should return 400 not installed"
    } | ConvertTo-Json -Compress)
    $rUninst = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=run_job" -Headers @{ "X-MAW-Request" = "1" } -Body $uninstJobBody
    if ($rUninst.StatusCode -ne 400) {
        throw "Test 16 failed: run_job for uninstalled agent expected 400, got $($rUninst.StatusCode) ($($rUninst.Body))"
    }
    $jUninst = $rUninst.Body | ConvertFrom-Json
    if ($jUninst.error -notmatch "is not installed") {
        throw "Test 16 failed: expected '<label> is not installed.' message, got: $($jUninst.error)"
    }
    Write-Host "  [PASS] 16. v4.0 run_job for uninstalled agent -> 400 ($($jUninst.error))" -ForegroundColor Green

    # 17. v4.0 Real Council run on a temp git repo with a fake CLI reviewer registered in a temp MAW_HOME -> finishes with COUNCIL_RESULT line, no hang (SPEC §8.3)
    $realCouncilBody = (@{
        mode         = "council"
        reviewers    = @("fake-reviewer")
        project_path = $failRepoDir
        prompt       = "Audit temp repo changes."
    } | ConvertTo-Json -Compress)
    $rCouncilRun = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=run_job" -Headers @{ "X-MAW-Request" = "1" } -Body $realCouncilBody
    if ($rCouncilRun.StatusCode -ne 200) {
        throw "Test 17 failed: Council run_job expected 200, got $($rCouncilRun.StatusCode) ($($rCouncilRun.Body))"
    }
    $councilJobId = [string]($rCouncilRun.Body | ConvertFrom-Json).job_id
    if (-not $councilJobId) {
        throw "Test 17 failed: missing councilJobId"
    }

    $rCouncilStream = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=job_stream&job_id=$councilJobId&offset=0"
    if ($rCouncilStream.StatusCode -ne 200) {
        throw "Test 17 failed: Council job_stream returned HTTP $($rCouncilStream.StatusCode)"
    }
    if ($rCouncilStream.Body -notmatch "=== COUNCIL_RESULT fake-reviewer=APPROVED\|9\.5/10 ===") {
        throw "Test 17 failed: Council stream did not contain '=== COUNCIL_RESULT fake-reviewer=APPROVED|9.5/10 ==='. Body:`n$($rCouncilStream.Body)"
    }
    if ($rCouncilStream.Body -notmatch '"status"\s*:\s*"DONE"' -or $rCouncilStream.Body -notmatch '"exit_code"\s*:\s*0') {
        throw "Test 17 failed: Council run did not finish with DONE and exit_code 0. Body:`n$($rCouncilStream.Body)"
    }
    Write-Host "  [PASS] 17. v4.0 Real Council run with fake CLI reviewer in temp MAW_HOME -> DONE (exit 0) + COUNCIL_RESULT line (no hang)" -ForegroundColor Green

    # 18. v5.0 S1 Git Isolation & Checkpoints smoke block (checkpoint_list, worktree_list, git_log on temp repo)
    $encFailRepo = [System.Uri]::EscapeDataString($failRepoDir)
    $rCpList = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=checkpoint_list&project_path=$encFailRepo"
    if ($rCpList.StatusCode -ne 200) { throw "Test 18a failed: checkpoint_list expected 200, got $($rCpList.StatusCode) ($($rCpList.Body))" }
    $jCpList = $rCpList.Body | ConvertFrom-Json
    if (-not $jCpList.ok -or $null -eq $jCpList.checkpoints) { throw "Test 18a failed: checkpoint_list missing checkpoints array" }

    $rWtList = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=worktree_list&project_path=$encFailRepo"
    if ($rWtList.StatusCode -ne 200) { throw "Test 18b failed: worktree_list expected 200, got $($rWtList.StatusCode) ($($rWtList.Body))" }
    $jWtList = $rWtList.Body | ConvertFrom-Json
    if (-not $jWtList.ok -or $null -eq $jWtList.worktrees) { throw "Test 18b failed: worktree_list missing worktrees array" }

    $rGitLog = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=git_log&project_path=$encFailRepo"
    if ($rGitLog.StatusCode -ne 200) { throw "Test 18c failed: git_log expected 200, got $($rGitLog.StatusCode) ($($rGitLog.Body))" }
    $jGitLog = $rGitLog.Body | ConvertFrom-Json
    if (-not $jGitLog.ok -or $null -eq $jGitLog.commits) { throw "Test 18c failed: git_log missing commits array" }
    Write-Host "  [PASS] 18. v5.0 S1 smoke: checkpoint_list, worktree_list, git_log -> 200" -ForegroundColor Green

    # 19. v5.0 S3 Attention, Health, Timeline & MCP smoke block
    $rHealth = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=health_check"
    if ($rHealth.StatusCode -ne 200) { throw "Test 19a failed: health_check expected 200, got $($rHealth.StatusCode) ($($rHealth.Body))" }
    $jHealth = $rHealth.Body | ConvertFrom-Json
    if (-not $jHealth.ok) { throw "Test 19a failed: health_check ok is false" }

    $inboxAddBody = (@{
        kind     = "custom"
        severity = "info"
        title    = "Smoke inbox test"
        summary  = "Verify inbox_add -> inbox_list -> inbox_act dismiss"
    } | ConvertTo-Json -Compress)
    $rInboxAdd = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=inbox_add" -Headers @{ "X-MAW-Request" = "1" } -Body $inboxAddBody
    if ($rInboxAdd.StatusCode -ne 200) { throw "Test 19b failed: inbox_add expected 200, got $($rInboxAdd.StatusCode) ($($rInboxAdd.Body))" }
    $jInboxAdd = $rInboxAdd.Body | ConvertFrom-Json
    $inboxItemId = [string]$jInboxAdd.item.id
    if (-not $inboxItemId) { throw "Test 19b failed: inbox_add did not return item.id" }

    $rInboxList = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=inbox_list"
    if ($rInboxList.StatusCode -ne 200) { throw "Test 19c failed: inbox_list expected 200, got $($rInboxList.StatusCode)" }
    $jInboxList = $rInboxList.Body | ConvertFrom-Json
    $foundInbox = @($jInboxList.items | Where-Object { $_.id -eq $inboxItemId })
    if ($foundInbox.Count -eq 0) { throw "Test 19c failed: inbox_list did not include newly added item $inboxItemId" }

    $inboxActBody = (@{ id = $inboxItemId; action = "dismiss" } | ConvertTo-Json -Compress)
    $rInboxAct = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=inbox_act" -Headers @{ "X-MAW-Request" = "1" } -Body $inboxActBody
    if ($rInboxAct.StatusCode -ne 200) { throw "Test 19d failed: inbox_act dismiss expected 200, got $($rInboxAct.StatusCode) ($($rInboxAct.Body))" }

    $rTimeline = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=timeline"
    if ($rTimeline.StatusCode -ne 200) { throw "Test 19e failed: timeline expected 200, got $($rTimeline.StatusCode) ($($rTimeline.Body))" }
    $jTimeline = $rTimeline.Body | ConvertFrom-Json
    if (-not $jTimeline.ok -or $null -eq $jTimeline.lanes) { throw "Test 19e failed: timeline missing lanes array" }

    $rMcpCfg = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=mcp_config"
    if ($rMcpCfg.StatusCode -ne 200) { throw "Test 19f failed: mcp_config expected 200, got $($rMcpCfg.StatusCode) ($($rMcpCfg.Body))" }

    $mcpUnconfirmedBody = (@{ targets = @("claude") } | ConvertTo-Json -Compress)
    $rMcpApply = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=mcp_apply" -Headers @{ "X-MAW-Request" = "1" } -Body $mcpUnconfirmedBody
    if ($rMcpApply.StatusCode -ne 400) { throw "Test 19g failed: mcp_apply without confirm expected 400, got $($rMcpApply.StatusCode) ($($rMcpApply.Body))" }
    Write-Host "  [PASS] 19. v5.0 S3 smoke: health_check, inbox_add/list/act, timeline, mcp_config, mcp_apply unconfirmed -> 400" -ForegroundColor Green

    # 20. H7: start-dashboard.ps1 piped output returns in < 30s without handle-inheritance hang, writes logs, and -Stop terminates node
    $h7Listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    $h7Listener.Start()
    $h7Port = ([System.Net.IPEndPoint]$h7Listener.LocalEndpoint).Port
    $h7Listener.Stop()
    $h7MawHome = Join-Path $spaceTempDir ".maw-h7"
    New-Item -ItemType Directory -Path $h7MawHome -Force | Out-Null
    $startDashScript = Join-Path $repoRoot "start-dashboard.ps1"
    try {
        $env:TMP             = $spaceTempDir
        $env:TEMP            = $spaceTempDir
        $env:MAW_HOME        = $h7MawHome
        $env:USERPROFILE     = $smokeUserProfile
        $env:MAW_TEST        = "1"
        $env:MAW_SKIP_HEALTH = "1"

        $h7Sw = [System.Diagnostics.Stopwatch]::StartNew()
        $h7Psi = New-Object System.Diagnostics.ProcessStartInfo
        $h7Psi.FileName = "powershell.exe"
        $h7Psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command `"& '$($startDashScript.Replace("'", "''"))' -Port $h7Port -NoBrowser | Select-Object -Last 6`""
        $h7Psi.UseShellExecute = $false
        $h7Psi.RedirectStandardOutput = $true
        $h7Psi.RedirectStandardError = $true
        $h7Psi.CreateNoWindow = $true
        $h7Proc = [System.Diagnostics.Process]::Start($h7Psi)
        $h7OutTask = $h7Proc.StandardOutput.ReadToEndAsync()
        $h7ErrTask = $h7Proc.StandardError.ReadToEndAsync()
        if (-not $h7Proc.WaitForExit(30000) -or -not $h7OutTask.Wait(5000)) {
            try { $h7Proc.Kill() } catch {}
            throw "Test 20 (H7) failed: start-dashboard.ps1 piped output hung (> 30s) due to inherited stdout/stderr handles"
        }
        $h7Sw.Stop()
        $h7Out = $h7OutTask.Result
        if ($h7Out -notmatch "Server is ONLINE \(PID (\d+)\)") {
            throw "Test 20 (H7) failed: expected 'Server is ONLINE (PID <id>)' in piped output, got:`n$h7Out`nERR:`n$($h7ErrTask.Result)"
        }
        $h7OutLog = Join-Path $h7MawHome "logs\server.out.log"
        if (-not (Test-Path -LiteralPath $h7OutLog)) {
            throw "Test 20 (H7) failed: expected $h7OutLog to be created"
        }
        Write-Host "  [PASS] 20. H7 start-dashboard.ps1 piped output returned in $([int]$h7Sw.ElapsedMilliseconds)ms (< 30s) without handle hang" -ForegroundColor Green
    } finally {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startDashScript -Port $h7Port -Stop | Out-Null
        $env:TMP         = $origTmp
        $env:TEMP        = $origTemp
        $env:MAW_HOME    = $origMawHome
        $env:USERPROFILE = $origUserProfile
        if ($null -eq $origMawTest) { Remove-Item Env:\MAW_TEST -ErrorAction SilentlyContinue } else { $env:MAW_TEST = $origMawTest }
        if ($null -eq $origSkipHealth) { Remove-Item Env:\MAW_SKIP_HEALTH -ErrorAction SilentlyContinue } else { $env:MAW_SKIP_HEALTH = $origSkipHealth }
    }

    Write-Host "[api-smoke] All v4.0 + v5.0 Node.js API security, Registry, C1/C2 runner survival, Council, S1, S3 & H7 smoke assertions PASSED!" -ForegroundColor Cyan
    exit 0
} catch {
    Write-Error "[api-smoke] FAILED: $($_.Exception.Message)"
    exit 1
} finally {
    $env:TMP         = $origTmp
    $env:TEMP        = $origTemp
    $env:MAW_HOME    = $origMawHome
    $env:USERPROFILE = $origUserProfile
    if ($null -eq $origMawTest) { Remove-Item Env:\MAW_TEST -ErrorAction SilentlyContinue } else { $env:MAW_TEST = $origMawTest }
    if ($null -eq $origSkipHealth) { Remove-Item Env:\MAW_SKIP_HEALTH -ErrorAction SilentlyContinue } else { $env:MAW_SKIP_HEALTH = $origSkipHealth }
    $httpClient.Dispose()
    if ($serverProc -and -not $serverProc.HasExited) {
        try { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    if ($spaceTempDir -and (Test-Path -LiteralPath $spaceTempDir)) {
        try { Remove-Item -LiteralPath $spaceTempDir -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }
}
