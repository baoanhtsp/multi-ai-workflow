# Agent Registry Loader & Owner Resolver (SPEC §7.1 - §7.4, Windows PowerShell 5.1 compatible)

function Merge-AgentEntryObjects {
    param(
        [hashtable]$BaseEntry,
        [psobject]$OverrideObj
    )

    $merged = @{}
    foreach ($k in $BaseEntry.Keys) {
        $merged[$k] = $BaseEntry[$k]
    }

    foreach ($prop in $OverrideObj.PSObject.Properties) {
        $name = $prop.Name
        $val  = $prop.Value
        if ($null -eq $val) { continue }

        if ($name -in @("capabilities", "detect", "cli") -and $merged.ContainsKey($name) -and $null -ne $merged[$name] -and ($val -is [psobject])) {
            $sub = @{}
            if ($merged[$name] -is [hashtable]) {
                foreach ($sk in $merged[$name].Keys) { $sub[$sk] = $merged[$name][$sk] }
            } else {
                foreach ($sp in $merged[$name].PSObject.Properties) { $sub[$sp.Name] = $sp.Value }
            }
            foreach ($up in $val.PSObject.Properties) {
                if ($null -ne $up.Value) {
                    $sub[$up.Name] = $up.Value
                }
            }
            $merged[$name] = $sub
        } else {
            $merged[$name] = $val
        }
    }

    return [PSCustomObject]$merged
}

