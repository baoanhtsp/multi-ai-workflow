BeforeAll {
    $script:origMawHome = $env:MAW_HOME
    $script:origUserProfile = $env:USERPROFILE
    $script:origTemp = $env:TEMP
    $script:origTmp = $env:TMP
    $script:origMawTest = $env:MAW_TEST
    $script:origSkipHealth = $env:MAW_SKIP_HEALTH
    $script:origRuntime = $env:MAW_S4_RUNTIME

    $script:isolatedBase = Join-Path ([System.IO.Path]::GetTempPath()) ("maw-invagent-iso-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
    $script:isoMaw = Join-Path $script:isolatedBase ".maw"
    $script:isoUser = Join-Path $script:isolatedBase "user"
    $script:isoTemp = Join-Path $script:isolatedBase "tmp"
    New-Item -ItemType Directory -Path $script:isoMaw -Force | Out-Null
    New-Item -ItemType Directory -Path $script:isoUser -Force | Out-Null
    New-Item -ItemType Directory -Path $script:isoTemp -Force | Out-Null

    $env:MAW_HOME = $script:isoMaw
    $env:USERPROFILE = $script:isoUser
    $env:TEMP = $script:isoTemp
    $env:TMP = $script:isoTemp
    $env:MAW_TEST = "1"
    $env:MAW_SKIP_HEALTH = "1"
    $env:MAW_S4_RUNTIME = Join-Path $script:isolatedBase "nonexistent-runtime.json"

    $repoRoot = Split-Path -Parent $PSScriptRoot
    $script:realRepoRoot = $repoRoot
    $script:invokeAgentPath = Join-Path $repoRoot "antigravity\skills\claude-leader\scripts\invoke-agent.ps1"
    $script:invokeCliPath   = Join-Path $repoRoot "antigravity\skills\claude-leader\scripts\invoke-cli-agent.ps1"
    $script:registryLibPath = Join-Path $repoRoot "antigravity\skills\claude-leader\scripts\lib\maw-registry.ps1"
    $script:scriptsDir      = Join-Path $repoRoot "antigravity\skills\claude-leader\scripts"
    $script:repoRoot = Join-Path $script:isoTemp "test repo"
    New-Item -ItemType Directory -Path $script:repoRoot -Force | Out-Null
    & git -C $script:repoRoot init -q 2>$null | Out-Null
    & git -C $script:repoRoot config core.autocrlf false
    & git -C $script:repoRoot config user.email "test@example.com"
    & git -C $script:repoRoot config user.name "Test"
    Copy-Item -LiteralPath (Join-Path $repoRoot "SPEC.md") -Destination (Join-Path $script:repoRoot "SPEC.md") -Force
    & git -C $script:repoRoot add -A
    & git -C $script:repoRoot commit -m "initial" -q 2>$null | Out-Null
    . $script:registryLibPath
}

AfterAll {
    if ($null -eq $script:origMawHome) { Remove-Item Env:\MAW_HOME -ErrorAction SilentlyContinue } else { $env:MAW_HOME = $script:origMawHome }
    if ($null -eq $script:origUserProfile) { Remove-Item Env:\USERPROFILE -ErrorAction SilentlyContinue } else { $env:USERPROFILE = $script:origUserProfile }
    if ($null -eq $script:origTemp) { Remove-Item Env:\TEMP -ErrorAction SilentlyContinue } else { $env:TEMP = $script:origTemp }
    if ($null -eq $script:origTmp) { Remove-Item Env:\TMP -ErrorAction SilentlyContinue } else { $env:TMP = $script:origTmp }
    if ($null -eq $script:origMawTest) { Remove-Item Env:\MAW_TEST -ErrorAction SilentlyContinue } else { $env:MAW_TEST = $script:origMawTest }
    if ($null -eq $script:origSkipHealth) { Remove-Item Env:\MAW_SKIP_HEALTH -ErrorAction SilentlyContinue } else { $env:MAW_SKIP_HEALTH = $script:origSkipHealth }
    if ($null -eq $script:origRuntime) { Remove-Item Env:\MAW_S4_RUNTIME -ErrorAction SilentlyContinue } else { $env:MAW_S4_RUNTIME = $script:origRuntime }
    if ($script:isolatedBase -and (Test-Path -LiteralPath $script:isolatedBase)) {
        Remove-Item -LiteralPath $script:isolatedBase -Recurse -Force -ErrorAction SilentlyContinue
    }
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
            Copy-Item -LiteralPath (Join-Path $script:realRepoRoot "antigravity\skills\claude-leader\agents.json") -Destination (Join-Path $tmpSkill "agents.json") -Force
            Copy-Item -LiteralPath (Join-Path $script:realRepoRoot "antigravity\skills\claude-leader\scripts\lib\maw-common.ps1") -Destination (Join-Path $tmpLib "maw-common.ps1") -Force
            Copy-Item -LiteralPath (Join-Path $script:realRepoRoot "antigravity\skills\claude-leader\scripts\lib\maw-registry.ps1") -Destination (Join-Path $tmpLib "maw-registry.ps1") -Force
            Copy-Item -LiteralPath (Join-Path $script:realRepoRoot "antigravity\skills\claude-leader\scripts\lib\maw-hooks.ps1") -Destination (Join-Path $tmpLib "maw-hooks.ps1") -Force
            Copy-Item -LiteralPath (Join-Path $script:realRepoRoot "antigravity\skills\claude-leader\templates\roles\reviewer.md") -Destination (Join-Path $tmpRoles "reviewer.md") -Force

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

    It "prevents cmd.exe BatBadBut injection on .cmd shims by quoting all args across %* and refusing forbidden characters" {
        $tmpMaw = Join-Path $env:TEMP ("maw_cmd_inj_" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmpMaw -Force | Out-Null
        $prevMaw = $env:MAW_HOME
        try {
            $env:MAW_HOME = $tmpMaw
            $fakeCmdPath = Join-Path $tmpMaw "fake-cli.cmd"
            $pwnedFile   = Join-Path $tmpMaw "pwned.txt"
            $pwnedFile2  = Join-Path $tmpMaw "pwned2.txt"
            # Note: echo %* triggers cmd.exe's second parse pass on expanded arguments (CVE-2024-24576 / BatBadBut)
            [System.IO.File]::WriteAllText($fakeCmdPath, "@echo off`r`necho %*`r`n", [System.Text.Encoding]::ASCII)

            $specialLiteralArg = "R&D (v1) | a<b > $pwnedFile2 ^ space"

            $injJson = @{
                version = 1
                agents  = @(
                    @{
                        id           = "cmd-arg-ai"
                        label        = "Cmd Arg AI"
                        color        = "#ff0000"
                        enabled      = $true
                        adapter      = "cli"
                        detect       = @{ command = $fakeCmdPath; version_args = @() }
                        models       = @("auto")
                        efforts      = @()
                        capabilities = @{ write = $true; review = $true; new_session = $false; sessions = $false; ide_send = $false }
                        cli          = @{
                            command     = $fakeCmdPath
                            prompt_via  = "arg"
                            args        = @("-p", "{prompt}")
                            role_args   = @{}
                            model_args  = @()
                            effort_args = @()
                            output      = "text"
                        }
                    },
                    @{
                        id           = "cmd-filearg-ai"
                        label        = "Cmd FileArg AI"
                        color        = "#00aa00"
                        enabled      = $true
                        adapter      = "cli"
                        detect       = @{ command = $fakeCmdPath; version_args = @() }
                        models       = @("auto")
                        efforts      = @()
                        capabilities = @{ write = $true; review = $true; new_session = $false; sessions = $false; ide_send = $false }
                        cli          = @{
                            command     = $fakeCmdPath
                            prompt_via  = "file_arg"
                            args        = @("--message-file", "{prompt_file}", "--tag", $specialLiteralArg)
                            role_args   = @{}
                            model_args  = @("-m", "{model}")
                            effort_args = @()
                            output      = "text"
                        }
                    },
                    @{
                        id           = "cmd-percent-ai"
                        label        = "Cmd Percent AI"
                        color        = "#aa00aa"
                        enabled      = $true
                        adapter      = "cli"
                        detect       = @{ command = $fakeCmdPath; version_args = @() }
                        models       = @("auto")
                        efforts      = @()
                        capabilities = @{ write = $true; review = $true; new_session = $false; sessions = $false; ide_send = $false }
                        cli          = @{
                            command     = $fakeCmdPath
                            prompt_via  = "stdin"
                            args        = @("--bad", "%PATH%")
                            role_args   = @{}
                            model_args  = @()
                            effort_args = @()
                            output      = "text"
                        }
                    }
                )
            } | ConvertTo-Json -Depth 8
            [System.IO.File]::WriteAllText((Join-Path $tmpMaw "agents.json"), $injJson, (New-Object System.Text.UTF8Encoding($false)))

            # 1. prompt_via: "arg" with .cmd shim -> refused with exit 1, pwned.txt NOT created
            $maliciousPrompt = "hello & echo PWNED > `"$pwnedFile`""
            $outArg = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeCliPath `
                -AgentId "cmd-arg-ai" `
                -Role "backend" `
                -WorkDir $tmpMaw `
                -Prompt $maliciousPrompt 2>&1
            $LASTEXITCODE | Should -Be 1
            ($outArg | Out-String) | Should -Match "Refusing to execute \.cmd/\.bat shim"
            (Test-Path -LiteralPath $pwnedFile) | Should -BeFalse

            # 2. prompt_via: "file_arg" with fake-cli.cmd (echo %*) and args containing & | < > ( ) ^ and spaces -> arrives literally, pwned2.txt NOT created
            $outFileArg = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeCliPath `
                -AgentId "cmd-filearg-ai" `
                -Role "backend" `
                -WorkDir $tmpMaw `
                -Prompt "Normal prompt in file" 2>&1
            $LASTEXITCODE | Should -Be 0
            $outFileArgText = ($outFileArg | Out-String)
            $outFileArgText | Should -Match ([regex]::Escape($specialLiteralArg))
            (Test-Path -LiteralPath $pwnedFile2) | Should -BeFalse

            # 3. Argument containing % is refused with exit 1
            $outPct = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeCliPath `
                -AgentId "cmd-percent-ai" `
                -Role "backend" `
                -WorkDir $tmpMaw `
                -Prompt "Test percent refusal" 2>&1
            $LASTEXITCODE | Should -Be 1
            ($outPct | Out-String) | Should -Match "forbidden character"
        } finally {
            $env:MAW_HOME = $prevMaw
            Remove-Item -LiteralPath $tmpMaw -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "exits 5 in invoke-agent.ps1 when a before-agent hook blocks and exits 4 in invoke-auto-gate.ps1 when a round-start hook blocks" {
        $tmpHooks = Join-Path $env:TEMP ("maw_hooks_int_" + [guid]::NewGuid().ToString("N"))
        $beforeAgentDir = Join-Path $tmpHooks "before-agent"
        $roundStartDir  = Join-Path $tmpHooks "round-start"
        New-Item -ItemType Directory -Path $beforeAgentDir -Force | Out-Null
        New-Item -ItemType Directory -Path $roundStartDir -Force | Out-Null
        $prevHooksDir = $env:MAW_HOOKS_DIR
        try {
            $utf8 = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText((Join-Path $beforeAgentDir "10-deny.ps1"), '@{ Block = $true; Reason = "Budget exceeded for " + $Context.agent }', $utf8)
            [System.IO.File]::WriteAllText((Join-Path $roundStartDir "10-deny-gate.ps1"), '@{ Block = $true; Reason = "Auto-Gate blocked in round " + $Context.round }', $utf8)

            $env:MAW_HOOKS_DIR = $tmpHooks

            # 1. invoke-agent.ps1 exits 5
            $outAgent = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeAgentPath `
                -Agent claude `
                -Role backend `
                -WorkDir $script:repoRoot `
                -Prompt "Test hook block" `
                -DryRun 2>&1
            $LASTEXITCODE | Should -Be 5
            ($outAgent | Out-String) | Should -Match "Budget exceeded for claude"

            # 2. invoke-auto-gate.ps1 exits 4
            $autoGateScript = Join-Path $script:scriptsDir "invoke-auto-gate.ps1"
            $outGate = & powershell -NoProfile -ExecutionPolicy Bypass -File $autoGateScript `
                -WorkDir $script:repoRoot `
                -SkipInitialImplement 2>&1
            $LASTEXITCODE | Should -Be 4
            ($outGate | Out-String) | Should -Match "Auto-Gate blocked in round 1"
        } finally {
            if ($null -eq $prevHooksDir) {
                Remove-Item Env:\MAW_HOOKS_DIR -ErrorAction SilentlyContinue
            } else {
                $env:MAW_HOOKS_DIR = $prevHooksDir
            }
            Remove-Item -LiteralPath $tmpHooks -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "supports hook string pass-through, PrependPrompt, and Suggest (HOOK_BLOCKED_SUGGEST) in invoke-agent.ps1 (D14)" {
        $tmpHooks = Join-Path $env:TEMP ("maw_hooks_d14_" + [guid]::NewGuid().ToString("N"))
        $beforeAgentDir = Join-Path $tmpHooks "before-agent"
        New-Item -ItemType Directory -Path $beforeAgentDir -Force | Out-Null
        $prevHooksDir = $env:MAW_HOOKS_DIR
        try {
            $utf8 = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText((Join-Path $beforeAgentDir "10-prep.ps1"), 'Write-Output "[S4] budget warning: 80% used"; @{ Block = $false; PrependPrompt = "<!-- INJECTED_POLICY_HEADER -->" }', $utf8)
            $env:MAW_HOOKS_DIR = $tmpHooks

            $outPrep = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeAgentPath `
                -Agent claude `
                -Role backend `
                -WorkDir $script:repoRoot `
                -Prompt "Check prepend and string pass-through" `
                -DryRun 2>&1
            $LASTEXITCODE | Should -Be 0
            $prepText = ($outPrep | Out-String)
            $prepText | Should -Match "\[S4\] budget warning: 80% used"
            $prepText | Should -Match "<!-- INJECTED_POLICY_HEADER -->"

            # Now add a blocking hook with Suggest
            [System.IO.File]::WriteAllText((Join-Path $beforeAgentDir "20-suggest.ps1"), '@{ Block = $true; Reason = "Cooldown active"; Suggest = "codex" }', $utf8)
            $outSug = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeAgentPath `
                -Agent claude `
                -Role backend `
                -WorkDir $script:repoRoot `
                -Prompt "Check suggest block" `
                -DryRun 2>&1
            $LASTEXITCODE | Should -Be 5
            $sugText = ($outSug | Out-String)
            $sugText | Should -Match "HOOK_BLOCKED \(before-agent\): Cooldown active"
            $sugText | Should -Match "HOOK_BLOCKED_SUGGEST: codex"
        } finally {
            if ($null -eq $prevHooksDir) {
                Remove-Item Env:\MAW_HOOKS_DIR -ErrorAction SilentlyContinue
            } else {
                $env:MAW_HOOKS_DIR = $prevHooksDir
            }
            Remove-Item -LiteralPath $tmpHooks -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "preserves strict line ordering for 200 sequential lines in invoke-cli-agent.ps1 (D15)" {
        $tmpMaw = Join-Path $env:TEMP ("maw_cli_order_" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmpMaw -Force | Out-Null
        $prevMaw = $env:MAW_HOME
        try {
            $env:MAW_HOME = $tmpMaw
            $orderJson = @{
                version = 1
                agents  = @(
                    @{
                        id           = "order-test-ai"
                        label        = "Order Test AI"
                        color        = "#123456"
                        enabled      = $true
                        adapter      = "cli"
                        detect       = @{ command = "powershell.exe"; version_args = @() }
                        models       = @("auto")
                        efforts      = @()
                        capabilities = @{ write = $true; review = $true; new_session = $false; sessions = $false; ide_send = $false }
                        cli          = @{
                            command     = "powershell.exe"
                            prompt_via  = "stdin"
                            args        = @("-NoProfile", "-Command", '1..200 | ForEach-Object { [Console]::Out.WriteLine(("LINE_{0:D3}" -f $_)) }')
                            role_args   = @{}
                            model_args  = @()
                            effort_args = @()
                            output      = "text"
                        }
                    }
                )
            } | ConvertTo-Json -Depth 8
            [System.IO.File]::WriteAllText((Join-Path $tmpMaw "agents.json"), $orderJson, (New-Object System.Text.UTF8Encoding($false)))

            $outLines = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeCliPath `
                -AgentId "order-test-ai" `
                -Role "backend" `
                -WorkDir $tmpMaw `
                -Prompt "Print 200 ordered lines" 2>&1
            $LASTEXITCODE | Should -Be 0
            $matched = @($outLines | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -match '^LINE_\d{3}$' })
            $matched.Count | Should -Be 200
            for ($i = 1; $i -le 200; $i++) {
                $expected = ("LINE_{0:D3}" -f $i)
                $matched[$i - 1] | Should -BeExactly $expected
            }
        } finally {
            $env:MAW_HOME = $prevMaw
            Remove-Item -LiteralPath $tmpMaw -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    It "forwards -ResumeId across claude, codex, antigravity, and cli adapters (C11)" {
        $outClaude = & $script:invokeAgentPath -Agent claude -Role backend -WorkDir $script:repoRoot -ResumeId "sess-claude-1" -Prompt "Resume claude" -DryRun 2>&1
        ($outClaude | Out-String) | Should -Match '-ResumeId sess-claude-1'

        $outCodex = & $script:invokeAgentPath -Agent codex -Role backend -WorkDir $script:repoRoot -ResumeId "sess-codex-2" -Prompt "Resume codex" -DryRun 2>&1
        ($outCodex | Out-String) | Should -Match '-ResumeId sess-codex-2'

        $outAgy = & $script:invokeAgentPath -Agent antigravity -Role backend -WorkDir $script:repoRoot -ResumeId "conv-agy-3" -Prompt "Resume agy" -DryRun 2>&1
        $agyText = ($outAgy | Out-String)
        $agyText | Should -Match '-Action send\b'
        $agyText | Should -Match '-ConversationId conv-agy-3'

        $outCli = & $script:invokeCliPath -AgentId gemini -Role backend -WorkDir $script:repoRoot -ResumeId "sess-gem-4" -Prompt "Resume gemini" -DryRun 2>&1
        ($outCli | Out-String) | Should -Match '"--resume","sess-gem-4"'
    }

    It "H9.1: appends # Language instruction for -ReplyLanguage vi|en across claude, codex, antigravity, and cli adapters, and omits when not passed" {
        foreach ($ag in @("claude", "codex", "antigravity", "gemini")) {
            $outVi = & $script:invokeAgentPath -Agent $ag -Role backend -WorkDir $script:repoRoot -ReplyLanguage vi -Prompt "Check vi" -DryRun 2>&1
            $LASTEXITCODE | Should -Be 0
            $textVi = ($outVi | Out-String)
            $textVi | Should -Match '# Language\r?\nAlways reply in Vietnamese \(tiếng Việt\), whatever language the message or the history uses\. Keep code, commands, file paths and identifiers as they are\.'

            $outEn = & $script:invokeAgentPath -Agent $ag -Role backend -WorkDir $script:repoRoot -ReplyLanguage en -Prompt "Check en" -DryRun 2>&1
            $LASTEXITCODE | Should -Be 0
            $textEn = ($outEn | Out-String)
            $textEn | Should -Match '# Language\r?\nAlways reply in English\. Keep code, commands, file paths and identifiers as they are\.'
        }

        $outNone = & $script:invokeAgentPath -Agent claude -Role backend -WorkDir $script:repoRoot -Prompt "Check default" -DryRun 2>&1
        $LASTEXITCODE | Should -Be 0
        ($outNone | Out-String) | Should -Not -Match '# Language'
    }

    It "S7: resolves -Account from accounts.json, forwards -Account in DryRun, and rejects unknown or disabled accounts" {
        $tmpMaw = Join-Path $env:TEMP ("maw_s7_acc_" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $tmpMaw -Force | Out-Null
        $accDir = Join-Path $tmpMaw "accounts\claude\work"
        New-Item -ItemType Directory -Path $accDir -Force | Out-Null

        $accJson = @{
            version  = 1
            accounts = @(
                @{
                    agent    = "claude"
                    id       = "work"
                    label    = "Claude Work"
                    dir      = $accDir
                    priority = 1
                    enabled  = $true
                },
                @{
                    agent    = "claude"
                    id       = "disabled-acc"
                    label    = "Disabled"
                    dir      = $accDir
                    priority = 2
                    enabled  = $false
                }
            )
        } | ConvertTo-Json -Depth 6
        [System.IO.File]::WriteAllText((Join-Path $tmpMaw "accounts.json"), $accJson, (New-Object System.Text.UTF8Encoding($false)))

        $prevMaw = $env:MAW_HOME
        try {
            $env:MAW_HOME = $tmpMaw

            $outWork = & $script:invokeAgentPath -Agent claude -Account work -Role backend -WorkDir $script:repoRoot -Prompt "Test work account" -DryRun 2>&1
            $LASTEXITCODE | Should -Be 0
            ($outWork | Out-String) | Should -Match '-Account work'

            $outUnknown = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeAgentPath -Agent claude -Account nonexistent -Role backend -WorkDir $script:repoRoot -Prompt "Test unknown" -DryRun 2>&1
            $LASTEXITCODE | Should -Not -Be 0
            ($outUnknown | Out-String) | Should -Match 'Unknown account'

            $outDisabled = & powershell -NoProfile -ExecutionPolicy Bypass -File $script:invokeAgentPath -Agent claude -Account "disabled-acc" -Role backend -WorkDir $script:repoRoot -Prompt "Test disabled" -DryRun 2>&1
            $LASTEXITCODE | Should -Not -Be 0
            ($outDisabled | Out-String) | Should -Match 'disabled'
        } finally {
            $env:MAW_HOME = $prevMaw
            Remove-Item -LiteralPath $tmpMaw -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
