# S4Hooks.Tests.ps1 - Pester tests for S4 hook wrappers
# Tests before-agent hook blocking on budget cap, and missing runtime handling

BeforeAll {
    $script:origUser = $env:USERPROFILE
    $script:origMaw = $env:MAW_HOME
    $script:origRuntime = $env:MAW_S4_RUNTIME
    $script:origTemp = $env:TEMP
    $script:origTmp = $env:TMP

    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
    $script:hooksRoot = Join-Path $script:repoRoot "antigravity\skills\claude-leader\scripts\hooks"
    $script:beforeAgentHook = Join-Path $script:hooksRoot "before-agent\40-s4-before-agent.ps1"
    $script:jobStartHook = Join-Path $script:hooksRoot "job-start\40-s4-job-start.ps1"
    $script:jobFinishHook = Join-Path $script:hooksRoot "job-finish\40-s4-job-finish.ps1"
    $script:beforeReviewHook = Join-Path $script:hooksRoot "before-review\40-s4-before-review.ps1"
}

AfterAll {
    $env:USERPROFILE = $script:origUser
    $env:MAW_HOME = $script:origMaw
    $env:MAW_S4_RUNTIME = $script:origRuntime
    $env:TEMP = $script:origTemp
    $env:TMP = $script:origTmp
}