function ConvertTo-ValidatedAgentEntry {
    param(
        [psobject]$RawEntry,
        [string]$SourceLabel,
        [System.Collections.Generic.List[string]]$Warnings
    )

    if ($null -eq $RawEntry) {
        $Warnings.Add("${SourceLabel}: skipped null agent entry.")
        return $null
    }

    $id = ([string]($RawEntry.id)).Trim().ToLowerInvariant()
    if (-not $id -or $id -notmatch '^[a-z][a-z0-9-]{1,23}$') {
        $Warnings.Add("${SourceLabel}: skipped entry with invalid id '$id' (must match ^[a-z][a-z0-9-]{1,23}$).")
        return $null
    }

    $label = ([string]($RawEntry.label)).Trim()
    if (-not $label) {
        $Warnings.Add("${SourceLabel}: skipped agent '$id' because label is empty.")
        return $null
    }

    $color = if ($null -ne $RawEntry.color -and ([string]$RawEntry.color).Trim() -ne "") {
        ([string]$RawEntry.color).Trim()
    } else {
        "#64748b"
    }
    if ($color -notmatch '^#[0-9a-fA-F]{6}$') {
        $Warnings.Add("${SourceLabel}: skipped agent '$id' with invalid color '$color' (expected #RRGGBB).")
        return $null
    }

    $enabled = if ($null -ne $RawEntry.enabled) {
        if ($RawEntry.enabled -is [bool]) {
            [bool]$RawEntry.enabled
        } else {
            $Warnings.Add("${SourceLabel}: skipped agent '$id' because 'enabled' is not a boolean.")
            return $null
        }
    } else {
        $true
    }

    $adapter = ([string]($RawEntry.adapter)).Trim().ToLowerInvariant()
    if ($adapter -notin @("claude", "codex", "antigravity", "cli")) {
        $Warnings.Add("${SourceLabel}: skipped agent '$id' with unsupported adapter '$adapter'.")
        return $null
    }

    $aliases = [System.Collections.Generic.List[string]]::new()
    if ($null -ne $RawEntry.aliases) {
        foreach ($a in @($RawEntry.aliases)) {
            $at = ([string]$a).Trim().ToLowerInvariant()
            if ($at -and -not $aliases.Contains($at)) {
                $aliases.Add($at)
            }
        }
    }

    $detectCmd = $id
    $detectArgs = @("--version")
    if ($null -ne $RawEntry.detect) {
        $dObj = $RawEntry.detect
        $rawDCmd = if ($dObj -is [hashtable]) { $dObj["command"] } else { $dObj.command }
        $rawDArgs = if ($dObj -is [hashtable]) { $dObj["version_args"] } else { $dObj.version_args }
        if ($rawDCmd -and ([string]$rawDCmd).Trim()) {
            $detectCmd = ([string]$rawDCmd).Trim()
        }
        if ($null -ne $rawDArgs) {
            $detectArgs = @($rawDArgs | ForEach-Object { [string]$_ })
        }
    }

    $models = [System.Collections.Generic.List[string]]::new()
    if ($null -ne $RawEntry.models) {
        foreach ($m in @($RawEntry.models)) {
            $mt = ([string]$m).Trim()
            if ($mt -and -not $models.Contains($mt)) {
                $models.Add($mt)
            }
        }
    }

    $efforts = [System.Collections.Generic.List[string]]::new()
    if ($null -ne $RawEntry.efforts) {
        foreach ($e in @($RawEntry.efforts)) {
            $et = ([string]$e).Trim().ToLowerInvariant()
            if ($et -and -not $efforts.Contains($et)) {
                $efforts.Add($et)
            }
        }
    }

    $capWrite = $true
    $capReview = $true
    $capNewSession = $false
    $capSessions = $false
    $capIdeSend = $false
    if ($null -ne $RawEntry.capabilities) {
        $cObj = $RawEntry.capabilities
        $getCap = {
            param($obj, $key, $def)
            $v = if ($obj -is [hashtable]) { $obj[$key] } else { $obj.$key }
            if ($null -eq $v) { return $def }
            return [bool]$v
        }
        $capWrite      = & $getCap $cObj "write" $true
        $capReview     = & $getCap $cObj "review" $true
        $capNewSession = & $getCap $cObj "new_session" $false
        $capSessions   = & $getCap $cObj "sessions" $false
        $capIdeSend    = & $getCap $cObj "ide_send" $false
    }

    $cliBlock = $null
    if ($adapter -eq "cli") {
        $rawCli = $RawEntry.cli
        if ($null -eq $rawCli) {
            $Warnings.Add("${SourceLabel}: skipped CLI agent '$id' because 'cli' configuration block is missing.")
            return $null
        }
        $getCliProp = {
            param($obj, $key)
            if ($obj -is [hashtable]) { return $obj[$key] }
            return $obj.$key
        }
        $cliCommand = ([string](& $getCliProp $rawCli "command")).Trim()
        if (-not $cliCommand) {
            $Warnings.Add("${SourceLabel}: skipped CLI agent '$id' because cli.command is empty.")
            return $null
        }
        $promptVia = ([string](& $getCliProp $rawCli "prompt_via")).Trim().ToLowerInvariant()
        if ($promptVia -notin @("stdin", "file_arg", "arg")) {
            $Warnings.Add("${SourceLabel}: skipped CLI agent '$id' with invalid cli.prompt_via '$promptVia'.")
            return $null
        }
        $rawCliArgs = & $getCliProp $rawCli "args"
        $cliArgs = if ($null -ne $rawCliArgs) { @($rawCliArgs | ForEach-Object { [string]$_ }) } else { @() }

        $roleArgsMap = @{}
        $rawRoleArgs = & $getCliProp $rawCli "role_args"
        if ($null -ne $rawRoleArgs) {
            if ($rawRoleArgs -is [hashtable]) {
                foreach ($rk in $rawRoleArgs.Keys) {
                    $roleArgsMap[[string]$rk] = @($rawRoleArgs[$rk] | ForEach-Object { [string]$_ })
                }
            } else {
                foreach ($rp in $rawRoleArgs.PSObject.Properties) {
                    $roleArgsMap[$rp.Name] = @($rp.Value | ForEach-Object { [string]$_ })
                }
            }
        }

        $rawModelArgs = & $getCliProp $rawCli "model_args"
        $modelArgs = if ($null -ne $rawModelArgs) { @($rawModelArgs | ForEach-Object { [string]$_ }) } else { @() }

        $rawEffortArgs = & $getCliProp $rawCli "effort_args"
        $effortArgs = if ($null -ne $rawEffortArgs) { @($rawEffortArgs | ForEach-Object { [string]$_ }) } else { @() }

        $cliOutput = ([string](& $getCliProp $rawCli "output")).Trim().ToLowerInvariant()
        if (-not $cliOutput) { $cliOutput = "text" }
        if ($cliOutput -notin @("text", "gemini-json")) {
            $Warnings.Add("${SourceLabel}: skipped CLI agent '$id' with invalid cli.output '$cliOutput'.")
            return $null
        }

        $rawMaxArg = & $getCliProp $rawCli "max_arg_chars"
        $maxArgChars = 30000
        if ($null -ne $rawMaxArg) {
            $parsedMax = 0
            if ([int]::TryParse([string]$rawMaxArg, [ref]$parsedMax) -and $parsedMax -gt 0) {
                $maxArgChars = $parsedMax
            }
        }

        $inMtok = 0.0
        $outMtok = 0.0
        $rawPricing = & $getCliProp $rawCli "pricing"
        if ($null -ne $rawPricing) {
            $rawIn = if ($rawPricing -is [hashtable]) { $rawPricing["input_per_mtok"] } else { $rawPricing.input_per_mtok }
            $rawOut = if ($rawPricing -is [hashtable]) { $rawPricing["output_per_mtok"] } else { $rawPricing.output_per_mtok }
            if ($null -ne $rawIn) { [void][double]::TryParse([string]$rawIn, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$inMtok) }
            if ($null -ne $rawOut) { [void][double]::TryParse([string]$rawOut, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$outMtok) }
        }

        $cliBlock = [PSCustomObject]@{
            command       = $cliCommand
            prompt_via    = $promptVia
            args          = [string[]]$cliArgs
            role_args     = $roleArgsMap
            model_args    = [string[]]$modelArgs
            effort_args   = [string[]]$effortArgs
            output        = $cliOutput
            max_arg_chars = $maxArgChars
            pricing       = [PSCustomObject]@{
                input_per_mtok  = $inMtok
                output_per_mtok = $outMtok
            }
        }
    }

    return @{
        id           = $id
        label        = $label
        color        = $color
        enabled      = $enabled
        adapter      = $adapter
        aliases      = [string[]]$aliases.ToArray()
        detect       = [PSCustomObject]@{
            command      = $detectCmd
            version_args = [string[]]$detectArgs
        }
        models       = [string[]]$models.ToArray()
        efforts      = [string[]]$efforts.ToArray()
        capabilities = [PSCustomObject]@{
            write       = $capWrite
            review      = $capReview
            new_session = $capNewSession
            sessions    = $capSessions
            ide_send    = $capIdeSend
        }
        cli          = $cliBlock
    }
}

