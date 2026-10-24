param(
    [Parameter(Mandatory=$true)]
    [string]$Agent,

    [Parameter(Mandatory=$true)]
    [ValidateSet("architect", "leader", "backend", "frontend", "reviewer", "tester")]
    [string]$Role,

    [Parameter(Mandatory=$false)]
    [string]$WorkDir = (Get-Location).Path,

    [Parameter(Mandatory=$false)]
    [string]$Prompt = "",

    [Parameter(Mandatory=$false)]
    [string]$PromptFile = "",

    [Parameter(Mandatory=$false)]
    [string]$Team = "",

    [Parameter(Mandatory=$false)]
    [string]$ModelOverride = "",

    [Parameter(Mandatory=$false)]
    [string]$EffortOverride = "",

    [Parameter(Mandatory=$false)]
    [switch]$NewSession,

    [Parameter(Mandatory=$false)]
    [int]$TimeoutSeconds = 1800,

    [Parameter(Mandatory=$false)]
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot "lib\maw-common.ps1")
. (Join-Path $PSScriptRoot "lib\maw-registry.ps1")

$normAgent = $Agent.Trim().ToLowerInvariant()
$normRole  = $Role.Trim().ToLowerInvariant()

$reg = Get-AgentRegistry -ScriptsDir $PSScriptRoot
$agentEntry = Get-AgentEntry -AgentId $normAgent -Registry $reg
if ($null -eq $agentEntry) {
    $allowedIds = @($reg.enabled_agents | ForEach-Object { $_.id }) -join ", "
    Write-Output "ERROR: Invalid or disabled -Agent '$normAgent'. Allowed registry agents: $allowedIds"
    exit 1
}

# 1. Recursion Guard (SPEC §5.2: MAW_DEPTH >= 1 for leader => exit 2)
$currentDepth = 0
if ($env:MAW_DEPTH) {
    [void][int]::TryParse($env:MAW_DEPTH, [ref]$currentDepth)
}
if ($normRole -eq "leader" -and $currentDepth -ge 1) {
    Write-Output "ERROR: Leader recursion guard triggered (MAW_DEPTH=$currentDepth). Nested leader delegation is forbidden."
    exit 2
}

# 2. Load & concatenate Prompt + PromptFile
if ($PromptFile) {
    if (-not (Test-Path -LiteralPath $PromptFile -PathType Leaf)) {
        Write-Error "PromptFile not found: $PromptFile"
        exit 1
    }
    $fileContent = Get-Content -LiteralPath $PromptFile -Raw -Encoding UTF8
    if ($Prompt) {
        $Prompt = "$Prompt`n`n$fileContent"
    } else {
        $Prompt = $fileContent
    }
}

# 3. Parse Team configuration (SPEC §5.2 & §7.4: registry-driven team validation and defaults)
$teamMap = [ordered]@{}
if ($PSBoundParameters.ContainsKey("Team") -or $Team) {
    $pairs = $Team -split '[,;]'
    foreach ($pair in $pairs) {
        $trimmedPair = $pair.Trim()
        if (-not $trimmedPair) { continue }
        if ($trimmedPair -notmatch '^([a-zA-Z0-9_-]+)\s*=\s*([a-zA-Z0-9_-]+)$') {
            Write-Output "ERROR: Invalid -Team entry '$trimmedPair'. Expected format: role=agent"
            exit 1
        }
        $tRole  = $Matches[1].ToLowerInvariant()
        $tAgent = $Matches[2].ToLowerInvariant()
        if ($tRole -notin @("backend", "frontend", "reviewer")) {
            Write-Output "ERROR: Invalid role '$tRole' in -Team. Allowed: backend, frontend, reviewer."
            exit 1
        }
        $tEntry = Get-AgentEntry -AgentId $tAgent -Registry $reg
        if ($null -eq $tEntry) {
            $allowedIds = @($reg.enabled_agents | ForEach-Object { $_.id }) -join ", "
            Write-Output "ERROR: Invalid or disabled agent '$tAgent' in -Team. Allowed: $allowedIds"
            exit 1
        }
        $teamMap[$tRole] = $tAgent
    }
    if ($teamMap.Count -eq 0) {
        Write-Output "ERROR: -Team was provided with no valid team members."
        exit 1
    }
} else {
    $teamMap["backend"]  = [string]$reg.defaults.team.backend
    $teamMap["frontend"] = [string]$reg.defaults.team.frontend
    $teamMap["reviewer"] = [string]$reg.defaults.team.reviewer
}

$teamTableLines = [System.Collections.Generic.List[string]]::new()
$teamTableLines.Add("| Role | Assigned Agent |")
$teamTableLines.Add("| :--- | :--- |")
foreach ($k in $teamMap.Keys) {
    $teamTableLines.Add("| $k | $($teamMap[$k]) |")
}
$teamTableMd = ($teamTableLines -join "`n")

