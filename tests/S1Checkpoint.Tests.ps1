# Pester 5 tests for S1 Checkpoint library and hooks (SPEC §1, §8)

BeforeAll {
    $script:scriptsDir = Join-Path $PSScriptRoot "..\antigravity\skills\claude-leader\scripts"
    $script:commonPath = Join-Path $script:scriptsDir "lib\maw-common.ps1"
    $script:libPath = Join-Path $script:scriptsDir "hooks\_shared\10-checkpoint-lib.ps1"
    $script:hooksPath = Join-Path $script:scriptsDir "lib\maw-hooks.ps1"
    . $script:commonPath
    . $script:libPath
    . $script:hooksPath
}

Describe "S1 Checkpoints PowerShell Library" {
    Context "New-MawCheckpoint on throwaway git repository" {
        BeforeEach {
            $script:tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("maw-cp-test-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
            New-Item -ItemType Directory -Path $script:tempRoot -Force | Out-Null
            & git -C $script:tempRoot init -q
            & git -C $script:tempRoot config user.name "Test User"
            & git -C $script:tempRoot config user.email "test@example.com"
            & git -C $script:tempRoot config commit.gpgSign false

            Set-Content -LiteralPath (Join-Path $script:tempRoot "README.md") -Value "Hello world" -Encoding UTF8
            & git -C $script:tempRoot add README.md
            & git -C $script:tempRoot commit -m "Initial commit" -q
        }

        AfterEach {
            if (Test-Path -LiteralPath $script:tempRoot) {
                Remove-Item -LiteralPath $script:tempRoot -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        It "creates a checkpoint with ref and commit trailers" {
            $jobKey = "job_test_001"
            $id = New-MawCheckpoint -WorkDir $script:tempRoot -JobKey $jobKey -Event "job-start" -Label "test checkpoint" -Agent "claude" -Role "backend"
            $id | Should -Be "job_test_001/0001"

            $ref = "refs/maw/checkpoints/job_test_001/0001"
            $exists = & git -C $script:tempRoot rev-parse --verify -q $ref
            $LASTEXITCODE | Should -Be 0
            $exists | Should -Not -BeNullOrEmpty

            $msg = (& git -C $script:tempRoot log -1 --format=%B $ref) -join "`n"
            $msg | Should -Match "maw checkpoint: test checkpoint"
            $msg | Should -Match "MAW-Event: job-start"
            $msg | Should -Match "MAW-Job: job_test_001"
            $msg | Should -Match "MAW-Agent: claude"
            $msg | Should -Match "MAW-Role: backend"
        }

        It "deduplicates back-to-back checkpoints with unchanged tree" {
            $jobKey = "job_test_dedup"
            $id1 = New-MawCheckpoint -WorkDir $script:tempRoot -JobKey $jobKey -Event "job-start" -Label "first"
            $id1 | Should -Be "job_test_dedup/0001"

            # Immediate second checkpoint without file edits
            $id2 = New-MawCheckpoint -WorkDir $script:tempRoot -JobKey $jobKey -Event "before-agent" -Label "second"
            $id2 | Should -Be "job_test_dedup/0001"

            # Verify 0002 was NOT created
            $ref2 = & git -C $script:tempRoot rev-parse --verify -q "refs/maw/checkpoints/job_test_dedup/0002" 2>$null
            $LASTEXITCODE | Should -Not -Be 0
        }

        It "creates next index when working tree changes" {
            $jobKey = "job_test_inc"
            $id1 = New-MawCheckpoint -WorkDir $script:tempRoot -JobKey $jobKey -Event "job-start" -Label "first"
            $id1 | Should -Be "job_test_inc/0001"

            # Modify file
            Add-Content -LiteralPath (Join-Path $script:tempRoot "README.md") -Value "More changes"
            $id2 = New-MawCheckpoint -WorkDir $script:tempRoot -JobKey $jobKey -Event "round-start" -Label "second"
            $id2 | Should -Be "job_test_inc/0002"
        }

        It "Y5: preserves and restores GIT_TERMINAL_PROMPT and GIT_OPTIONAL_LOCKS" {
            $env:GIT_TERMINAL_PROMPT = "custom_prompt_val"
            $env:GIT_OPTIONAL_LOCKS = "custom_locks_val"
            try {
                Add-Content -LiteralPath (Join-Path $script:tempRoot "README.md") -Value "y5 change"
                $id = New-MawCheckpoint -WorkDir $script:tempRoot -JobKey "job_y5" -Event "manual" -Label "y5 env test"
                $id | Should -Not -BeNullOrEmpty
                $env:GIT_TERMINAL_PROMPT | Should -Be "custom_prompt_val"
                $env:GIT_OPTIONAL_LOCKS | Should -Be "custom_locks_val"
            } finally {
                Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
                Remove-Item Env:\GIT_OPTIONAL_LOCKS -ErrorAction SilentlyContinue
            }
        }

        It "Y2: retention never prunes the newly created checkpoint even when timestamps tie" {
            # Create 5 checkpoints with old_job
            for ($i = 1; $i -le 5; $i++) {
                Add-Content -LiteralPath (Join-Path $script:tempRoot "README.md") -Value "change $i"
                New-MawCheckpoint -WorkDir $script:tempRoot -JobKey "old_job" -Event "job-start" -Label "cp $i" -Retention 5 | Out-Null
            }

            # Create 6th checkpoint under a new job key 'safety' with retention=5
            Add-Content -LiteralPath (Join-Path $script:tempRoot "README.md") -Value "safety change"
            $safetyId = New-MawCheckpoint -WorkDir $script:tempRoot -JobKey "safety" -Event "safety" -Label "restore safety" -Retention 5
            $safetyId | Should -Be "safety/0001"

            # The newly created safety/0001 must exist and not have been pruned
            $ref = "refs/maw/checkpoints/$safetyId"
            $exists = & git -C $script:tempRoot rev-parse --verify -q $ref
            $LASTEXITCODE | Should -Be 0
            $exists | Should -Not -BeNullOrEmpty
        }
    }

    Context "Non-git directory and safety handling" {
        BeforeEach {
            $script:nonGitDir = Join-Path ([System.IO.Path]::GetTempPath()) ("maw-nongit-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
            New-Item -ItemType Directory -Path $script:nonGitDir -Force | Out-Null
        }

        AfterEach {
            if (Test-Path -LiteralPath $script:nonGitDir) {
                Remove-Item -LiteralPath $script:nonGitDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        It "never throws in a non-git directory and returns null" {
            {
                $res = New-MawCheckpoint -WorkDir $script:nonGitDir -JobKey "test_nongit" -Event "manual" -Label "nongit"
                $res | Should -BeNullOrEmpty
            } | Should -Not -Throw
        }
    }

    Context "Hook execution through Invoke-MawHooks" {
        BeforeEach {
            $script:hookRepo = Join-Path ([System.IO.Path]::GetTempPath()) ("maw-hook-repo-" + [System.Guid]::NewGuid().ToString('N').Substring(0, 8))
            New-Item -ItemType Directory -Path $script:hookRepo -Force | Out-Null
            & git -C $script:hookRepo init -q
            & git -C $script:hookRepo config user.name "Test User"
            & git -C $script:hookRepo config user.email "test@example.com"
            & git -C $script:hookRepo config commit.gpgSign false
            Set-Content -LiteralPath (Join-Path $script:hookRepo "file.txt") -Value "initial" -Encoding UTF8
            & git -C $script:hookRepo add file.txt
            & git -C $script:hookRepo commit -m "initial commit" -q
        }

        AfterEach {
            if (Test-Path -LiteralPath $script:hookRepo) {
                Remove-Item -LiteralPath $script:hookRepo -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        It "job-start hook executes without blocking" {
            $context = @{
                job_id  = "job_20261025_001"
                project = $script:hookRepo
                agent   = "claude"
                role    = "backend"
            }
            $res = Invoke-MawHooks -Event "job-start" -Context $context -HooksRoot (Join-Path $script:scriptsDir "hooks")
            $res.Block | Should -BeFalse

            # Ref should exist
            $ref = & git -C $script:hookRepo rev-parse --verify -q "refs/maw/checkpoints/job_20261025_001/0001"
            $LASTEXITCODE | Should -Be 0
        }

        It "round-start hook executes without blocking" {
            $context = @{
                project = $script:hookRepo
                round   = 1
            }
            $res = Invoke-MawHooks -Event "round-start" -Context $context -HooksRoot (Join-Path $script:scriptsDir "hooks")
            $res.Block | Should -BeFalse
        }

        It "before-agent hook executes without blocking" {
            $context = @{
                workdir = $script:hookRepo
                agent   = "codex"
                role    = "reviewer"
            }
            $res = Invoke-MawHooks -Event "before-agent" -Context $context -HooksRoot (Join-Path $script:scriptsDir "hooks")
            $res.Block | Should -BeFalse
        }
    }
}
