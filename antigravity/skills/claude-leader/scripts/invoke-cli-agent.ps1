param(
    [Parameter(Mandatory=$true)]
    [string]$AgentId,

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
    [string]$ModelOverride = "",

    [Parameter(Mandatory=$false)]
    [string]$EffortOverride = "",

    [Parameter(Mandatory=$false)]
    [switch]$IncludeGitDiff,

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

$normAgent = $AgentId.Trim().ToLowerInvariant()
$normRole  = $Role.Trim().ToLowerInvariant()

$reg = Get-AgentRegistry -ScriptsDir $PSScriptRoot
$entry = Get-AgentEntry -AgentId $normAgent -Registry $reg
if ($null -eq $entry) {
    Write-Output "ERROR: Unknown or disabled agent '$normAgent'."
    exit 1
}
if ($entry.adapter -ne "cli" -or $null -eq $entry.cli) {
    Write-Output "ERROR: Agent '$normAgent' does not use the generic 'cli' adapter."
    exit 1
}

$cliCfg = $entry.cli
$normModel = if ($ModelOverride) { $ModelOverride.Trim() } else { "" }
$normEffort = if ($EffortOverride) { $EffortOverride.Trim().ToLowerInvariant() } else { "" }

if ($normModel) {
    $allowedModelsLower = @($entry.models | ForEach-Object { ([string]$_).ToLowerInvariant() })
    if ($allowedModelsLower -notcontains $normModel.ToLowerInvariant()) {
        Write-Output "ERROR: Invalid model override '$normModel' for agent '$normAgent'. Allowed: $($entry.models -join ', ')"
        exit 1
    }
}

if ($normEffort) {
    $allowedEffortsLower = @($entry.efforts | ForEach-Object { ([string]$_).ToLowerInvariant() })
    if ($allowedEffortsLower -notcontains $normEffort) {
        Write-Output "ERROR: Invalid effort override '$normEffort' for agent '$normAgent'. Allowed: $($entry.efforts -join ', ')"
        exit 1
    }
}

if ($PromptFile) {
    if (-not (Test-Path -LiteralPath $PromptFile -PathType Leaf)) {
        Write-Output "ERROR: PromptFile not found: $PromptFile"
        exit 1
    }
    $fileContent = Get-Content -LiteralPath $PromptFile -Raw -Encoding UTF8
    if ($Prompt) {
        $Prompt = "$Prompt`n`n$fileContent"
    } else {
        $Prompt = $fileContent
    }
}

if ($normRole -eq "reviewer" -or $IncludeGitDiff) {
    if ($Prompt -notmatch '---\s*GIT DIFF TO REVIEW\s*---') {
        $diffText = Get-ReviewDiff -WorkDir $WorkDir
        if ($diffText -and $diffText.Trim()) {
            $Prompt = "$Prompt`n`n--- GIT DIFF TO REVIEW ---`n$diffText"
        }
    }
}
if ($normRole -eq "reviewer") {
    $Prompt = Add-ReviewerContract -Prompt $Prompt
}

$promptVia = $cliCfg.prompt_via
if ($promptVia -eq "arg") {
    $maxArgChars = [int]$cliCfg.max_arg_chars
    if ($Prompt.Length -gt $maxArgChars) {
        Write-Output "ERROR: Rendered prompt length ($($Prompt.Length) characters) exceeds max_arg_chars ($maxArgChars) for agent '$normAgent' (prompt_via=arg)."
        exit 1
    }
}

# Build raw argument tokens before placeholder substitution
$rawTokens = [System.Collections.Generic.List[string]]::new()
foreach ($a in @($cliCfg.args)) {
    $rawTokens.Add([string]$a)
}

if ($null -ne $cliCfg.role_args) {
    if ($cliCfg.role_args.ContainsKey($normRole)) {
        foreach ($ra in @($cliCfg.role_args[$normRole])) {
            $rawTokens.Add([string]$ra)
        }
    } elseif ($cliCfg.role_args.ContainsKey("*")) {
        foreach ($ra in @($cliCfg.role_args["*"])) {
            $rawTokens.Add([string]$ra)
        }
    }
}

if ($normModel -and $cliCfg.model_args -and $cliCfg.model_args.Count -gt 0) {
    foreach ($ma in @($cliCfg.model_args)) {
        $rawTokens.Add([string]$ma)
    }
}

if ($normEffort -and $cliCfg.effort_args -and $cliCfg.effort_args.Count -gt 0) {
    foreach ($ea in @($cliCfg.effort_args)) {
        $rawTokens.Add([string]$ea)
    }
}

function Expand-CliPlaceholders {
    param(
        [string[]]$Tokens,
        [string]$PromptVal,
        [string]$PromptFileVal,
        [string]$WorkDirVal,
        [string]$ModelVal,
        [string]$EffortVal
    )
    $out = [System.Collections.Generic.List[string]]::new()
    foreach ($t in $Tokens) {
        $expanded = $t.
            Replace("{prompt}", $PromptVal).
            Replace("{prompt_file}", $PromptFileVal).
            Replace("{workdir}", $WorkDirVal).
            Replace("{model}", $ModelVal).
            Replace("{effort}", $EffortVal)
        $out.Add($expanded)
    }
    return $out.ToArray()
}

if ($DryRun) {
    $dryPromptFile = if ($PromptFile) { $PromptFile } else { "<temp_prompt_file>" }
    $dryArgs = @(Expand-CliPlaceholders -Tokens $rawTokens.ToArray() -PromptVal $Prompt -PromptFileVal $dryPromptFile -WorkDirVal $WorkDir -ModelVal $normModel -EffortVal $normEffort)
    $quotedPreview = ($dryArgs | ForEach-Object { ConvertTo-NativeArgument -Value $_ }) -join " "
    $argsJson = ConvertTo-Json -InputObject $dryArgs -Compress
    Write-Output "=== INVOKE-CLI-AGENT DRY RUN ==="
    Write-Output "DRYRUN_COMMAND: $($cliCfg.command) $quotedPreview"
    Write-Output "DRYRUN_ARGS_JSON: $argsJson"
    Write-Output "PROMPT_VIA: $promptVia"
    Write-Output "AGENT_ID: $normAgent"
    Write-Output "ROLE: $normRole"
    exit 0
}

# Resolve CLI command
function Resolve-CliExecutable {
    param(
        [string]$CommandName,
        [string]$MawHomeDir
    )

    if ([System.IO.Path]::IsPathRooted($CommandName)) {
        if (Test-Path -LiteralPath $CommandName -PathType Leaf) {
            return $CommandName
        }
        return $null
    }

    if ($MawHomeDir) {
        $mawCandidate = Join-Path $MawHomeDir $CommandName
        if (Test-Path -LiteralPath $mawCandidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $mawCandidate).Path
        }
    }

    $cmds = @(Get-Command $CommandName -ErrorAction SilentlyContinue)
    if ($cmds.Count -eq 0) {
        return $null
    }

    foreach ($c in $cmds) {
        if ($c.Source -and (Test-Path -LiteralPath $c.Source -PathType Leaf)) {
            return $c.Source
        }
    }
    return $cmds[0].Source
}