# 4. Locate & Render Role Brief Template
$skillRoot = Split-Path -Parent $PSScriptRoot
$rolesDir  = Join-Path $skillRoot "templates\roles"
$briefPath = Join-Path $rolesDir "$normRole.md"

if (-not (Test-Path -LiteralPath $briefPath -PathType Leaf)) {
    Write-Error "Role brief template not found: $briefPath"
    exit 1
}

$rawBrief = Get-Content -LiteralPath $briefPath -Raw -Encoding UTF8
$delegateCmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\invoke-agent.ps1`" -Agent <agent> -Role <role> -WorkDir `"$WorkDir`" -PromptFile <file>"

$renderedBrief = $rawBrief.
    Replace("{{AGENT}}", $normAgent).
    Replace("{{ROLE}}", $normRole).
    Replace("{{WORKDIR}}", $WorkDir).
    Replace("{{SCRIPTS_DIR}}", $PSScriptRoot).
    Replace("{{TEAM_TABLE}}", $teamTableMd).
    Replace("{{DELEGATE_CMD}}", $delegateCmd).
    Trim()

$fullPrompt = if ($Prompt -and $Prompt.Trim()) {
    "$renderedBrief`n`n## Task Instructions`n$($Prompt.Trim())"
} else {
    $renderedBrief
}

if ($normRole -eq "reviewer") {
    $fullPrompt = Add-ReviewerContract -Prompt $fullPrompt
}

# 5. Map (Agent.adapter, Role) to Target Script & Arguments per SPEC §5.1 & §7.4
$targetScript = ""
$childArgs    = [System.Collections.Generic.List[string]]::new()

switch ($agentEntry.adapter) {
    "claude" {
        $targetScript = Join-Path $PSScriptRoot "invoke-claude.ps1"
        $claudeRole = switch ($normRole) {
            "architect" { "architect" }
            "leader"    { "leader" }
            "backend"   { "backend" }
            "frontend"  { "frontend" }
            "reviewer"  { "reviewer" }
            "tester"    { "backend" }
        }
        $childArgs.Add("-Role")
        $childArgs.Add($claudeRole)
        $childArgs.Add("-WorkDir")
        $childArgs.Add($WorkDir)
        if ($normRole -eq "reviewer") {
            $childArgs.Add("-IncludeGitDiff")
        }
        if ($ModelOverride) {
            $childArgs.Add("-ModelOverride")
            $childArgs.Add($ModelOverride)
        }
        if ($EffortOverride) {
            $childArgs.Add("-EffortOverride")
            $childArgs.Add($EffortOverride)
        }
    }
    "codex" {
        $targetScript = Join-Path $PSScriptRoot "invoke-codex.ps1"
        $codexRole = if ($normRole -eq "reviewer") { "review-diff" } else { "coder" }
        $childArgs.Add("-Role")
        $childArgs.Add($codexRole)
        $childArgs.Add("-WorkDir")
        $childArgs.Add($WorkDir)
        if ($ModelOverride) {
            $childArgs.Add("-ModelOverride")
            $childArgs.Add($ModelOverride)
        }
        if ($EffortOverride) {
            $childArgs.Add("-EffortOverride")
            $childArgs.Add($EffortOverride)
        }
    }
    "antigravity" {
        $targetScript = Join-Path $PSScriptRoot "invoke-antigravity.ps1"
        $agyAction = if ($NewSession) { "new" } else { "send-latest" }
        $childArgs.Add("-Action")
        $childArgs.Add($agyAction)
        $childArgs.Add("-WorkDir")
        $childArgs.Add($WorkDir)
        $childArgs.Add("-Title")
        $childArgs.Add("MAW [$normRole] Task")
        $childArgs.Add("-TimeoutSeconds")
        $childArgs.Add([string]$TimeoutSeconds)
        if ($NewSession -and $ModelOverride -and ($ModelOverride.ToLowerInvariant() -in @("pro", "flash", "flash_lite"))) {
            $childArgs.Add("-Model")
            $childArgs.Add($ModelOverride.ToLowerInvariant())
        }
    }
    "cli" {
        $targetScript = Join-Path $PSScriptRoot "invoke-cli-agent.ps1"
        $childArgs.Add("-AgentId")
        $childArgs.Add($normAgent)
        $childArgs.Add("-Role")
        $childArgs.Add($normRole)
        $childArgs.Add("-WorkDir")
        $childArgs.Add($WorkDir)
        if ($normRole -eq "reviewer") {
            $childArgs.Add("-IncludeGitDiff")
        }
        if ($ModelOverride) {
            $childArgs.Add("-ModelOverride")
            $childArgs.Add($ModelOverride)
        }
        if ($EffortOverride) {
            $childArgs.Add("-EffortOverride")
            $childArgs.Add($EffortOverride)
        }
        $childArgs.Add("-TimeoutSeconds")
        $childArgs.Add([string]$TimeoutSeconds)
    }
}