function Get-AgentRegistry {
    param(
        [Parameter(Mandatory=$false)]
        [string]$ScriptsDir = "",

        [Parameter(Mandatory=$false)]
        [string]$MawHome = "",

        [Parameter(Mandatory=$false)]
        [switch]$IncludeDisabled
    )

    if (-not $ScriptsDir) {
        $ScriptsDir = Split-Path -Parent $PSScriptRoot
    }
    $skillDir = Split-Path -Parent $ScriptsDir
    $shippedFile = Join-Path $skillDir "agents.json"
    if (-not (Test-Path -LiteralPath $shippedFile -PathType Leaf)) {
        $altShipped = Join-Path $ScriptsDir "agents.json"
        if (Test-Path -LiteralPath $altShipped -PathType Leaf) {
            $shippedFile = $altShipped
        }
    }

    if (-not $MawHome) {
        if ($env:MAW_HOME -and $env:MAW_HOME.Trim()) {
            $MawHome = $env:MAW_HOME.Trim()
        } else {
            $userProf = if ($env:USERPROFILE) { $env:USERPROFILE } else { "C:\Users\Admin" }
            $MawHome = Join-Path $userProf ".maw"
        }
    }
    $userFile = Join-Path $MawHome "agents.json"

    $warnings = [System.Collections.Generic.List[string]]::new()
    $entriesById = [ordered]@{}

    $defaultsTeam = [ordered]@{
        backend  = "antigravity"
        frontend = "claude"
        reviewer = "codex"
    }
    $defaultsCouncil = @("claude", "codex")
    $defaultsImplementer = "antigravity"

    # 1. Load shipped agents.json
    if (Test-Path -LiteralPath $shippedFile -PathType Leaf) {
        try {
            $rawShipped = Get-Content -LiteralPath $shippedFile -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
            if ($null -ne $rawShipped.defaults) {
                if ($null -ne $rawShipped.defaults.team) {
                    foreach ($tk in @("backend", "frontend", "reviewer")) {
                        $tv = $rawShipped.defaults.team.$tk
                        if ($tv -and ([string]$tv).Trim()) {
                            $defaultsTeam[$tk] = ([string]$tv).Trim().ToLowerInvariant()
                        }
                    }
                }
                if ($null -ne $rawShipped.defaults.council) {
                    $cArr = @($rawShipped.defaults.council | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Where-Object { $_ })
                    if ($cArr.Count -gt 0) { $defaultsCouncil = $cArr }
                }
                if ($rawShipped.defaults.implementer -and ([string]$rawShipped.defaults.implementer).Trim()) {
                    $defaultsImplementer = ([string]$rawShipped.defaults.implementer).Trim().ToLowerInvariant()
                }
            }
            if ($null -ne $rawShipped.agents) {
                foreach ($rawAgent in @($rawShipped.agents)) {
                    $valid = ConvertTo-ValidatedAgentEntry -RawEntry $rawAgent -SourceLabel "shipped agents.json" -Warnings $warnings
                    if ($null -ne $valid) {
                        $entriesById[$valid.id] = $valid
                    }
                }
            }
        } catch {
            $warnings.Add("Failed to parse shipped agents.json at '$shippedFile': $($_.Exception.Message)")
        }
    } else {
        $warnings.Add("Shipped agents.json not found at '$shippedFile'.")
    }

    # 2. Merge optional user file ($MAW_HOME/agents.json)
    if (Test-Path -LiteralPath $userFile -PathType Leaf) {
        try {
            $rawText = Get-Content -LiteralPath $userFile -Raw -Encoding UTF8
            $rawUser = $rawText | ConvertFrom-Json -ErrorAction Stop
            if ($null -eq $rawUser -or ($rawUser -is [array])) {
                throw "Root JSON value must be an object."
            }

            if ($null -ne $rawUser.defaults) {
                if ($null -ne $rawUser.defaults.team) {
                    foreach ($tk in @("backend", "frontend", "reviewer")) {
                        $tv = $rawUser.defaults.team.$tk
                        if ($tv -and ([string]$tv).Trim()) {
                            $defaultsTeam[$tk] = ([string]$tv).Trim().ToLowerInvariant()
                        }
                    }
                }
                if ($null -ne $rawUser.defaults.council) {
                    $cArr = @($rawUser.defaults.council | ForEach-Object { ([string]$_).Trim().ToLowerInvariant() } | Where-Object { $_ })
                    if ($cArr.Count -gt 0) { $defaultsCouncil = $cArr }
                }
                if ($rawUser.defaults.implementer -and ([string]$rawUser.defaults.implementer).Trim()) {
                    $defaultsImplementer = ([string]$rawUser.defaults.implementer).Trim().ToLowerInvariant()
                }
            }

            if ($null -ne $rawUser.agents) {
                if ($rawUser.agents -isnot [array] -and $rawUser.agents.GetType().Name -ne "Object[]") {
                    $warnings.Add("User agents.json ('$userFile'): 'agents' field must be an array.")
                } else {
                    foreach ($uAgent in @($rawUser.agents)) {
                        $uId = if ($null -ne $uAgent -and $null -ne $uAgent.id) { ([string]$uAgent.id).Trim().ToLowerInvariant() } else { "" }
                        if ($uId -and $entriesById.Contains($uId)) {
                            $mergedCandidate = Merge-AgentEntryObjects -BaseEntry $entriesById[$uId] -OverrideObj $uAgent
                            $validMerged = ConvertTo-ValidatedAgentEntry -RawEntry $mergedCandidate -SourceLabel "user agents.json ($userFile)" -Warnings $warnings
                            if ($null -ne $validMerged) {
                                $entriesById[$uId] = $validMerged
                            }
                        } else {
                            $validNew = ConvertTo-ValidatedAgentEntry -RawEntry $uAgent -SourceLabel "user agents.json ($userFile)" -Warnings $warnings
                            if ($null -ne $validNew) {
                                $entriesById[$validNew.id] = $validNew
                            }
                        }
                    }
                }
            }
        } catch {
            $warnings.Add("Ignored invalid user agents.json at '$userFile': $($_.Exception.Message)")
        }
    }

    $allAgentsList = [System.Collections.Generic.List[psobject]]::new()
    $enabledAgentsList = [System.Collections.Generic.List[psobject]]::new()
    foreach ($k in $entriesById.Keys) {
        $obj = [PSCustomObject]$entriesById[$k]
        $allAgentsList.Add($obj)
        if ($obj.enabled) {
            $enabledAgentsList.Add($obj)
        }
    }

    return [PSCustomObject]@{
        version           = 1
        defaults          = [PSCustomObject]@{
            team        = [PSCustomObject]$defaultsTeam
            council     = [string[]]$defaultsCouncil
            implementer = $defaultsImplementer
        }
        agents            = if ($IncludeDisabled) { $allAgentsList.ToArray() } else { $enabledAgentsList.ToArray() }
        all_agents        = $allAgentsList.ToArray()
        enabled_agents    = $enabledAgentsList.ToArray()
        registry_warnings = [string[]]$warnings.ToArray()
        shipped_path      = $shippedFile
        user_path         = $userFile
    }
}

