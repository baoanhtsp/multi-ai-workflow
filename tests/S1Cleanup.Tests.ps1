# Pester 5 tests for S1 Cleanup End-to-End (SPEC §5b, §8)

Describe "S1 Cleanup End-to-End" {
    BeforeAll {
        $script:repoRoot = Split-Path -Parent $PSScriptRoot
        $script:serverMain = Join-Path $script:repoRoot "server\main.ts"

        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        if (-not $nodeCmd) {
            throw "node.exe not found in PATH"
        }
        $script:nodeExe = $nodeCmd.Source

        # Find a free TCP port
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $listener.Start()
        $script:port = $listener.LocalEndpoint.Port
        $listener.Stop()

        # Isolated directory structure (R12)
        $script:testBase = Join-Path ([System.IO.Path]::GetTempPath()) ("maw-s1-clean-pest-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
        $script:projectsRoot = Join-Path $script:testBase "projects"
        $script:repoDir = Join-Path $script:projectsRoot "cleanup-demo"
        $script:mawHome = Join-Path $script:testBase "maw-home"
        $script:tempDir = Join-Path $script:testBase "tmp"
        $script:jobsDir = Join-Path $script:testBase "jobs"

        New-Item -ItemType Directory -Path $script:projectsRoot -Force | Out-Null
        New-Item -ItemType Directory -Path $script:repoDir -Force | Out-Null
        New-Item -ItemType Directory -Path $script:mawHome -Force | Out-Null
        New-Item -ItemType Directory -Path $script:tempDir -Force | Out-Null
        New-Item -ItemType Directory -Path $script:jobsDir -Force | Out-Null

        # Setup throwaway git repo
        & git -C $script:repoDir init -b main -q
        & git -C $script:repoDir config user.name "Test User"
        & git -C $script:repoDir config user.email "test@example.com"
        & git -C $script:repoDir config commit.gpgSign false

        Set-Content -LiteralPath (Join-Path $script:repoDir "README.md") -Value "cleanup demo main" -Encoding UTF8
        & git -C $script:repoDir add README.md
        & git -C $script:repoDir commit -m "initial commit on main" -q

        # 1. Merged branch
        & git -C $script:repoDir checkout -b maw/clean-merged -q
        Set-Content -LiteralPath (Join-Path $script:repoDir "merged.txt") -Value "merged file" -Encoding UTF8
        & git -C $script:repoDir add merged.txt
        & git -C $script:repoDir commit -m "feat: merged file" -q
        & git -C $script:repoDir checkout main -q
        & git -C $script:repoDir merge --no-ff -m "merge maw/clean-merged" maw/clean-merged -q

        # 2. Unmerged stale branch (20 days old)
        $pastDate = (Get-Date).AddDays(-20).ToString("o")
        & git -C $script:repoDir checkout -b maw/clean-stale -q
        Set-Content -LiteralPath (Join-Path $script:repoDir "stale.txt") -Value "stale file" -Encoding UTF8
        & git -C $script:repoDir add stale.txt
        $env:GIT_COMMITTER_DATE = $pastDate
        $env:GIT_AUTHOR_DATE = $pastDate
        try {
            & git -C $script:repoDir commit -m "feat: stale work" -q
        } finally {
            Remove-Item env:GIT_COMMITTER_DATE -ErrorAction SilentlyContinue
            Remove-Item env:GIT_AUTHOR_DATE -ErrorAction SilentlyContinue
        }
        & git -C $script:repoDir checkout main -q

        # 3. Orphan worktree folder under .maw-wt/cleanup-demo/
        $script:orphanDir = Join-Path $script:projectsRoot ".maw-wt\cleanup-demo\wt-orphan"
        New-Item -ItemType Directory -Path $script:orphanDir -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $script:orphanDir "orphan.txt") -Value "orphan content" -Encoding UTF8

        # Start Node server
        $script:origTmp = $env:TMP
        $script:origTemp = $env:TEMP
        $script:origMawHome = $env:MAW_HOME
        $script:origSweep = $env:MAW_CLEANUP_SWEEP

        $env:TMP = $script:tempDir
        $env:TEMP = $script:tempDir
        $env:MAW_HOME = $script:mawHome
        $env:MAW_CLEANUP_SWEEP = "0"

        $argList = @($script:serverMain, "--port", "$($script:port)", "--projects-root", $script:projectsRoot)
        $script:serverProc = Start-Process -FilePath $script:nodeExe -ArgumentList $argList -WorkingDirectory $script:repoRoot -PassThru -WindowStyle Hidden

        # Wait for server to respond
        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 400
            try {
                $statusRes = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:port)/api?action=status" -Method GET -TimeoutSec 3 -ErrorAction Stop
                if ($statusRes -and $statusRes.ok) {
                    $ready = $true
                    break
                }
            } catch {
                # wait
            }
        }
        if (-not $ready) {
            throw "Node server failed to start on port $($script:port)"
        }
    }

    AfterAll {
        if ($script:serverProc -and -not $script:serverProc.HasExited) {
            Stop-Process -Id $script:serverProc.Id -Force -ErrorAction SilentlyContinue
            $script:serverProc.WaitForExit(3000) | Out-Null
        }

        $env:TMP = $script:origTmp
        $env:TEMP = $script:origTemp
        $env:MAW_HOME = $script:origMawHome
        $env:MAW_CLEANUP_SWEEP = $script:origSweep

        if (Test-Path -LiteralPath $script:testBase) {
            Remove-Item -LiteralPath $script:testBase -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "previews cleanup candidates and correctly applies deletion to selected items" {
        $encodedPath = [System.Uri]::EscapeDataString($script:repoDir)
        $previewUrl = "http://127.0.0.1:$($script:port)/api?action=cleanup_preview&project_path=$encodedPath"

        $preview = Invoke-RestMethod -Uri $previewUrl -Method GET -TimeoutSec 10
        $preview.ok | Should -Be $true
        $preview.candidates | Should -Not -BeNullOrEmpty

        $candidateKinds = @($preview.candidates | ForEach-Object { $_.kind })
        $candidateKinds | Should -Contain "merged_branch"
        $candidateKinds | Should -Contain "stale_branch"
        $candidateKinds | Should -Contain "orphan_worktree"

        # Apply only merged_branch and orphan_worktree (leave stale branch alone)
        $applyBody = @{
            action         = "cleanup_apply"
            project_path   = $script:repoDir
            items          = @("merged_branch:maw/clean-merged", "orphan_worktree:wt-orphan")
            confirm        = $true
            confirm_risky  = @("orphan_worktree:wt-orphan")
        } | ConvertTo-Json -Depth 5

        $headers = @{ "X-MAW-Request" = "1" }
        $applyRes = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:port)/api?action=cleanup_apply" -Method POST -Headers $headers -Body $applyBody -ContentType "application/json" -TimeoutSec 15
        $applyRes.ok | Should -Be $true
        $deletedIds = @($applyRes.deleted | ForEach-Object { $_.id })

        $deletedIds | Should -Contain "merged_branch:maw/clean-merged"
        $deletedIds | Should -Contain "orphan_worktree:wt-orphan"

        # Assert merged branch is gone
        & git -C $script:repoDir show-ref --verify -q refs/heads/maw/clean-merged
        $LASTEXITCODE | Should -Not -Be 0

        # Assert orphan worktree directory is deleted
        (Test-Path -LiteralPath $script:orphanDir) | Should -Be $false

        # Assert stale branch is STILL THERE
        & git -C $script:repoDir show-ref --verify -q refs/heads/maw/clean-stale
        $LASTEXITCODE | Should -Be 0
    }
}