if ($DryRun) {
    $previewArgs = ($childArgs | ForEach-Object { ConvertTo-NativeArgument -Value $_ }) -join " "
    $scriptArg = ConvertTo-NativeArgument -Value $targetScript
    Write-Output "=== INVOKE-AGENT DRY RUN ==="
    Write-Output "DRYRUN_COMMAND: powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptArg $previewArgs -PromptFile <temp_prompt_file>"
    Write-Output "Agent         : $normAgent"
    Write-Output "Adapter       : $($agentEntry.adapter)"
    Write-Output "Role          : $normRole"
    Write-Output "TargetScript  : $targetScript"
    Write-Output "ChildArguments: $previewArgs -PromptFile <temp_prompt_file>"
    Write-Output "MAW_DEPTH     : $($currentDepth + 1)"
    Write-Output "=== RENDERED PROMPT ==="
    Write-Output $fullPrompt
    exit 0
}

$tmpPromptFile = Join-Path $env:TEMP ("maw_agent_prompt_" + [guid]::NewGuid().ToString("N") + ".txt")
$prevDepth = $env:MAW_DEPTH
$prevRole  = $env:MAW_ROLE
$prevAgent = $env:MAW_AGENT

try {
    [System.IO.File]::WriteAllText($tmpPromptFile, $fullPrompt, (New-Object System.Text.UTF8Encoding($true)))
    $childArgs.Add("-PromptFile")
    $childArgs.Add($tmpPromptFile)

    $env:MAW_DEPTH = [string]($currentDepth + 1)
    $env:MAW_ROLE  = $normRole
    $env:MAW_AGENT = $normAgent

    $execArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $targetScript) + $childArgs.ToArray()
    $outputLines = [System.Collections.Generic.List[string]]::new()

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & powershell.exe @execArgs 2>&1 | ForEach-Object {
            $line = if ($_ -is [System.Management.Automation.ErrorRecord]) {
                if ($_.Exception -and $_.Exception.Message) { $_.Exception.Message } else { $_.ToString() }
            } else {
                $_.ToString()
            }
            $outputLines.Add($line)
            Write-Output $line
        }
        $exitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
    } finally {
        $ErrorActionPreference = $prevEap
    }

    if ($agentEntry.adapter -eq "antigravity") {
        try {
            $auditFile = Join-Path $env:USERPROFILE ".gemini\antigravity\multi-ai-audit.jsonl"
            $auditDir = Split-Path -Parent $auditFile
            if (-not (Test-Path -LiteralPath $auditDir)) {
                New-Item -ItemType Directory -Path $auditDir -Force | Out-Null
            }
            $fullOut = ($outputLines -join "`n")
            $vr = Get-ReviewVerdict -Text $fullOut
            $verdict = if ($exitCode -ne 0) {
                "FAILED"
            } elseif ($normRole -eq "reviewer" -and $vr.Verdict -ne "UNKNOWN") {
                $vr.Verdict
            } else {
                "COMPLETED"
            }
            $inTokens  = [Math]::Max(1, [int][Math]::Ceiling($fullPrompt.Length / 3.8))
            $outTokens = [Math]::Max(1, [int][Math]::Ceiling($fullOut.Length / 3.8))
            $costUsd   = [Math]::Round(($inTokens * 1.25 + $outTokens * 5.0) / 1000000.0, 5)
            $agyModel  = if ($NewSession -and $ModelOverride) { $ModelOverride } else { "gemini-4-argon" }

            [ordered]@{
                Timestamp    = (Get-Date).ToString("o")
                Tool         = $normAgent
                Agent        = $normAgent
                Role         = $normRole
                Model        = $agyModel
                Effort       = "high"
                WorkDir      = $WorkDir
                PromptChars  = $fullPrompt.Length
                OutputChars  = $fullOut.Length
                InputTokens  = $inTokens
                OutputTokens = $outTokens
                CostUsd      = $costUsd
                Score        = $vr.Score
                Verdict      = $verdict
            } | ConvertTo-Json -Compress | Add-Content -Path $auditFile -Encoding UTF8 -ErrorAction SilentlyContinue
        } catch {}
    }

    exit $exitCode
} finally {
    if ($null -eq $prevDepth) { Remove-Item Env:\MAW_DEPTH -ErrorAction SilentlyContinue } else { $env:MAW_DEPTH = $prevDepth }
    if ($null -eq $prevRole)  { Remove-Item Env:\MAW_ROLE  -ErrorAction SilentlyContinue } else { $env:MAW_ROLE  = $prevRole }
    if ($null -eq $prevAgent) { Remove-Item Env:\MAW_AGENT -ErrorAction SilentlyContinue } else { $env:MAW_AGENT = $prevAgent }
    if (Test-Path -LiteralPath $tmpPromptFile) {
        Remove-Item -LiteralPath $tmpPromptFile -Force -ErrorAction SilentlyContinue
    }
}
