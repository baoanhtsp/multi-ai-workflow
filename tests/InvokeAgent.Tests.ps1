BeforeAll {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $script:invokeAgentPath = Join-Path $repoRoot "antigravity\skills\claude-leader\scripts\invoke-agent.ps1"
    $script:invokeCliPath   = Join-Path $repoRoot "antigravity\skills\claude-leader\scripts\invoke-cli-agent.ps1"
    $script:registryLibPath = Join-Path $repoRoot "antigravity\skills\claude-leader\scripts\lib\maw-registry.ps1"
    $script:scriptsDir      = Join-Path $repoRoot "antigravity\skills\claude-leader\scripts"
    $script:repoRoot = $repoRoot
    . $script:registryLibPath
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
            Copy-Item -LiteralPath (Join-Path $script:repoRoot "antigravity\skills\claude-leader\agents.json") -Destination (Join-Path $tmpSkill "agents.json") -Force
            Copy-Item -LiteralPath (Join-Path $script:repoRoot "antigravity\skills\claude-leader\scripts\lib\maw-common.ps1") -Destination (Join-Path $tmpLib "maw-common.ps1") -Force
            Copy-Item -LiteralPath (Join-Path $script:repoRoot "antigravity\skills\claude-leader\scripts\lib\maw-registry.ps1") -Destination (Join-Path $tmpLib "maw-registry.ps1") -Force
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

Describe "v4.0 Agent Registry (lib/maw-registry.ps1) & CLI Adapter (invoke-cli-agent.ps1)" {
    It "merges user overrides, disables entries, skips invalid entries, and ignores corrupt user file" {
        $tmpMaw = Join-Path $env:TEMP ("maw_reg_ps_" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmpMaw -Force | Out-Null
        try {
            $userJson = @{
                version  = 1
                defaults = @{
                    council     = @("claude", "gemini")
                    implementer = "gemini"
                }
                agents   = @(
                    @{
                        id     = "gemini"
                        label  = "Gemini Custom PS"
                        models = @("pro")
                    },
                    @{
                        id      = "aider"
                        enabled = $false
                    },
                    @{
                        id      = "INVALID_CAPS_ID"
                        label   = "Bad ID"
                        adapter = "cli"
                    }
                )
            } | ConvertTo-Json -Depth 6
            [System.IO.File]::WriteAllText((Join-Path $tmpMaw "agents.json"), $userJson, (New-Object System.Text.UTF8Encoding($false)))

            $reg = Get-AgentRegistry -ScriptsDir $script:scriptsDir -MawHome $tmpMaw
            $reg.defaults.implementer | Should -Be "gemini"
            ($reg.defaults.council -join ",") | Should -Be "claude,gemini"
            $enabledIds = @($reg.agents | ForEach-Object { $_.id })
            $enabledIds | Should -Not -Contain "aider"
            $allIds = @($reg.all_agents | ForEach-Object { $_.id })
            $allIds | Should -Contain "aider"
            $gem = Get-AgentEntry -AgentId "gemini" -Registry $reg
            $gem.label | Should -Be "Gemini Custom PS"
            ($reg.registry_warnings -join " ") | Should -Match "INVALID_CAPS_ID"

            # Corrupt user file
            [System.IO.File]::WriteAllText((Join-Path $tmpMaw "agents.json"), "{broken-json", (New-Object System.Text.UTF8Encoding($false)))
            $regCorrupt = Get-AgentRegistry -ScriptsDir $script:scriptsDir -MawHome $tmpMaw
            $regCorrupt.agents.Count | Should -Be 6
            $regCorrupt.registry_warnings.Count | Should -BeGreaterThan 0
        } finally {
            Remove-Item -LiteralPath $tmpMaw -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "renders CLI adapter -DryRun argument arrays for gemini, cursor, and aider across all 6 roles with placeholders" {
        $cliAgents = @("gemini", "cursor", "aider")
        $roles     = @("architect", "leader", "backend", "frontend", "reviewer", "tester")
        $prevDepth = $env:MAW_DEPTH
        $tmpWorkDir = Join-Path $env:TEMP ("maw_cli_dryrun_" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmpWorkDir -Force | Out-Null
        try {
            $env:MAW_DEPTH = "0"
            foreach ($ag in $cliAgents) {
                foreach ($rl in $roles) {
                    $out = & $script:invokeCliPath `
                        -AgentId $ag `
                        -Role $rl `
                        -WorkDir $tmpWorkDir `
                        -Prompt "Verify CLI dryrun for $ag in role $rl" `
                        -DryRun 2>&1
                    $code = $LASTEXITCODE
                    $text = ($out | Out-String)

                    $code | Should -Be 0
                    $text | Should -Match "DRYRUN_COMMAND:"
                    $text | Should -Match "DRYRUN_ARGS_JSON:"

                    if ($ag -eq "gemini") {
                        $text | Should -Match "PROMPT_VIA:\s*stdin"
                        if ($rl -eq "reviewer") {
                            $text | Should -Match '"--approval-mode","plan"'
                        } else {
                            $text | Should -Match '"--approval-mode","yolo"'
                        }
                    } elseif ($ag -eq "cursor") {
                        $text | Should -Match "PROMPT_VIA:\s*arg"
                        if ($rl -eq "reviewer") {
                            $text | Should -Not -Match '"--force"'
                        } else {
                            $text | Should -Match '"--force"'
                        }
                    } elseif ($ag -eq "aider") {
                        $text | Should -Match "PROMPT_VIA:\s*file_arg"
                        $text | Should -Match '"--message-file"'
                        if ($rl -eq "reviewer") {
                            $text | Should -Match '"--dry-run"'
                        }
                    }
                }
            }
        } finally {
            $env:MAW_DEPTH = $prevDepth
            Remove-Item -LiteralPath $tmpWorkDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "refuses arg-mode prompts exceeding max_arg_chars with exit code 1, exits 127 for missing command, and exits 124 on timeout" {
        $tmpMaw = Join-Path $env:TEMP ("maw_cli_edge_" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmpMaw -Force | Out-Null
        $prevMaw = $env:MAW_HOME
        try {
            $env:MAW_HOME = $tmpMaw
            $edgeJson = @{
                version = 1
                agents  = @(
                    @{
                        id           = "tiny-arg-ai"
                        label        = "Tiny Arg AI"
                        color        = "#112233"
                        enabled      = $true
                        adapter      = "cli"
                        detect       = @{ command = "powershell.exe"; version_args = @() }
                        models       = @("auto")
                        efforts      = @()
                        capabilities = @{ write = $true; review = $true; new_session = $false; sessions = $false; ide_send = $false }
                        cli          = @{
                            command       = "powershell.exe"
                            prompt_via    = "arg"
                            args          = @("-NoProfile", "-Command", "{prompt}")
                            role_args     = @{}
                            model_args    = @()
                            effort_args   = @()
                            output        = "text"
                            max_arg_chars = 50
                        }
                    },
                    @{
                        id           = "missing-bin-ai"
                        label        = "Missing Bin AI"
                        color        = "#445566"
                        enabled      = $true
                        adapter      = "cli"
                        detect       = @{ command = "missing-bin-xyz-99999"; version_args = @("--version") }
                        models       = @("auto")
                        efforts      = @()
                        capabilities = @{ write = $true; review = $true; new_session = $false; sessions = $false; ide_send = $false }
                        cli          = @{
                            command     = "missing-bin-xyz-99999"
                            prompt_via  = "stdin"
                            args        = @()
                            role_args   = @{}
                            model_args  = @()
                            effort_args = @()
                            output      = "text"
                        }
                    },
                    @{
                        id           = "slow-timeout-ai"
                        label        = "Slow Timeout AI"
                        color        = "#778899"
                        enabled      = $true
                        adapter      = "cli"
                        detect       = @{ command = "powershell.exe"; version_args = @() }
                        models       = @("auto")
                        efforts      = @()
                        capabilities = @{ write = $true; review = $true; new_session = $false; sessions = $false; ide_send = $false }
                        cli          = @{
                            command     = "powershell.exe"
                            prompt_via  = "stdin"
                            args        = @("-NoProfile", "-Command", "Start-Sleep -Seconds 30")
                            role_args   = @{}
                            model_args  = @()
                            effort_args = @()
                            output      = "text"
                        }
                    }
                )
            } | ConvertTo-Json -Depth 8
            [System.IO.File]::WriteAllText((Join-Path $tmpMaw "agents.json"), $edgeJson, (New-Object System.Text.UTF8Encoding($false)))

            # 1. max_arg_chars exceeded -> exit 1
            $longPrompt = "X" * 100
            $outMax = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeCliPath `
                -AgentId "tiny-arg-ai" `
                -Role "backend" `
                -WorkDir $script:repoRoot `
                -Prompt $longPrompt `
                -DryRun 2>&1
            $LASTEXITCODE | Should -Be 1
            ($outMax | Out-String) | Should -Match "max_arg_chars"

            # 2. Missing command -> exit 127
            $outMissing = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeCliPath `
                -AgentId "missing-bin-ai" `
                -Role "backend" `
                -WorkDir $script:repoRoot `
                -Prompt "Test missing command" 2>&1
            $LASTEXITCODE | Should -Be 127
            ($outMissing | Out-String) | Should -Match "Missing Bin AI is not installed \(command 'missing-bin-xyz-99999' not found\)\."

            # 3. Timeout -> exit 124
            $outTimeout = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeCliPath `
                -AgentId "slow-timeout-ai" `
                -Role "backend" `
                -WorkDir $script:repoRoot `
                -Prompt "Test timeout" `
                -TimeoutSeconds 1 2>&1
            $LASTEXITCODE | Should -Be 124
        } finally {
            $env:MAW_HOME = $prevMaw
            Remove-Item -LiteralPath $tmpMaw -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
