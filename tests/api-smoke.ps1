$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Net.Http

$repoRoot = Split-Path -Parent $PSScriptRoot
$dashboardDir = Join-Path $repoRoot "dashboard"

$phpCmd = Get-Command php -ErrorAction SilentlyContinue
if ($phpCmd) {
    $phpExe = $phpCmd.Source
} else {
    $laragonPhp = Get-ChildItem -Path "C:\laragon\bin\php\*\php.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if ($laragonPhp) {
        $phpExe = $laragonPhp.FullName
    } else {
        Write-Error "Could not locate php.exe in PATH or C:\laragon\bin\php\*\php.exe"
        exit 1
    }
}

$origTmp  = $env:TMP
$origTemp = $env:TEMP
$baseTemp = if ($origTemp) { $origTemp } else { [System.IO.Path]::GetTempPath() }
$spaceTempDir = Join-Path $baseTemp ("maw smoke space " + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $spaceTempDir -Force | Out-Null

$port = Get-Random -Minimum 18100 -Maximum 18999
$baseUrl = "http://127.0.0.1:$port/api.php"

Write-Host "[api-smoke] Starting PHP built-in server using $phpExe on 127.0.0.1:$port (TMP='$spaceTempDir')..." -ForegroundColor Cyan
$env:TMP  = $spaceTempDir
$env:TEMP = $spaceTempDir
$serverProc = Start-Process -FilePath $phpExe -ArgumentList @("-S", "127.0.0.1:$port", "-t", $dashboardDir) -PassThru -WindowStyle Hidden
$env:TMP  = $origTmp
$env:TEMP = $origTemp

$httpClient = New-Object System.Net.Http.HttpClient
$httpClient.Timeout = [TimeSpan]::FromSeconds(15)

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
        [void]$req.Headers.TryAddWithoutValidation($k, [string]$Headers[$k])
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
    $resp.Dispose()
    $req.Dispose()

    return @{
        StatusCode = $code
        Body       = $respBody
    }
}

try {
    # Wait for server readiness
    Start-Sleep -Milliseconds 500
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
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) {
        throw "PHP server on 127.0.0.1:$port did not become ready in time. Last error: $lastErr"
    }

    # 1. GET status -> 200, api_version 2.2, features contains 'agents', no raw telegram_bot_token, honest telemetry
    $r1 = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=status"
    if ($r1.StatusCode -ne 200) { throw "Test 1 failed: expected 200, got $($r1.StatusCode)" }
    $j1 = $r1.Body | ConvertFrom-Json
    if (-not $j1.ok) { throw "Test 1 failed: ok is false" }
    if ($j1.api_version -ne "2.2") { throw "Test 1 failed: expected api_version 2.2, got $($j1.api_version)" }
    if (@($j1.features) -notcontains "agents") { throw "Test 1 failed: status.features does not contain 'agents'" }
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
    Write-Host "  [PASS] 1. GET status -> 200, api_version 2.2, features=['agents'], honest telemetry" -ForegroundColor Green

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

    # 12. R1: Run a real spec-guard job when sys_get_temp_dir() contains a space and verify it reaches DONE with exit_code: 0
    $jobBody = (@{
        mode         = "spec-guard"
        project_path = $repoRoot
    } | ConvertTo-Json -Compress)
    $r12 = Invoke-SmokeRequest -Method "POST" -Url "${baseUrl}?action=run_job" -Headers @{ "X-MAW-Request" = "1" } -Body $jobBody
    if ($r12.StatusCode -ne 200) { throw "Test 12 failed: run_job expected 200, got $($r12.StatusCode) ($($r12.Body))" }
    $j12 = $r12.Body | ConvertFrom-Json
    $jobId = [string]$j12.job_id
    if (-not $jobId) { throw "Test 12 failed: missing job_id" }

    $finalJob = $null
    for ($poll = 0; $poll -lt 40; $poll++) {
        Start-Sleep -Milliseconds 300
        $rj = Invoke-SmokeRequest -Method "GET" -Url "${baseUrl}?action=job_status&job_id=$jobId&offset=0"
        if ($rj.StatusCode -ne 200) {
            throw "Test 12 failed: job_status returned HTTP $($rj.StatusCode) ($($rj.Body))"
        }
        $jj = $rj.Body | ConvertFrom-Json
        if ($jj.status -in @("DONE", "FAILED", "CANCELLED")) {
            $finalJob = $jj
            break
        }
    }
    if ($null -eq $finalJob) {
        throw "Test 12 failed: spec-guard job $jobId did not finish within timeout"
    }
    if ($finalJob.status -ne "DONE" -or $finalJob.exit_code -ne 0) {
        throw "Test 12 failed: expected DONE with exit_code 0 from space-path temp dir '$spaceTempDir', got status=$($finalJob.status) exit_code=$($finalJob.exit_code) log=$($finalJob.log_chunk)"
    }
    Write-Host "  [PASS] 12. R1 space-path run_job (spec-guard) -> DONE with exit_code: 0" -ForegroundColor Green

    Write-Host "[api-smoke] All 12 API security, v2.2 agent/team & space-path job assertions PASSED!" -ForegroundColor Cyan
    exit 0
} catch {
    Write-Error "[api-smoke] FAILED: $($_.Exception.Message)"
    exit 1
} finally {
    $env:TMP  = $origTmp
    $env:TEMP = $origTemp
    $httpClient.Dispose()
    if ($serverProc -and -not $serverProc.HasExited) {
        try { Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    if ($spaceTempDir -and (Test-Path -LiteralPath $spaceTempDir)) {
        try { Remove-Item -LiteralPath $spaceTempDir -Recurse -Force -ErrorAction SilentlyContinue } catch {}
    }
}