$mawHomeDir = Split-Path -Parent $reg.user_path
$resolvedCmd = Resolve-CliExecutable -CommandName $cliCfg.command -MawHomeDir $mawHomeDir
if (-not $resolvedCmd) {
    Write-Output "$($entry.label) is not installed (command '$($cliCfg.command)' not found)."
    exit 127
}

$tempPromptFile = $null
try {
    $effectivePromptFile = $PromptFile
    if ($promptVia -eq "file_arg") {
        $tempPromptFile = Join-Path $env:TEMP ("maw_cli_prompt_" + [guid]::NewGuid().ToString("N") + ".txt")
        [System.IO.File]::WriteAllText($tempPromptFile, $Prompt, (New-Object System.Text.UTF8Encoding($false)))
        $effectivePromptFile = $tempPromptFile
    }

    $renderedArgs = @(Expand-CliPlaceholders -Tokens $rawTokens.ToArray() -PromptVal $Prompt -PromptFileVal ([string]$effectivePromptFile) -WorkDirVal $WorkDir -ModelVal $normModel -EffortVal $normEffort)

    # Determine actual binary & argument array (handling npm .ps1/.cmd shims and .ps1 scripts cleanly)
    $execFile = $resolvedCmd
    $execArgs = $renderedArgs

    $ext = [System.IO.Path]::GetExtension($resolvedCmd).ToLowerInvariant()
    if ($ext -eq ".ps1" -or $ext -eq ".cmd" -or $ext -eq ".bat") {
        $shimDir = Split-Path -Parent $resolvedCmd
        $shimBase = [System.IO.Path]::GetFileNameWithoutExtension($resolvedCmd)
        $ps1Candidate = Join-Path $shimDir "$shimBase.ps1"
        $foundNpmJs = $null

        if (Test-Path -LiteralPath $ps1Candidate -PathType Leaf) {
            $ps1Text = Get-Content -LiteralPath $ps1Candidate -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
            if ($ps1Text -match '\$basedir[/\\]node_modules[/\\]([^"\r\n]+\.js)') {
                $relJs = $Matches[1] -replace '/', '\'
                $fullJs = Join-Path $shimDir "node_modules\$relJs"
                if (Test-Path -LiteralPath $fullJs -PathType Leaf) {
                    $foundNpmJs = $fullJs
                }
            }
        }

        if ($foundNpmJs) {
            $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
            if ($nodeCmd) {
                $execFile = $nodeCmd.Source
                $execArgs = @($foundNpmJs) + $renderedArgs
            }
        } elseif ($ext -eq ".ps1") {
            $execFile = "powershell.exe"
            $execArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $resolvedCmd) + $renderedArgs
        } elseif ($ext -eq ".cmd" -or $ext -eq ".bat") {
            if ($promptVia -eq "arg" -or ($rawTokens | Where-Object { $_ -like "*{prompt}*" })) {
                Write-Output "ERROR: Refusing to execute .cmd/.bat shim '$resolvedCmd' with prompt_via='arg' through cmd.exe (shell injection risk). Configure prompt_via='stdin' or 'file_arg' instead."
                exit 1
            }
            if ($resolvedCmd -match '["%!\r\n\0]') {
                Write-Output "ERROR: Refusing to execute .cmd/.bat shim '$resolvedCmd' because its path contains forbidden cmd.exe characters (double-quote, %, !, CR, LF, or NUL)."
                exit 1
            }
            foreach ($ra in $renderedArgs) {
                if ($ra -match '["%!\r\n\0]') {
                    Write-Output "ERROR: Refusing to pass argument containing forbidden character (double-quote, %, !, CR, LF, or NUL) to .cmd/.bat shim '$resolvedCmd' through cmd.exe."
                    exit 1
                }
            }
            $execFile = "cmd.exe"
            $escapedBatchArgs = foreach ($ra in $renderedArgs) {
                ConvertTo-CmdSafeArgument -Value ([string]$ra)
            }
            $batchArgsStr = ($escapedBatchArgs -join " ").Trim()
            $innerCmd = if ($batchArgsStr) { "`"$resolvedCmd`" $batchArgsStr" } else { "`"$resolvedCmd`"" }
            $rawCmdLineArgs = "/d /s /c `"$innerCmd`""
        }
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $execFile
    if ($execFile -eq "cmd.exe" -and $rawCmdLineArgs) {
        $psi.Arguments = $rawCmdLineArgs
    } else {
        $quotedExecArgs = foreach ($arg in $execArgs) {
            ConvertTo-NativeArgument -Value ([string]$arg)
        }
        $psi.Arguments = ($quotedExecArgs -join " ")
    }
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    if ($WorkDir -and (Test-Path -LiteralPath $WorkDir)) {
        $psi.WorkingDirectory = $WorkDir
    }

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi

    $outQueue = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
    $allStdout = [System.Collections.Generic.List[string]]::new()
    $allStderr = [System.Collections.Generic.List[string]]::new()

    $outSub = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -MessageData $outQueue -Action {
        if ($null -ne $EventArgs.Data) {
            $Event.MessageData.Enqueue("O:" + $EventArgs.Data)
        }
    }
    $errSub = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -MessageData $outQueue -Action {
        if ($null -ne $EventArgs.Data) {
            $Event.MessageData.Enqueue("E:" + $EventArgs.Data)
        }
    }

    $isStreamText = ($cliCfg.output -eq "text")
    [void]$proc.Start()
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()

    try {
        if ($promptVia -eq "stdin" -and $Prompt.Length -gt 0) {
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            $inBytes = $utf8NoBom.GetBytes($Prompt)
            $proc.StandardInput.BaseStream.Write($inBytes, 0, $inBytes.Length)
            $proc.StandardInput.BaseStream.Flush()
        }
    } catch {} finally {
        try { $proc.StandardInput.Close() } catch {}
    }

    $timeoutMs = [Math]::Max(1000, $TimeoutSeconds * 1000)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $timedOut = $false

    while (-not $proc.HasExited) {
        $item = $null
        while ($outQueue.TryDequeue([ref]$item)) {
            $prefix = $item.Substring(0, 2)
            $line = $item.Substring(2)
            if ($prefix -eq "O:") { $allStdout.Add($line) } else { $allStderr.Add($line) }
            if ($isStreamText) {
                Write-Output $line
            }
        }
        if ($sw.ElapsedMilliseconds -ge $timeoutMs) {
            $timedOut = $true
            try { & taskkill.exe /PID $proc.Id /T /F 2>$null | Out-Null } catch {}
            try { $proc.Kill() } catch {}
            break
        }
        Start-Sleep -Milliseconds 50
    }

    $proc.WaitForExit(2000) | Out-Null
    Start-Sleep -Milliseconds 50

    Unregister-Event -SourceIdentifier $outSub.Name -ErrorAction SilentlyContinue
    Unregister-Event -SourceIdentifier $errSub.Name -ErrorAction SilentlyContinue
    Remove-Job -Id $outSub.Id -Force -ErrorAction SilentlyContinue
    Remove-Job -Id $errSub.Id -Force -ErrorAction SilentlyContinue

    $item = $null
    while ($outQueue.TryDequeue([ref]$item)) {
        $prefix = $item.Substring(0, 2)
        $line = $item.Substring(2)
        if ($prefix -eq "O:") { $allStdout.Add($line) } else { $allStderr.Add($line) }
        if ($isStreamText) {
            Write-Output $line
        }
    }

    $rawCombined = (($allStdout + $allStderr) -join "`n").Trim()
    $parsedResponse = $rawCombined
    $inTokens = $null
    $outTokens = $null

    if ($cliCfg.output -eq "gemini-json") {
        $rawStdoutText = ($allStdout -join "`n").Trim()
        $jsonCandidate = if ($rawStdoutText.StartsWith("{")) { $rawStdoutText } else { $rawCombined }
        $firstBrace = $jsonCandidate.IndexOf("{")
        $lastBrace  = $jsonCandidate.LastIndexOf("}")
        $parsedJson = $null
        if ($firstBrace -ge 0 -and $lastBrace -gt $firstBrace) {
            $slice = $jsonCandidate.Substring($firstBrace, $lastBrace - $firstBrace + 1)
            try {
                $parsedJson = $slice | ConvertFrom-Json -ErrorAction Stop
            } catch {
                $parsedJson = $null
            }
        }

        if ($null -ne $parsedJson) {
            if ($null -ne $parsedJson.response -and ([string]$parsedJson.response).Trim()) {
                $parsedResponse = ([string]$parsedJson.response).Trim()
                Write-Output $parsedResponse
            }
            if ($null -ne $parsedJson.error) {
                $errMsg = if ($parsedJson.error.message) { [string]$parsedJson.error.message } else { ($parsedJson.error | ConvertTo-Json -Compress) }
                Write-Output "[ERROR] $errMsg"
                if (-not $parsedResponse) { $parsedResponse = "[ERROR] $errMsg" }
            }
            if ($null -ne $parsedJson.stats) {
                $st = $parsedJson.stats
                if ($null -ne $st.input_tokens) { $inTokens = [int]$st.input_tokens }
                if ($null -ne $st.output_tokens) { $outTokens = [int]$st.output_tokens }
                if (($null -eq $inTokens -or $null -eq $outTokens) -and $null -ne $st.models) {
                    $sumIn = 0
                    $sumOut = 0
                    foreach ($mp in $st.models.PSObject.Properties) {
                        $tokObj = $mp.Value.tokens
                        if ($null -ne $tokObj) {
                            if ($null -ne $tokObj.prompt) { $sumIn += [int]$tokObj.prompt }
                            if ($null -ne $tokObj.candidates) { $sumOut += [int]$tokObj.candidates }
                        }
                    }
                    if ($sumIn -gt 0) { $inTokens = $sumIn }
                    if ($sumOut -gt 0) { $outTokens = $sumOut }
                }
            }
        } elseif ($rawCombined) {
            Write-Output $rawCombined
        }
    }

    if ($timedOut) {
        Write-Output "ERROR: $($entry.label) timed out after ${TimeoutSeconds}s."
        $exitCode = 124
    } else {
        $exitCode = [int]$proc.ExitCode
    }

    # Write telemetry audit line to multi-ai-audit.jsonl (SPEC §7.3)
    try {
        $auditFile = Join-Path $env:USERPROFILE ".gemini\antigravity\multi-ai-audit.jsonl"
        $auditDir = Split-Path -Parent $auditFile
        if (-not (Test-Path -LiteralPath $auditDir)) {
            New-Item -ItemType Directory -Path $auditDir -Force | Out-Null
        }

        if ($null -eq $inTokens -or $inTokens -le 0) {
            $inTokens = [Math]::Max(1, [int][Math]::Ceiling($Prompt.Length / 3.8))
        }
        if ($null -eq $outTokens -or $outTokens -le 0) {
            $outTokens = [Math]::Max(1, [int][Math]::Ceiling($parsedResponse.Length / 3.8))
        }

        $inRate = [double]$cliCfg.pricing.input_per_mtok
        $outRate = [double]$cliCfg.pricing.output_per_mtok
        $costUsd = [Math]::Round(($inTokens * $inRate + $outTokens * $outRate) / 1000000.0, 5)

        $vr = Get-ReviewVerdict -Text $parsedResponse
        $verdict = if ($timedOut) {
            "TIMEOUT"
        } elseif ($exitCode -ne 0) {
            "FAILED"
        } elseif ($normRole -eq "reviewer" -and $vr.Verdict -ne "UNKNOWN") {
            $vr.Verdict
        } else {
            "COMPLETED"
        }

        $auditRole = if ($env:MAW_ROLE) { $env:MAW_ROLE } else { $normRole }
        $effModel = if ($normModel) { $normModel } elseif ($entry.models.Count -gt 0) { $entry.models[0] } else { $normAgent }

        [ordered]@{
            Timestamp    = (Get-Date).ToString("o")
            Tool         = $normAgent
            Agent        = $normAgent
            Role         = $auditRole
            Model        = $effModel
            Effort       = $normEffort
            WorkDir      = $WorkDir
            PromptChars  = $Prompt.Length
            OutputChars  = $parsedResponse.Length
            InputTokens  = $inTokens
            OutputTokens = $outTokens
            CostUsd      = $costUsd
            Score        = $vr.Score
            Verdict      = $verdict
        } | ConvertTo-Json -Compress | Add-Content -Path $auditFile -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}

    exit $exitCode
} finally {
    if ($tempPromptFile -and (Test-Path -LiteralPath $tempPromptFile)) {
        Remove-Item -LiteralPath $tempPromptFile -Force -ErrorAction SilentlyContinue
    }
}
