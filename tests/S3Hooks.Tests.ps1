# Pester 5 tests for S3 hooks (30-health.ps1, 30-timeline.ps1)
# Compatible with Windows PowerShell 5.1

Describe "S3 Hooks (30-health.ps1, 30-timeline.ps1)" {
    BeforeAll {
        $testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("maw_s3_hooks_" + [System.Guid]::NewGuid().ToString("N"))
        [void](New-Item -ItemType Directory -Path $testRoot -Force)
        $userProf = Join-Path $testRoot "UserProfile"
        $mawHome  = Join-Path $testRoot "MawHome"
        [void](New-Item -ItemType Directory -Path $userProf -Force)
        [void](New-Item -ItemType Directory -Path $mawHome -Force)

        $repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
        $healthHook = Join-Path $repoRoot "antigravity\skills\claude-leader\scripts\hooks\before-agent\30-health.ps1"
        $tlStartHook = Join-Path $repoRoot "antigravity\skills\claude-leader\scripts\hooks\job-start\30-timeline.ps1"
        $tlFinHook = Join-Path $repoRoot "antigravity\skills\claude-leader\scripts\hooks\job-finish\30-timeline.ps1"

        $origMawHome = $env:MAW_HOME
        $origUserProf = $env:USERPROFILE
        $origTemp = $env:TEMP
        $origTmp = $env:TMP
        $origMawTest = $env:MAW_TEST
        $origAuditFile = $env:MAW_AUDIT_FILE
        $origSkipHealth = $env:MAW_SKIP_HEALTH

        $isoTemp = Join-Path $testRoot "Temp"
        [void](New-Item -ItemType Directory -Path $isoTemp -Force)

        $env:MAW_HOME = $mawHome
        $env:USERPROFILE = $userProf
        $env:TEMP = $isoTemp
        $env:TMP = $isoTemp
        $env:MAW_TEST = "1"
        $env:MAW_AUDIT_FILE = Join-Path $userProf ".gemini\antigravity\multi-ai-audit.jsonl"
    }

    AfterAll {
        if ($null -ne $origMawHome) { $env:MAW_HOME = $origMawHome } else { Remove-Item env:MAW_HOME -ErrorAction SilentlyContinue }
        if ($null -ne $origUserProf) { $env:USERPROFILE = $origUserProf } else { Remove-Item env:USERPROFILE -ErrorAction SilentlyContinue }
        if ($null -ne $origTemp) { $env:TEMP = $origTemp } else { Remove-Item env:TEMP -ErrorAction SilentlyContinue }
        if ($null -ne $origTmp) { $env:TMP = $origTmp } else { Remove-Item env:TMP -ErrorAction SilentlyContinue }
        if ($null -ne $origMawTest) { $env:MAW_TEST = $origMawTest } else { Remove-Item env:MAW_TEST -ErrorAction SilentlyContinue }
        if ($null -ne $origAuditFile) { $env:MAW_AUDIT_FILE = $origAuditFile } else { Remove-Item env:MAW_AUDIT_FILE -ErrorAction SilentlyContinue }
        if ($null -ne $origSkipHealth) { $env:MAW_SKIP_HEALTH = $origSkipHealth } else { Remove-Item env:MAW_SKIP_HEALTH -ErrorAction SilentlyContinue }
        try {
            Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
        } catch {}
    }

    Context "30-health.ps1 before-agent hook" {
        It "passes when MAW_SKIP_HEALTH is 1" {
            $env:MAW_SKIP_HEALTH = '1'
            $Context = @{ agent = 'claude'; role = 'backend' }
            $res = . $healthHook
            $res.Block | Should -Be $false
            $env:MAW_SKIP_HEALTH = '0'
        }

        It "blocks when cache contains fresh error for the agent" {
            $healthDataDir = Join-Path $env:MAW_HOME "data\health"
            [void](New-Item -ItemType Directory -Path $healthDataDir -Force)
            $cacheFile = Join-Path $healthDataDir "cache.json"

            $nowIso = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            $cacheContent = @{
                agents = @{
                    claude = @{
                        label      = "Claude Code"
                        status     = "error"
                        reason     = "Not logged in"
                        checked_at = $nowIso
                        fix        = @{ command = "claude /login" }
                    }
                }
            } | ConvertTo-Json -Depth 5
            [System.IO.File]::WriteAllText($cacheFile, $cacheContent, [System.Text.Encoding]::UTF8)

            $Context = @{ agent = 'claude'; role = 'backend' }
            $res = . $healthHook
            $res.Block | Should -Be $true
            $res.Reason | Should -Match "Claude Code: Not logged in"
            $res.Reason | Should -Match "claude /login"
        }

        It "passes when cache contains fresh warn for the agent" {
            $healthDataDir = Join-Path $env:MAW_HOME "data\health"
            $cacheFile = Join-Path $healthDataDir "cache.json"

            $nowIso = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            $cacheContent = @{
                agents = @{
                    codex = @{
                        label      = "Codex CLI"
                        status     = "warn"
                        reason     = "Quota high"
                        checked_at = $nowIso
                    }
                }
            } | ConvertTo-Json -Depth 5
            [System.IO.File]::WriteAllText($cacheFile, $cacheContent, [System.Text.Encoding]::UTF8)

            $Context = @{ agent = 'codex'; role = 'reviewer' }
            $res = . $healthHook
            $res.Block | Should -Be $false
        }

        It "blocks when user registry in MAW_HOME provides status_cmd that exits 1 with Not logged in (using real Invoke-NativeProcess)" {
            . (Join-Path $repoRoot "antigravity\skills\claude-leader\scripts\lib\maw-common.ps1")
            $healthDataDir = Join-Path $env:MAW_HOME "data\health"
            $cacheFile = Join-Path $healthDataDir "cache.json"
            Remove-Item -LiteralPath $cacheFile -Force -ErrorAction SilentlyContinue

            $userRegFile = Join-Path $env:MAW_HOME "agents.json"
            $userReg = @{
                agents = @(
                    @{
                        id = "mock-agent"
                        label = "Mock Agent"
                        cli = @{ command = "powershell.exe" }
                        status_cmd = @("powershell.exe", "-NoProfile", "-Command", "Write-Output 'Not logged in'; exit 1")
                    }
                )
            } | ConvertTo-Json -Depth 5
            [System.IO.File]::WriteAllText($userRegFile, $userReg, [System.Text.Encoding]::UTF8)

            $Context = @{ agent = 'mock-agent'; role = 'backend' }
            $res = . $healthHook
            $res.Block | Should -Be $true
            $res.Reason | Should -Match "Mock Agent: Not logged in"
        }
    }

    Context "30-timeline.ps1 job hooks" {
        It "job-start hook writes clean UTF-8 without BOM so first line parses directly" {
            # Delete any existing events.jsonl to test new file creation from scratch
            $eventsFile = Join-Path $env:MAW_HOME "data\timeline\events.jsonl"
            Remove-Item -LiteralPath $eventsFile -Force -ErrorAction SilentlyContinue

            $Context = @{
                job_id    = "job_bom_check"
                mode      = "task"
                agent     = "claude"
                role      = "backend"
                project   = "C:\test\bom"
                exit_code = $null
            }
            $null = . $tlStartHook

            Test-Path -LiteralPath $eventsFile | Should -Be $true
            # Check raw bytes: must NOT start with EF BB BF
            $rawBytes = [System.IO.File]::ReadAllBytes($eventsFile)
            $hasBom = ($rawBytes.Length -ge 3 -and $rawBytes[0] -eq 0xEF -and $rawBytes[1] -eq 0xBB -and $rawBytes[2] -eq 0xBF)
            $hasBom | Should -Be $false

            # First line must parse with ConvertFrom-Json directly from raw text
            $firstLine = [System.IO.File]::ReadAllText($eventsFile, [System.Text.Encoding]::UTF8).Trim()
            $parsed = $firstLine | ConvertFrom-Json
            $parsed.job_id | Should -Be "job_bom_check"
            $parsed.event | Should -Be "job-start"
        }

        It "job-start hook appends valid JSON to events.jsonl" {
            $Context = @{
                job_id    = "job_pester_1"
                mode      = "task"
                agent     = "claude"
                role      = "backend"
                project   = "C:\test\pester"
                exit_code = $null
            }
            $null = . $tlStartHook

            $eventsFile = Join-Path $env:MAW_HOME "data\timeline\events.jsonl"
            Test-Path -LiteralPath $eventsFile | Should -Be $true

            $lines = @(Get-Content -LiteralPath $eventsFile | Where-Object { $_.Trim() })
            $lastLine = $lines[-1]
            $obj = $lastLine | ConvertFrom-Json
            $obj.event | Should -Be "job-start"
            $obj.job_id | Should -Be "job_pester_1"
            $obj.status | Should -Be "RUNNING"
        }

        It "job-finish hook appends valid JSON with status DONE or FAILED" {
            $Context = @{
                job_id    = "job_pester_1"
                mode      = "task"
                agent     = "claude"
                role      = "backend"
                project   = "C:\test\pester"
                exit_code = 0
            }
            $null = . $tlFinHook

            $eventsFile = Join-Path $env:MAW_HOME "data\timeline\events.jsonl"
            $lines = @(Get-Content -LiteralPath $eventsFile | Where-Object { $_.Trim() })
            $lastLine = $lines[-1]
            $obj = $lastLine | ConvertFrom-Json
            $obj.event | Should -Be "job-finish"
            $obj.job_id | Should -Be "job_pester_1"
            $obj.status | Should -Be "DONE"
            $obj.exit_code | Should -Be 0
        }
    }
}
