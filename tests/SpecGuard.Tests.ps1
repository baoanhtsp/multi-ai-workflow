BeforeAll {
    $script:origMawHome = $env:MAW_HOME
    $script:origUserProfile = $env:USERPROFILE
    $script:origTemp = $env:TEMP
    $script:origTmp = $env:TMP
    $script:origMawTest = $env:MAW_TEST
    $script:origAuditFile = $env:MAW_AUDIT_FILE

    $script:isoBase = Join-Path ([System.IO.Path]::GetTempPath()) ("maw-specguard-iso-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    $script:isoMaw = Join-Path $script:isoBase ".maw"
    $script:isoUser = Join-Path $script:isoBase "user"
    $script:isoTemp = Join-Path $script:isoBase "tmp"
    New-Item -ItemType Directory -Path $script:isoMaw -Force | Out-Null
    New-Item -ItemType Directory -Path $script:isoUser -Force | Out-Null
    New-Item -ItemType Directory -Path $script:isoTemp -Force | Out-Null

    $env:MAW_HOME = $script:isoMaw
    $env:USERPROFILE = $script:isoUser
    $env:TEMP = $script:isoTemp
    $env:TMP = $script:isoTemp
    $env:MAW_TEST = "1"
    $env:MAW_AUDIT_FILE = Join-Path $script:isoUser ".gemini\antigravity\multi-ai-audit.jsonl"

    $script:RepoRoot = Split-Path -Parent $PSScriptRoot
    $script:GuardScript = Join-Path $script:RepoRoot "antigravity\skills\claude-leader\scripts\invoke-spec-guard.ps1"
    $script:CommonScript = Join-Path $script:RepoRoot "antigravity\skills\claude-leader\scripts\lib\maw-common.ps1"
    $script:IsoRepo = Join-Path $script:isoTemp "spec repo"
    New-Item -ItemType Directory -Path $script:IsoRepo -Force | Out-Null
    & git -C $script:IsoRepo init -q 2>$null | Out-Null
    & git -C $script:IsoRepo config core.autocrlf false
    & git -C $script:IsoRepo config user.email "test@example.com"
    & git -C $script:IsoRepo config user.name "Test"
    Copy-Item -LiteralPath (Join-Path $script:RepoRoot "SPEC.md") -Destination (Join-Path $script:IsoRepo "SPEC.md") -Force
    & git -C $script:IsoRepo add -A
    & git -C $script:IsoRepo commit -m "initial" -q 2>$null | Out-Null
    . $script:CommonScript
}

AfterAll {
    if ($null -eq $script:origMawHome) { Remove-Item Env:\MAW_HOME -ErrorAction SilentlyContinue } else { $env:MAW_HOME = $script:origMawHome }
    if ($null -eq $script:origUserProfile) { Remove-Item Env:\USERPROFILE -ErrorAction SilentlyContinue } else { $env:USERPROFILE = $script:origUserProfile }
    if ($null -eq $script:origTemp) { Remove-Item Env:\TEMP -ErrorAction SilentlyContinue } else { $env:TEMP = $script:origTemp }
    if ($null -eq $script:origTmp) { Remove-Item Env:\TMP -ErrorAction SilentlyContinue } else { $env:TMP = $script:origTmp }
    if ($null -eq $script:origMawTest) { Remove-Item Env:\MAW_TEST -ErrorAction SilentlyContinue } else { $env:MAW_TEST = $script:origMawTest }
    if ($null -eq $script:origAuditFile) { Remove-Item Env:\MAW_AUDIT_FILE -ErrorAction SilentlyContinue } else { $env:MAW_AUDIT_FILE = $script:origAuditFile }
    if ($script:isoBase -and (Test-Path -LiteralPath $script:isoBase)) {
        Remove-Item -LiteralPath $script:isoBase -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Describe "invoke-spec-guard.ps1" {
    It "Extracts GET /api?action=status and ownership rules from the repository SPEC.md" {
        $raw = (& $script:GuardScript -WorkDir $script:IsoRepo -Json) -join "`n"
        $res = $raw | ConvertFrom-Json
        $res.ok | Should -BeTrue
        $res.has_spec | Should -BeTrue
        $res.has_git | Should -BeTrue
        $res.spec_endpoints | Should -Contain "GET /api?action=status"
        $res.ownership_rules.Count | Should -BeGreaterOrEqual 3
    }

    Context "Temp Git Repository Scenarios" {
        BeforeEach {
            $script:TmpRepo = Join-Path $env:TEMP ("maw_specguard_" + [guid]::NewGuid().ToString("N"))
            New-Item -ItemType Directory -Path $script:TmpRepo -Force | Out-Null
            & git -C $script:TmpRepo init 2>$null | Out-Null
            & git -C $script:TmpRepo config core.autocrlf false
            & git -C $script:TmpRepo config user.email "test@example.com"
            & git -C $script:TmpRepo config user.name "Test"

            $specText = @"
# Project Specification: Test Project

## Strict File Ownership Matrix

| Layer | Owner AI | Allowed File Paths | Forbidden Files |
| :--- | :--- | :--- | :--- |
| Architecture | Claude (Tech Lead) | ``SPEC.md`` | ``dashboard/api.php``, ``*.ps1`` |
| Frontend | Claude (Frontend) | ``dashboard/index.html``, ``dashboard/*.css`` | ``dashboard/api.php``, ``*.ps1`` |
| Backend | Antigravity | ``dashboard/api.php``, ``*.ps1``, ``tests/**`` | ``SPEC.md``, ``dashboard/*.html`` |

## API Contract
- ``GET api.php?action=status``
- ``POST api.php?action=spec_guard``
"@
            [System.IO.File]::WriteAllText((Join-Path $script:TmpRepo "SPEC.md"), $specText, (New-Object System.Text.UTF8Encoding($false)))
            New-Item -ItemType Directory -Path (Join-Path $script:TmpRepo "dashboard") -Force | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $script:TmpRepo "dashboard\api.php"), "<?php // v1", (New-Object System.Text.UTF8Encoding($false)))
            [System.IO.File]::WriteAllText((Join-Path $script:TmpRepo "dashboard\index.html"), "<html>v1</html>", (New-Object System.Text.UTF8Encoding($false)))
            & git -C $script:TmpRepo add -A
            & git -C $script:TmpRepo commit -m "init" 2>$null | Out-Null
        }

        AfterEach {
            if ($script:TmpRepo -and (Test-Path -LiteralPath $script:TmpRepo)) {
                Remove-Item -LiteralPath $script:TmpRepo -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        It "Returns PASS when -Owner antigravity modifies only allowed backend/script files and lists untracked files in new subdirs individually" {
            [System.IO.File]::WriteAllText((Join-Path $script:TmpRepo "dashboard\api.php"), "<?php // v2", (New-Object System.Text.UTF8Encoding($false)))
            $subDir = Join-Path $script:TmpRepo "tests\unit"
            New-Item -ItemType Directory -Path $subDir -Force | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $subDir "Sample.Tests.ps1"), "# test", (New-Object System.Text.UTF8Encoding($false)))

            $raw = (& $script:GuardScript -WorkDir $script:TmpRepo -Owner antigravity -Json) -join "`n"
            $res = $raw | ConvertFrom-Json
            $res.verdict | Should -Be "PASS"
            $res.violations.Count | Should -Be 0
            $res.warnings.Count | Should -Be 0
            $paths = @($res.modified_files | ForEach-Object { $_.path })
            $paths | Should -Contain "dashboard/api.php"
            $paths | Should -Contain "tests/unit/Sample.Tests.ps1"
        }

        It "Returns FAIL when -Owner antigravity modifies forbidden files (dashboard/index.html or SPEC.md)" {
            [System.IO.File]::WriteAllText((Join-Path $script:TmpRepo "dashboard\index.html"), "<html>modified</html>", (New-Object System.Text.UTF8Encoding($false)))
            [System.IO.File]::AppendAllText((Join-Path $script:TmpRepo "SPEC.md"), "`n<!-- unauthorized edit -->`n", (New-Object System.Text.UTF8Encoding($false)))

            $raw = (& $script:GuardScript -WorkDir $script:TmpRepo -Owner antigravity -Json) -join "`n"
            $res = $raw | ConvertFrom-Json
            $res.verdict | Should -Be "FAIL"
            $res.violations.Count | Should -BeGreaterOrEqual 2
        }

        It "Returns WARN when an unowned file is modified (with no Owner filter)" {
            [System.IO.File]::WriteAllText((Join-Path $script:TmpRepo "unowned.xyz"), "hello", (New-Object System.Text.UTF8Encoding($false)))

            $raw = (& $script:GuardScript -WorkDir $script:TmpRepo -Json) -join "`n"
            $res = $raw | ConvertFrom-Json
            $res.verdict | Should -Be "WARN"
            $res.warnings.Count | Should -BeGreaterOrEqual 1
        }

        It "Returns WARN when SPEC.md is missing or directory is not a Git repository" {
            $nonGitDir = Join-Path $env:TEMP ("maw_nongit_" + [guid]::NewGuid().ToString("N"))
            New-Item -ItemType Directory -Path $nonGitDir -Force | Out-Null
            try {
                $raw = (& $script:GuardScript -WorkDir $nonGitDir -Json) -join "`n"
                $res = $raw | ConvertFrom-Json
                $res.verdict | Should -Be "WARN"
                $res.has_spec | Should -BeFalse
                $res.has_git | Should -BeFalse
                $res.warnings.Count | Should -BeGreaterOrEqual 2
            } finally {
                Remove-Item -LiteralPath $nonGitDir -Recurse -Force -ErrorAction SilentlyContinue
            }
        }

        It "Excludes pre-existing unchanged dirty files from -Owner checks when -Baseline is provided (R2)" {
            # Pre-existing frontend edit made by another agent before baseline snapshot
            [System.IO.File]::WriteAllText((Join-Path $script:TmpRepo "dashboard\index.html"), "<html>claude frontend edit</html>", (New-Object System.Text.UTF8Encoding($false)))

            $baselineFile = Join-Path $env:TEMP ("maw_baseline_" + [guid]::NewGuid().ToString("N") + ".json")
            try {
                Get-DirtySnapshot -WorkDir $script:TmpRepo -OutputFile $baselineFile | Out-Null

                # Antigravity modifies an allowed backend file
                [System.IO.File]::WriteAllText((Join-Path $script:TmpRepo "dashboard\api.php"), "<?php // antigravity backend edit", (New-Object System.Text.UTF8Encoding($false)))

                $rawPass = (& $script:GuardScript -WorkDir $script:TmpRepo -Owner antigravity -Baseline $baselineFile -Json) -join "`n"
                $resPass = $rawPass | ConvertFrom-Json
                $resPass.verdict | Should -Be "PASS"
                $resPass.violations.Count | Should -Be 0
                $resPass.total_modified | Should -Be 2

                # If Antigravity now modifies a forbidden file (or alters dashboard/index.html after baseline), it MUST fail
                [System.IO.File]::WriteAllText((Join-Path $script:TmpRepo "dashboard\index.html"), "<html>tampered after baseline</html>", (New-Object System.Text.UTF8Encoding($false)))
                $rawFail = (& $script:GuardScript -WorkDir $script:TmpRepo -Owner antigravity -Baseline $baselineFile -Json) -join "`n"
                $resFail = $rawFail | ConvertFrom-Json
                $resFail.verdict | Should -Be "FAIL"
                $resFail.violations.Count | Should -BeGreaterOrEqual 1
            } finally {
                Remove-Item -LiteralPath $baselineFile -Force -ErrorAction SilentlyContinue
            }
        }

        It "Emits a warning when -Owner has no row in the ownership matrix (R4)" {
            [System.IO.File]::WriteAllText((Join-Path $script:TmpRepo "dashboard\api.php"), "<?php // v2", (New-Object System.Text.UTF8Encoding($false)))

            $raw = (& $script:GuardScript -WorkDir $script:TmpRepo -Owner codex -Json) -join "`n"
            $res = $raw | ConvertFrom-Json
            $res.verdict | Should -Be "WARN"
            $res.warnings | Should -Contain "Owner 'codex' has no row in the ownership matrix; nothing was enforced."
        }

        It "Assigns a multi-owner matrix row (e.g. 'Claude Opus (-Role architect) + Antigravity') to every matched registry agent (A2)" {
            $multiSpec = @"
# Project Specification: Multi-Owner Test

## Strict File Ownership Matrix

| Layer | Owner AI | Allowed File Paths | Forbidden Files |
| :--- | :--- | :--- | :--- |
| Architecture & Contract | Claude Opus (`-Role architect`) + Antigravity | ``SPEC.md`` | ``dashboard/*.html`` |
| Frontend UI | Claude (`-Role frontend`) + Gemini CLI | ``dashboard/index.html`` | ``dashboard/api.php`` |
| Backend | Antigravity | ``dashboard/api.php`` | ``dashboard/*.html`` |
"@
            [System.IO.File]::WriteAllText((Join-Path $script:TmpRepo "SPEC.md"), $multiSpec, (New-Object System.Text.UTF8Encoding($false)))
            & git -C $script:TmpRepo add SPEC.md
            & git -C $script:TmpRepo commit -m "multi-owner spec" 2>$null | Out-Null

            # Modify SPEC.md -> should PASS for both -Owner claude and -Owner antigravity
            [System.IO.File]::AppendAllText((Join-Path $script:TmpRepo "SPEC.md"), "`n<!-- updated spec -->`n", (New-Object System.Text.UTF8Encoding($false)))

            $rawClaude = (& $script:GuardScript -WorkDir $script:TmpRepo -Owner claude -Json) -join "`n"
            $resClaude = $rawClaude | ConvertFrom-Json
            $resClaude.verdict | Should -Be "PASS"
            $resClaude.violations.Count | Should -Be 0

            $rawAgy = (& $script:GuardScript -WorkDir $script:TmpRepo -Owner antigravity -Json) -join "`n"
            $resAgy = $rawAgy | ConvertFrom-Json
            $resAgy.verdict | Should -Be "PASS"
            $resAgy.violations.Count | Should -Be 0

            # Modify dashboard/index.html -> should PASS for -Owner gemini
            & git -C $script:TmpRepo checkout -- SPEC.md 2>$null | Out-Null
            [System.IO.File]::WriteAllText((Join-Path $script:TmpRepo "dashboard\index.html"), "<html>gemini edit</html>", (New-Object System.Text.UTF8Encoding($false)))
            $rawGemini = (& $script:GuardScript -WorkDir $script:TmpRepo -Owner gemini -Json) -join "`n"
            $resGemini = $rawGemini | ConvertFrom-Json
            $resGemini.verdict | Should -Be "PASS"
            $resGemini.violations.Count | Should -Be 0
        }
    }
}