function Get-AgentEntry {
    param(
        [Parameter(Mandatory=$true)]
        [string]$AgentId,

        [Parameter(Mandatory=$false)]
        [psobject]$Registry = $null,

        [Parameter(Mandatory=$false)]
        [switch]$IncludeDisabled
    )

    if ($null -eq $Registry) {
        $Registry = Get-AgentRegistry -IncludeDisabled:$IncludeDisabled
    }

    $normId = $AgentId.Trim().ToLowerInvariant()
    $pool = if ($IncludeDisabled) { $Registry.all_agents } else { $Registry.enabled_agents }
    foreach ($a in $pool) {
        if ($a.id -eq $normId) {
            return $a
        }
    }
    return $null
}

function Resolve-AgentOwner {
    param(
        [Parameter(Mandatory=$true)]
        [AllowEmptyString()]
        [string]$CellText,

        [Parameter(Mandatory=$false)]
        [psobject]$Registry = $null
    )

    if (-not $CellText -or -not $CellText.Trim()) {
        return @()
    }

    if ($null -eq $Registry) {
        $Registry = Get-AgentRegistry -IncludeDisabled
    }

    # Build (agentId, phrase) candidates and sort by phrase length descending so specific aliases
    # like "gemini 4 argon" (antigravity) are matched and consumed before shorter substrings like "gemini".
    $candidates = [System.Collections.Generic.List[psobject]]::new()
    foreach ($agent in $Registry.all_agents) {
        $phrases = [System.Collections.Generic.List[string]]::new()
        $phrases.Add($agent.id.ToLowerInvariant())
        if ($agent.label) {
            $phrases.Add($agent.label.ToLowerInvariant())
        }
        if ($agent.aliases) {
            foreach ($al in $agent.aliases) {
                if ($al) { $phrases.Add($al.ToLowerInvariant()) }
            }
        }
        foreach ($p in ($phrases | Select-Object -Unique)) {
            $candidates.Add([PSCustomObject]@{
                id     = $agent.id
                phrase = $p
                len    = $p.Length
            })
        }
    }

    $sortedCandidates = @($candidates | Sort-Object -Property len -Descending)
    $working = $CellText.ToLowerInvariant()
    $matchedSet = [System.Collections.Generic.HashSet[string]]::new()

    foreach ($cand in $sortedCandidates) {
        $escaped = [regex]::Escape($cand.phrase)
        $pattern = "(?<![a-z0-9])$escaped(?![a-z0-9])"
        if ([regex]::IsMatch($working, $pattern)) {
            [void]$matchedSet.Add($cand.id)
            $working = [regex]::Replace($working, $pattern, " ")
        }
    }

    $orderedIds = [System.Collections.Generic.List[string]]::new()
    foreach ($agent in $Registry.all_agents) {
        if ($matchedSet.Contains($agent.id)) {
            $orderedIds.Add($agent.id)
        }
    }
    return $orderedIds.ToArray()
}
