# S4Hooks.Tests.ps1 - Pester tests for S4 hook wrappers
# Tests before-agent hook blocking on budget cap, and missing runtime handling

BeforeAll {
    $script:repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
    $script:hooksRoot = Join-Path $script:repoRoot "antigravity\skills\claude-leader\scripts\hooks"
    $script:beforeAgentHook = Join-Path $script:hooksRoot "before-agent\40-s4-before-agent.ps1"
    $script:jobStartHook = Join-Path $script:hooksRoot "job-start\40-s4-job-start.ps1"
    $script:jobFinishHook = Join-Path $script:hooksRoot "job-finish\40-s4-job-finish.ps1"
    $script:beforeReviewHook = Join-Path $script:hooksRoot "before-review\40-s4-before-review.ps1"
}

Describe "S4 Hook Wrappers" {
    Context "When runtime.json is missing" {
        It "job-start fails open without error" {
            $env:MAW_S4_RUNTIME = Join-Path $env:TEMP ("non_existent_runtime_" + [guid]::NewGuid().ToString() + ".json")
            $Context = @{ job_id = "job_1" }
            $res = & $script:jobStartHook
            $res.Block | Should -Be $false
            $res.Reason | Should -Be ""
            $env:MAW_S4_RUNTIME = $null
        }

        It "before-agent fails open without throwing" {
            $env:MAW_S4_RUNTIME = Join-Path $env:TEMP ("non_existent_runtime_" + [guid]::NewGuid().ToString() + ".json")
            $Context = @{ agent = "claude"; role = "backend" }
            $res = & $script:beforeAgentHook
            $res.Block | Should -Be $false
            $res.Reason | Should -Be ""
            $env:MAW_S4_RUNTIME = $null
        }

        It "before-review returns Block = false" {
            $env:MAW_S4_RUNTIME = Join-Path $env:TEMP ("non_existent_runtime_" + [guid]::NewGuid().ToString() + ".json")
            $Context = @{ workdir = "C:\temp" }
            $res = & $script:beforeReviewHook
            $res.Block | Should -Be $false
            $env:MAW_S4_RUNTIME = $null
        }

        It "job-finish returns Block = false" {
            $env:MAW_S4_RUNTIME = Join-Path $env:TEMP ("non_existent_runtime_" + [guid]::NewGuid().ToString() + ".json")
            $Context = @{ job_id = "job_1" }
            $res = & $script:jobFinishHook
            $res.Block | Should -Be $false
            $env:MAW_S4_RUNTIME = $null
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

            $script:tempDir = Join-Path $env:TEMP ("maw_pester_s4_" + [guid]::NewGuid().ToString("N"))
            New-Item -ItemType Directory -Force -Path $script:tempDir | Out-Null
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
            $env:MAW_S4_RUNTIME = $null
            $env:MAW_HOME = $null
            $env:USERPROFILE = $null
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

        It "job-start exports MAW_JOB_ID and MAW_TEAM_RUN_ID into process env" {
            $Context = @{
                job_id = "job_start_test"
                mode = "task"
                role = "backend"
                project = $script:repoRoot
            }
            $res = & $script:jobStartHook
            $res.Block | Should -Be $false
            $env:MAW_JOB_ID | Should -Be "job_start_test"
            $env:MAW_TEAM_RUN_ID | Should -Be "job_start_test"
            $env:MAW_JOB_ID = $null
            $env:MAW_TEAM_RUN_ID = $null
        }
    }
}