Describe "S4 Hook Wrappers" {
    Context "When runtime.json is missing" {
        BeforeEach {
            $script:emptyDir = Join-Path $env:TEMP ("maw_empty_test_" + [guid]::NewGuid().ToString("N"))
            New-Item -ItemType Directory -Force -Path $script:emptyDir | Out-Null
            $env:MAW_HOME = $script:emptyDir
            $env:USERPROFILE = $script:emptyDir
            $env:MAW_S4_RUNTIME = Join-Path $script:emptyDir "non_existent_runtime.json"
        }

        AfterEach {
            $env:MAW_HOME = $script:origMaw
            $env:USERPROFILE = $script:origUser
            $env:MAW_S4_RUNTIME = $script:origRuntime
            if (Test-Path -LiteralPath $script:emptyDir) {
                Remove-Item -LiteralPath $script:emptyDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        It "job-start fails open without error" {
            $Context = @{ job_id = "job_1" }
            $res = & $script:jobStartHook
            $res.Block | Should -Be $false
            $res.Reason | Should -Be ""
        }

        It "before-agent fails open without throwing" {
            $Context = @{ agent = "claude"; role = "backend" }
            $res = & $script:beforeAgentHook
            $res.Block | Should -Be $false
            $res.Reason | Should -Be ""
        }

        It "before-review returns Block = false" {
            $Context = @{ workdir = "C:\temp" }
            $res = & $script:beforeReviewHook
            $res.Block | Should -Be $false
        }

        It "job-finish returns Block = false" {
            $Context = @{ job_id = "job_1" }
            $res = & $script:jobFinishHook
            $res.Block | Should -Be $false
        }
    }

    Context "When runtime.json exists and budget day cap is exceeded" {
        BeforeEach {
            $env:MAW_JOB_ID = $null
            $env:MAW_JOB_MODE = $null
            $env:MAW_JOB_ROLE = $null
            $env:MAW_JOB_PROJECT = $null
            $env:MAW_TEAM_RUN_ID = $null
            $env:MAW_S4_AUDIT_OFFSET = $null

            $script:tempDir = Join-Path $script:origTemp ("maw_pester_s4_" + [guid]::NewGuid().ToString("N"))
            New-Item -ItemType Directory -Force -Path $script:tempDir | Out-Null
            $env:TEMP = $script:tempDir
            $env:TMP = $script:tempDir
            $script:tempMawHome = Join-Path $script:tempDir ".maw"
            $script:tempUser = Join-Path $script:tempDir "user"
            $script:tempBudgetDir = Join-Path $script:tempMawHome "data\budget"
            $script:tempAuditDir = Join-Path $script:tempUser ".gemini\antigravity"
            New-Item -ItemType Directory -Force -Path $script:tempBudgetDir | Out-Null
            New-Item -ItemType Directory -Force -Path $script:tempAuditDir | Out-Null

            # Write runtime.json
            $script:runtimeFile = Join-Path $script:tempDir "runtime.json"
            @{
                repo_root = $script:repoRoot
                node = "node"
                written_at = (Get-Date).ToString("o")
            } | ConvertTo-Json | Set-Content $script:runtimeFile

            # Write budget config with day cap $1.00
            $budgetCfg = @{
                version = 1
                enabled = $true
                caps = @{
                    day = @{ usd = @{ warn = 0.50; block = 1.00 } }
                }
                estimate_next_call = $false
            }
            $budgetCfg | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $script:tempBudgetDir "budgets.json")

            # Write audit row with $2.00 spend today
            $auditFile = Join-Path $script:tempAuditDir "multi-ai-audit.jsonl"
            $auditRow = @{
                Timestamp = (Get-Date).ToString("o")
                Tool = "claude"
                Agent = "claude"
                Role = "backend"
                Model = "sonnet"
                WorkDir = $script:repoRoot
                CostUsd = 2.00
                InputTokens = 1000
                OutputTokens = 2000
                PromptChars = 4000
                Score = ""
                Verdict = ""
            } | ConvertTo-Json -Compress
            Set-Content -LiteralPath $auditFile -Value $auditRow

            $env:MAW_S4_RUNTIME = $script:runtimeFile
            $env:MAW_HOME = $script:tempMawHome
            $env:USERPROFILE = $script:tempUser
        }

        AfterEach {
            $env:MAW_S4_RUNTIME = $script:origRuntime
            $env:MAW_HOME = $script:origMaw
            $env:USERPROFILE = $script:origUser
            $env:TEMP = $script:origTemp
            $env:TMP = $script:origTmp
            if (Test-Path -LiteralPath $script:tempDir) {
                Remove-Item -LiteralPath $script:tempDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        It "blocks before-agent with S4:budget machine tag" {
            $Context = @{
                agent = "claude"
                role = "backend"
                workdir = $script:repoRoot
            }
            $res = & $script:beforeAgentHook
            $res.Block | Should -Be $true
            $res.Reason | Should -Match 'Budget day exceeded'
            $res.Reason | Should -Match '\[S4:budget agent=claude fallback=none\]'
        }

        It "job-start exports MAW_JOB_ID and MAW_TEAM_RUN_ID into process env and prepends policy brief to prompt file" {
            # Create fake jobsDir and prompt file
            $jobsDir = Join-Path $env:TEMP "maw_jobs"
            New-Item -ItemType Directory -Force -Path $jobsDir | Out-Null
            $promptFile = Join-Path $jobsDir "job_start_test.prompt.txt"
            Set-Content -LiteralPath $promptFile -Value "Please write a simple backend function."

            $Context = @{
                job_id = "job_start_test"
                mode = "task"
                role = "reviewer"
                project = $script:repoRoot
            }
            $res = & $script:jobStartHook
            $res.Block | Should -Be $false
            $env:MAW_JOB_ID | Should -Be "job_start_test"
            $env:MAW_TEAM_RUN_ID | Should -Be "job_start_test"

            # Check prompt file contains policy brief
            $promptContent = Get-Content -LiteralPath $promptFile -Raw
            $promptContent | Should -Match '<!-- MAW-S4-POLICY:BEGIN -->'
            $promptContent | Should -Match '## Policy for role reviewer'
            $promptContent | Should -Match 'Please write a simple backend function.'

            $env:MAW_JOB_ID = $null
            $env:MAW_TEAM_RUN_ID = $null
        }

        It "before-review hook blocks untrusted checks.json and does not execute the command" {
            $testRepo = Join-Path $script:tempDir "test_untrusted_repo"
            $markerFile = Join-Path $testRepo "marker.txt"
            New-Item -ItemType Directory -Force -Path (Join-Path $testRepo ".maw") | Out-Null
            & git init $testRepo 2>$null | Out-Null

            # Command that would create marker.txt if executed
            $cmdStr = "require('fs').writeFileSync('" + ($markerFile.Replace('\', '/')) + "', 'PWNED')"
            $checksCfg = @{
                version = 1
                checks = @(
                    @{
                        id = "malicious_check"
                        label = "Malicious Check"
                        command = @("node", "-e", $cmdStr)
                        required = $true
                    }
                )
            }
            $checksCfg | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $testRepo ".maw\checks.json")

            $Context = @{ workdir = $testRepo }
            $res = & $script:beforeReviewHook
            $res.Block | Should -Be $true
            $res.Reason | Should -Match 'Test gate: \.maw/checks\.json changed and is not trusted'
            $res.Reason | Should -Match '\[S4:gate\]'

            # Critical assertion: the command must NEVER have executed
            (Test-Path -LiteralPath $markerFile) | Should -Be $false
        }

        It "before-review hook blocks on a red gate when checks are trusted" {
            $testRepo = Join-Path $script:tempDir "test_gate_repo"
            New-Item -ItemType Directory -Force -Path (Join-Path $testRepo ".maw") | Out-Null

            # Git init
            & git init $testRepo 2>$null | Out-Null

            # Write failing check config
            $checksCfg = @{
                version = 1
                checks = @(
                    @{
                        id = "failing_test"
                        label = "Failing Test"
                        command = @("node", "-e", "process.exit(1)")
                        required = $true
                    }
                )
                spec_guard = $false
                min_review_score = 0
            }
            $checksFile = Join-Path $testRepo ".maw\checks.json"
            $checksJson = $checksCfg | ConvertTo-Json -Depth 5
            [System.IO.File]::WriteAllText($checksFile, $checksJson)

            $trustedDir = Join-Path $script:tempMawHome "data\checks"
            New-Item -ItemType Directory -Force -Path $trustedDir | Out-Null
            $trustedFile = Join-Path $trustedDir "trusted.json"

            & node -e "const fs = require('fs'); const crypto = require('crypto'); const content = fs.readFileSync(process.argv[1], 'utf8'); const sha = crypto.createHash('sha256').update(content, 'utf8').digest('hex'); const norm = process.argv[2].replace(/\//g, '\\\\').replace(/\\\\+$/, '').toLowerCase(); const store = { [norm]: sha }; fs.writeFileSync(process.argv[3], JSON.stringify(store));" $checksFile $testRepo $trustedFile

            $Context = @{
                workdir = $testRepo
            }
            $res = & $script:beforeReviewHook
            $res.Block | Should -Be $true
            $res.Reason | Should -Match 'Test gate red'
            $res.Reason | Should -Match '\[S4:gate\]'
        }

        It "job-finish diff scan detects modified protected paths on renames and quoted paths" {
            $testRepo = Join-Path $script:tempDir "test_rename_repo"
            New-Item -ItemType Directory -Force -Path $testRepo | Out-Null
            & git init $testRepo 2>$null | Out-Null

            # Configure policy with protected path ".env"
            $policyDir = Join-Path $script:tempMawHome "data\policy"
            New-Item -ItemType Directory -Force -Path $policyDir | Out-Null
            $polCfg = @{
                version = 1
                enabled = $true
                global = @{
                    protected_paths = @(".env", "secret docs/**")
                    redact_secrets = $true
                }
                roles = @{}
            }
            $polCfg | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $policyDir "policy.json")

            # Create an initial commit with old file
            Set-Content (Join-Path $testRepo "old.txt") "clean"
            & git -C $testRepo add old.txt 2>$null | Out-Null
            & git -C $testRepo -c user.name="Test" -c user.email="test@example.com" commit -m "initial" 2>$null | Out-Null

            # Take snapshot before rename
            $snapshotsDir = Join-Path $policyDir "snapshots"
            New-Item -ItemType Directory -Force -Path $snapshotsDir | Out-Null
            Set-Content (Join-Path $snapshotsDir "job_rename_1.txt") ""

            # Rename old.txt to .env
            & git -C $testRepo mv old.txt .env 2>$null | Out-Null

            $Context = @{
                job_id = "job_rename_1"
                role = "backend"
                project = $testRepo
            }
            $res = & $script:jobFinishHook
            $res.Block | Should -Be $false

            # Check that a violation was recorded in violations.jsonl
            $violFile = Join-Path $policyDir "violations.jsonl"
            (Test-Path -LiteralPath $violFile) | Should -Be $true
            $violContent = Get-Content -LiteralPath $violFile -Raw
            $violContent | Should -Match 'protected_path'
            $violContent | Should -Match '\.env'
        }
    }
}
