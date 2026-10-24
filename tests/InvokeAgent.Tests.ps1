BeforeAll {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $script:invokeAgentPath = Join-Path $repoRoot "antigravity\skills\claude-leader\scripts\invoke-agent.ps1"
    $script:repoRoot = $repoRoot
}

Describe "invoke-agent.ps1 Unified Role Dispatcher (SPEC section 5)" {
    It "resolves all 18 (agent, role) pairs with -DryRun and leaves no unrendered {{ placeholders" {
        $agents = @("claude", "codex", "antigravity")
        $roles  = @("architect", "leader", "backend", "frontend", "reviewer", "tester")

        $prevDepth = $env:MAW_DEPTH
        try {
            $env:MAW_DEPTH = "0"
            foreach ($ag in $agents) {
                foreach ($rl in $roles) {
                    $out = & $script:invokeAgentPath `
                        -Agent $ag `
                        -Role $rl `
                        -WorkDir $script:repoRoot `
                        -Prompt "Verify role brief rendering for $ag as $rl." `
                        -DryRun 2>&1
                    $code = $LASTEXITCODE
                    $text = ($out | Out-String)

                    $code | Should -Be 0
                    $text | Should -Not -Match '\{\{'
                    $text | Should -Match 'DRYRUN_COMMAND:'

                    if ($ag -eq "claude") {
                        $text | Should -Match 'invoke-claude\.ps1'
                        if ($rl -eq "tester") {
                            $text | Should -Match '-Role backend\b'
                        } else {
                            $text | Should -Match "-Role $rl\b"
                        }
                        if ($rl -eq "reviewer") {
                            $text | Should -Match '-IncludeGitDiff'
                        }
                    } elseif ($ag -eq "codex") {
                        $text | Should -Match 'invoke-codex\.ps1'
                        if ($rl -eq "reviewer") {
                            $text | Should -Match '-Role review-diff\b'
                        } else {
                            $text | Should -Match '-Role coder\b'
                        }
                    } elseif ($ag -eq "antigravity") {
                        $text | Should -Match 'invoke-antigravity\.ps1'
                        $text | Should -Match '-Action send-latest\b'
                        $text | Should -Match '-TimeoutSeconds 1800\b'
                    }

                    if ($rl -eq "reviewer") {
                        $text | Should -Match 'SCORE:\s*X/10'
                        $text | Should -Match 'VERDICT:\s*APPROVED'
                    }
                }
            }
        } finally {
            $env:MAW_DEPTH = $prevDepth
        }
    }

    It "supports -NewSession and -ModelOverride pro for antigravity" {
        $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeAgentPath `
            -Agent antigravity `
            -Role backend `
            -WorkDir $script:repoRoot `
            -NewSession `
            -ModelOverride pro `
            -Prompt "Start fresh session." `
            -DryRun 2>&1
        $LASTEXITCODE | Should -Be 0
        $text = ($out | Out-String)
        $text | Should -Match '-Action new\b'
        $text | Should -Match '-Model pro\b'
    }

    It "parses custom -Team map and renders ONLY the specified members (M2: no default members merged when -Team is passed)" {
        $prevDepth = $env:MAW_DEPTH
        try {
            $env:MAW_DEPTH = "0"
            $outSingle = & $script:invokeAgentPath `
                -Agent claude `
                -Role leader `
                -WorkDir $script:repoRoot `
                -Team "backend=antigravity" `
                -Prompt "Coordinate backend-only team." `
                -DryRun 2>&1
            $LASTEXITCODE | Should -Be 0
            $textSingle = ($outSingle | Out-String)
            $textSingle | Should -Match '\|\s*backend\s*\|\s*antigravity\s*\|'
            $textSingle | Should -Not -Match '\|\s*frontend\s*\|'
            $textSingle | Should -Not -Match '\|\s*reviewer\s*\|'

            $outFull = & $script:invokeAgentPath `
                -Agent claude `
                -Role leader `
                -WorkDir $script:repoRoot `
                -Team "backend=codex,frontend=antigravity,reviewer=claude" `
                -Prompt "Coordinate custom team." `
                -DryRun 2>&1
            $LASTEXITCODE | Should -Be 0
            $textFull = ($outFull | Out-String)
            $textFull | Should -Match '\|\s*backend\s*\|\s*codex\s*\|'
            $textFull | Should -Match '\|\s*frontend\s*\|\s*antigravity\s*\|'
            $textFull | Should -Match '\|\s*reviewer\s*\|\s*claude\s*\|'
        } finally {
            $env:MAW_DEPTH = $prevDepth
        }
    }

    It "preserves child stdout, stderr, and real exit code (e.g. 3) when child writes to stderr under Stop preference (M1)" {
        $tmpSkill = Join-Path $env:TEMP ("maw_m1_skill_" + [guid]::NewGuid().ToString("N"))
        $tmpScripts = Join-Path $tmpSkill "scripts"
        $tmpLib     = Join-Path $tmpScripts "lib"
        $tmpRoles   = Join-Path $tmpSkill "templates\roles"
        New-Item -ItemType Directory -Path $tmpLib -Force | Out-Null
        New-Item -ItemType Directory -Path $tmpRoles -Force | Out-Null

        try {
            Copy-Item -LiteralPath $script:invokeAgentPath -Destination (Join-Path $tmpScripts "invoke-agent.ps1") -Force
            Copy-Item -LiteralPath (Join-Path $script:repoRoot "antigravity\skills\claude-leader\scripts\lib\maw-common.ps1") -Destination (Join-Path $tmpLib "maw-common.ps1") -Force
            Copy-Item -LiteralPath (Join-Path $script:repoRoot "antigravity\skills\claude-leader\templates\roles\reviewer.md") -Destination (Join-Path $tmpRoles "reviewer.md") -Force

            $fakeCodex = @'
[Console]::Error.WriteLine("STDERR_FIRST_LINE_FROM_CHILD")
Write-Output "STDOUT_SECOND_LINE_FROM_CHILD"
exit 3
'@
            [System.IO.File]::WriteAllText((Join-Path $tmpScripts "invoke-codex.ps1"), $fakeCodex, (New-Object System.Text.UTF8Encoding($true)))

            $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tmpScripts "invoke-agent.ps1") `
                -Agent codex `
                -Role reviewer `
                -WorkDir $script:repoRoot `
                -Prompt "Test M1 stderr and exit code 3" 2>&1
            $code = $LASTEXITCODE
            $text = ($out | Out-String)

            $code | Should -Be 3
            $text | Should -Match "STDERR_FIRST_LINE_FROM_CHILD"
            $text | Should -Match "STDOUT_SECOND_LINE_FROM_CHILD"
        } finally {
            Remove-Item -LiteralPath $tmpSkill -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "enforces MAW_DEPTH recursion guard: leader at MAW_DEPTH >= 1 exits with code 2" {
        $prevDepth = $env:MAW_DEPTH
        try {
            $env:MAW_DEPTH = "1"
            $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeAgentPath `
                -Agent claude `
                -Role leader `
                -WorkDir $script:repoRoot `
                -Prompt "Attempt nested leader." `
                -DryRun 2>&1
            $LASTEXITCODE | Should -Be 2
            ($out | Out-String) | Should -Match '(?i)recursion guard triggered'
        } finally {
            $env:MAW_DEPTH = $prevDepth
        }
    }
}
