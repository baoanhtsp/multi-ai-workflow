# Shared helpers for Multi-AI Workflow PowerShell scripts (Windows PowerShell 5.1 compatible)

function ConvertTo-NativeArgument {
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Value
    )

    if ($null -eq $Value -or $Value.Length -eq 0) {
        return '""'
    }

    if ($Value -notmatch '[\s"]') {
        return $Value
    }

    # CommandLineToArgvW escaping rules:
    # 1. Double all backslashes immediately preceding a double quote, then escape the quote as \"
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    # 2. Double all trailing backslashes before the closing quote
    $escaped = [regex]::Replace($escaped, '(\\*)$', '$1$1')

    return '"' + $escaped + '"'
}

function ConvertTo-CmdSafeArgument {
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Value
    )

    if ($null -eq $Value -or $Value.Length -eq 0) {
        return '""'
    }

    if ($Value -match '["%!\r\n\0]') {
        throw "Argument for .cmd/.bat shim contains forbidden character (double-quote, %, !, CR, LF, or NUL)."
    }

    # BatBadBut (CVE-2024-24576) mitigation:
    # Wrap EVERY argument in double quotes (with no caret escaping) so that when the batch file
    # expands %* on a second parse pass, the argument remains double-quoted and & | < > ^ ( ) and spaces stay literal.
    $escaped = [regex]::Replace($Value, '(\\*)$', '$1$1')
    return '"' + $escaped + '"'
}

function Normalize-MawWorkspacePath {
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string]$RawPath
    )

    if (-not $RawPath -or -not $RawPath.Trim()) {
        return ""
    }
    $decoded = [uri]::UnescapeDataString($RawPath.Trim())
    $clean = $decoded -replace '^file:///', ''
    return $clean.Replace('\', '/').TrimEnd('/').ToLowerInvariant()
}

function Resolve-GitMainWorktreePath {
    param(
        [Parameter(Mandatory=$true)]
        [string]$WorkDir
    )

    if (-not $WorkDir -or -not (Test-Path -LiteralPath $WorkDir)) {
        return ""
    }

    try {
        $res = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $WorkDir, "rev-parse", "--git-common-dir") -TimeoutMs 4000
        if ($res.ExitCode -ne 0 -or -not $res.StdOut -or -not $res.StdOut.Trim()) {
            return ""
        }
        $rawCommon = $res.StdOut.Trim() -replace '/', '\'
        $commonFull = if ([System.IO.Path]::IsPathRooted($rawCommon)) {
            $rawCommon
        } else {
            Join-Path $WorkDir $rawCommon
        }
        if (Test-Path -LiteralPath $commonFull) {
            $commonFull = (Resolve-Path -LiteralPath $commonFull).Path
        }
        $parent = Split-Path -Parent $commonFull
        if ($parent) {
            return $parent
        }
    } catch {}

    return ""
}

function Resolve-AntigravityProjectIdFromMetas {
    param(
        [Parameter(Mandatory=$false)]
        [AllowEmptyString()]
        [string]$WorkDir = "",

        [Parameter(Mandatory=$false)]
        [AllowEmptyCollection()]
        [object[]]$MetadataList = @(),

        [Parameter(Mandatory=$false)]
        [AllowEmptyString()]
        [string]$MainWorktreePath = ""
    )

    if ($null -eq $MetadataList -or $MetadataList.Count -eq 0) {
        return ""
    }

    $normWorkDir = Normalize-MawWorkspacePath -RawPath $WorkDir
    if (-not $MainWorktreePath -and $WorkDir -and (Test-Path -LiteralPath $WorkDir)) {
        $MainWorktreePath = Resolve-GitMainWorktreePath -WorkDir $WorkDir
    }
    $normMainRepo = Normalize-MawWorkspacePath -RawPath $MainWorktreePath

    $parsedEntries = [System.Collections.Generic.List[psobject]]::new()
    foreach ($rawItem in $MetadataList) {
        if ($null -eq $rawItem) { continue }
        $item = $rawItem
        if ($item -is [string]) {
            if (-not $item.Trim()) { continue }
            try {
                $item = $item | ConvertFrom-Json -ErrorAction Stop
            } catch {
                continue
            }
        }

        $meta = $item
        if ($null -ne $item.response -and $null -ne $item.response.conversationMetadata -and $null -ne $item.response.conversationMetadata.metadata) {
            $meta = $item.response.conversationMetadata.metadata
        } elseif ($null -ne $item.conversationMetadata -and $null -ne $item.conversationMetadata.metadata) {
            $meta = $item.conversationMetadata.metadata
        }

        if ($null -eq $meta) { continue }
        $projId = if ($null -ne $meta.projectId) { ([string]$meta.projectId).Trim() } else { "" }
        if (-not $projId) { continue }

        $wsPaths = [System.Collections.Generic.List[string]]::new()
        if ($null -ne $meta.workspaces) {
            foreach ($ws in @($meta.workspaces)) {
                if ($null -eq $ws) { continue }
                foreach ($rawUri in @($ws.workspaceFolderAbsoluteUri, $ws.gitRootAbsoluteUri)) {
                    $np = Normalize-MawWorkspacePath -RawPath ([string]$rawUri)
                    if ($np -and -not $wsPaths.Contains($np)) {
                        $wsPaths.Add($np)
                    }
                }
            }
        }
        if ($null -ne $meta.workspaceUris) {
            foreach ($u in @($meta.workspaceUris)) {
                $np = Normalize-MawWorkspacePath -RawPath ([string]$u)
                if ($np -and -not $wsPaths.Contains($np)) {
                    $wsPaths.Add($np)
                }
            }
        }

        $parsedEntries.Add([PSCustomObject]@{
            ProjectId = $projId
            Paths     = $wsPaths.ToArray()
        })
    }

    if ($parsedEntries.Count -eq 0) {
        return ""
    }

    if (-not $normWorkDir -and -not $normMainRepo) {
        return $parsedEntries[0].ProjectId
    }

    # Pass 1: Exact match on WorkDir or MainWorktreePath
    foreach ($entry in $parsedEntries) {
        foreach ($wp in $entry.Paths) {
            if (($normWorkDir -and $wp -eq $normWorkDir) -or ($normMainRepo -and $wp -eq $normMainRepo)) {
                return $entry.ProjectId
            }
        }
    }

    # Pass 2: Parent repo match (WorkDir or MainWorktreePath is a subdirectory of workspace path, or vice versa)
    foreach ($entry in $parsedEntries) {
        foreach ($wp in $entry.Paths) {
            if ($normWorkDir -and ($normWorkDir.StartsWith("$wp/") -or $wp.StartsWith("$normWorkDir/"))) {
                return $entry.ProjectId
            }
            if ($normMainRepo -and ($normMainRepo.StartsWith("$wp/") -or $wp.StartsWith("$normMainRepo/"))) {
                return $entry.ProjectId
            }
        }
    }

    return ""
}

function Invoke-NativeProcess {
    param(
        [Parameter(Mandatory=$true)]
        [string]$FilePath,

        [Parameter(Mandatory=$false)]
        [AllowEmptyCollection()]
        [string[]]$ArgumentList = @(),

        [Parameter(Mandatory=$false)]
        [string]$WorkingDirectory = "",

        [Parameter(Mandatory=$false)]
        [int]$TimeoutMs = 0,

        [Parameter(Mandatory=$false)]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$StdinText = $null
    )

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $quotedArgs = foreach ($arg in $ArgumentList) {
        ConvertTo-NativeArgument -Value ([string]$arg)
    }
    $psi.Arguments = ($quotedArgs -join " ")
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    if ($WorkingDirectory -and (Test-Path -LiteralPath $WorkingDirectory)) {
        $psi.WorkingDirectory = $WorkingDirectory
    }

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()

    try {
        if ($PSBoundParameters.ContainsKey("StdinText") -and $null -ne $StdinText -and $StdinText.Length -gt 0) {
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            $inBytes = $utf8NoBom.GetBytes($StdinText)
            $proc.StandardInput.BaseStream.Write($inBytes, 0, $inBytes.Length)
            $proc.StandardInput.BaseStream.Flush()
        }
    } catch {} finally {
        try { $proc.StandardInput.Close() } catch {}
    }

    $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
    $stderrTask = $proc.StandardError.ReadToEndAsync()

    $timedOut = $false
    if ($TimeoutMs -gt 0) {
        if (-not $proc.WaitForExit($TimeoutMs)) {
            $timedOut = $true
            try { & taskkill.exe /PID $proc.Id /T /F 2>$null | Out-Null } catch {}
            try { $proc.Kill() } catch {}
        }
    }
    $proc.WaitForExit()

    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = if ($timedOut) { 124 } else { [int]$proc.ExitCode }

    return @{
        ExitCode = $exitCode
        TimedOut = $timedOut
        StdOut   = [string]$stdout
        StdErr   = [string]$stderr
    }
}

function Add-ReviewerContract {
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Prompt
    )

    $contract = "Finish with exactly two lines:`nSCORE: X/10`nVERDICT: APPROVED or VERDICT: CHANGES_REQUESTED"
    if (-not $Prompt) {
        return $contract
    }
    if ($Prompt -match 'VERDICT:\s*APPROVED' -and $Prompt -match 'SCORE:\s*X/10') {
        return $Prompt
    }
    return "$Prompt`n`n$contract"
}

function Get-ReviewVerdict {
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Text
    )

    if (-not $Text) {
        return @{
            Verdict    = "UNKNOWN"
            Score      = ""
            ScoreValue = $null
        }
    }

    $verdict = "UNKNOWN"
    $explicitVerdicts = [regex]::Matches($Text, '(?im)^\s*(?:[#>*\-]+\s*)?\*{0,2}VERDICT\*{0,2}\s*:\s*\*{0,2}\s*(APPROVED|CHANGES_REQUESTED)\b')
    if ($explicitVerdicts.Count -gt 0) {
        $verdict = $explicitVerdicts[$explicitVerdicts.Count - 1].Groups[1].Value.ToUpperInvariant()
    } else {
        $fallbackVerdicts = [regex]::Matches($Text, '(?i)\b(APPROVED|CHANGES_REQUESTED)\b')
        if ($fallbackVerdicts.Count -gt 0) {
            $verdict = $fallbackVerdicts[$fallbackVerdicts.Count - 1].Groups[1].Value.ToUpperInvariant()
        }
    }

    $scoreStr = ""
    $scoreVal = $null
    $explicitScores = [regex]::Matches($Text, '(?im)^\s*(?:[#>*\-]+\s*)?\*{0,2}SCORE\*{0,2}\s*:\s*\*{0,2}\s*(\d+(?:\.\d+)?)\s*/\s*10\b')
    if ($explicitScores.Count -eq 0) {
        $explicitScores = [regex]::Matches($Text, '\b(\d+(?:\.\d+)?)\s*/\s*10\b')
    }
    if ($explicitScores.Count -gt 0) {
        $numStr = $explicitScores[$explicitScores.Count - 1].Groups[1].Value
        $parsed = 0.0
        if ([double]::TryParse($numStr, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$parsed)) {
            $scoreVal = $parsed
            $scoreStr = "$numStr/10"
        }
    }

    return @{
        Verdict    = $verdict
        Score      = $scoreStr
        ScoreValue = $scoreVal
    }
}

function Get-ReviewDiff {
    param(
        [Parameter(Mandatory=$true)]
        [string]$WorkDir,

        [string]$CommitSha = "",

        [string]$BaseBranch = ""
    )

    $ErrorActionPreference = "Continue"

    if (-not (Test-Path -LiteralPath $WorkDir)) {
        return ""
    }

    $gitMarker = Join-Path $WorkDir ".git"
    if (-not (Test-Path -LiteralPath $gitMarker)) {
        return ""
    }

    $parts = [System.Collections.Generic.List[string]]::new()

    if ($CommitSha) {
        $r = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $WorkDir, "-c", "core.quotepath=false", "show", $CommitSha)
        if ($r.StdOut -and $r.StdOut.Trim()) { $parts.Add($r.StdOut.TrimEnd("`r", "`n")) }
        return ($parts -join "`n`n")
    }

    if ($BaseBranch) {
        $r = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $WorkDir, "-c", "core.quotepath=false", "diff", "$BaseBranch...HEAD")
        if ($r.StdOut -and $r.StdOut.Trim()) { $parts.Add($r.StdOut.TrimEnd("`r", "`n")) }
        return ($parts -join "`n`n")
    }

    $rTracked = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $WorkDir, "-c", "core.quotepath=false", "diff", "HEAD")
    $tracked = if ($rTracked.StdOut) { $rTracked.StdOut.TrimEnd("`r", "`n") } else { "" }
    if (-not $tracked) {
        $rTracked2 = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $WorkDir, "-c", "core.quotepath=false", "diff")
        $tracked = if ($rTracked2.StdOut) { $rTracked2.StdOut.TrimEnd("`r", "`n") } else { "" }
    }
    if ($tracked) {
        $parts.Add($tracked)
    }

    $rUntracked = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $WorkDir, "-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard")
    $untrackedFiles = if ($rUntracked.StdOut) { @($rUntracked.StdOut -replace "`r`n", "`n" -split "`n") } else { @() }
    $maxFileBytes   = 102400 # 100 KB per untracked file
    $maxTotalBytes  = 204800 # 200 KB total untracked budget
    $usedBytes      = 0
    $skippedFiles   = [System.Collections.Generic.List[string]]::new()

    foreach ($rawRel in $untrackedFiles) {
        if (-not $rawRel -or -not $rawRel.Trim()) {
            continue
        }
        $relPath = $rawRel.Trim().Trim('"')
        $fullPath = Join-Path $WorkDir ($relPath -replace '/', '\')
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            continue
        }

        $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
        if (-not $item) {
            continue
        }

        $fileSize = [long]$item.Length
        if ($fileSize -gt $maxFileBytes) {
            $skippedFiles.Add("$relPath (>100KB: $fileSize bytes)")
            continue
        }

        $bytes = [System.IO.File]::ReadAllBytes($fullPath)
        $checkLen = [Math]::Min($bytes.Length, 8192)
        $isBinary = $false
        for ($i = 0; $i -lt $checkLen; $i++) {
            if ($bytes[$i] -eq 0) {
                $isBinary = $true
                break
            }
        }
        if ($isBinary) {
            $skippedFiles.Add("$relPath (binary)")
            continue
        }

        if (($usedBytes + $fileSize) -gt $maxTotalBytes) {
            $skippedFiles.Add("$relPath (200KB untracked budget exceeded)")
            continue
        }

        $usedBytes += $fileSize
        $rNoIdx = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $WorkDir, "-c", "core.quotepath=false", "diff", "--no-index", "--", "NUL", $relPath)
        $noIdxOut = if ($rNoIdx.StdOut) { $rNoIdx.StdOut.TrimEnd("`r", "`n") } else { "" }
        if (-not $noIdxOut) {
            $textContent = [System.Text.Encoding]::UTF8.GetString($bytes)
            $normLines = $textContent -replace "`r`n", "`n" -split "`n"
            $plusLines = ($normLines | ForEach-Object { "+$_" }) -join "`n"
            $noIdxOut = "diff --git a/$relPath b/$relPath`nnew file mode 100644`n--- /dev/null`n+++ b/$relPath`n@@ -0,0 +1,$($normLines.Count) @@`n$plusLines"
        }
        $parts.Add($noIdxOut)
    }

    if ($skippedFiles.Count -gt 0) {
        $parts.Add("# Skipped untracked files:`n# - " + ($skippedFiles -join "`n# - "))
    }

    return ($parts -join "`n`n")
}

function Get-FileContentSignature {
    param(
        [Parameter(Mandatory=$true)]
        [string]$FullPath
    )

    if (-not (Test-Path -LiteralPath $FullPath -PathType Leaf)) {
        return "deleted"
    }

    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = [System.IO.File]::ReadAllBytes($FullPath)
        $hashBytes = $sha1.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hashBytes)).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha1.Dispose()
    }
}

function Get-DirtySnapshot {
    param(
        [Parameter(Mandatory=$true)]
        [string]$WorkDir,

        [Alias("OutputFile")]
        [string]$OutFile = ""
    )

    $snapshot = [ordered]@{}
    if (Test-Path -LiteralPath $WorkDir) {
        $gitCheck = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $WorkDir, "rev-parse", "--is-inside-work-tree")
        if ($gitCheck.ExitCode -eq 0 -and $gitCheck.StdOut.Trim() -eq "true") {
            $statusRes = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $WorkDir, "-c", "core.quotepath=false", "status", "--porcelain", "-uall")
            $lines = if ($statusRes.StdOut) { @($statusRes.StdOut -replace "`r`n", "`n" -split "`n") } else { @() }
            foreach ($line in $lines) {
                if (-not $line -or $line.Length -lt 4) { continue }
                $relPath = $line.Substring(3).Trim().Trim('"')
                if ($relPath -match ' -> ') {
                    $relPath = ($relPath -split ' -> ')[-1].Trim().Trim('"')
                }
                $normRel = ($relPath -replace '\\', '/').TrimStart('/')
                $fullPath = Join-Path $WorkDir ($normRel -replace '/', '\')
                $snapshot[$normRel] = Get-FileContentSignature -FullPath $fullPath
            }
        }
    }

    if ($OutFile) {
        $json = ([PSCustomObject]$snapshot) | ConvertTo-Json -Compress
        if (-not $json) { $json = "{}" }
        [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    }

    return $snapshot
}

function New-TranscriptReaderState {
    param(
        [string]$TranscriptPath = "",
        [string]$FullTranscriptPath = "",
        [int]$BaselineStepCount = -1
    )

    return @{
        Offset             = [long]0
        ByteOffset         = [long]0
        Steps              = [System.Collections.Generic.List[psobject]]::new()
        Remainder          = ""
        RemainderBytes     = [byte[]]@()
        TranscriptPath     = $TranscriptPath
        FullTranscriptPath = $FullTranscriptPath
        MinStepIndex       = $BaselineStepCount
    }
}

function Update-TranscriptReaderState {
    param(
        [Parameter(Mandatory=$true)]
        [hashtable]$State,

        [string]$TranscriptPath = ""
    )

    if (-not $TranscriptPath -and $State.TranscriptPath) {
        $TranscriptPath = [string]$State.TranscriptPath
    }
    if (-not $TranscriptPath -or -not (Test-Path -LiteralPath $TranscriptPath -PathType Leaf)) {
        return
    }

    $fs = New-Object System.IO.FileStream($TranscriptPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
        $len = $fs.Length
        if ($len -lt $State.Offset) {
            # File was truncated or recreated
            $State.Offset = [long]0
            $State.ByteOffset = [long]0
            $State.Steps.Clear()
            $State.Remainder = ""
            $State.RemainderBytes = [byte[]]@()
        }
        $toRead = [int]($len - $State.Offset)
        if ($toRead -le 0) {
            return
        }
        [void]$fs.Seek($State.Offset, [System.IO.SeekOrigin]::Begin)
        $buf = New-Object byte[] $toRead
        $readCount = $fs.Read($buf, 0, $toRead)
        if ($readCount -le 0) {
            return
        }
        $State.Offset += $readCount
        $State.ByteOffset = $State.Offset
    } finally {
        $fs.Dispose()
    }

    # Combine any leftover byte remainder from the previous read with the newly read bytes
    $prevBytes = if ($null -ne $State.RemainderBytes) { [byte[]]$State.RemainderBytes } else { [byte[]]@() }
    $combinedLen = $prevBytes.Length + $readCount
    $combinedBytes = New-Object byte[] $combinedLen
    if ($prevBytes.Length -gt 0) {
        [Array]::Copy($prevBytes, 0, $combinedBytes, 0, $prevBytes.Length)
    }
    [Array]::Copy($buf, 0, $combinedBytes, $prevBytes.Length, $readCount)

    # m3: Only decode UTF-8 up to the last '\n' (0x0A) byte so a read that stops mid-character never corrupts multi-byte UTF-8
    $lastNl = [Array]::LastIndexOf($combinedBytes, [byte]0x0A)
    if ($lastNl -lt 0) {
        $State.RemainderBytes = $combinedBytes
        return
    }

    $decodeLen = $lastNl + 1
    $remLen = $combinedLen - $decodeLen
    if ($remLen -gt 0) {
        $remBytes = New-Object byte[] $remLen
        [Array]::Copy($combinedBytes, $decodeLen, $remBytes, 0, $remLen)
        $State.RemainderBytes = $remBytes
    } else {
        $State.RemainderBytes = [byte[]]@()
    }

    $chunkText = [System.Text.Encoding]::UTF8.GetString($combinedBytes, 0, $decodeLen)
    $norm = $chunkText -replace "`r`n", "`n"
    $lines = $norm -split "`n"

    foreach ($rawLine in $lines) {
        $line = $rawLine.Trim()
        if (-not $line) { continue }
        try {
            $obj = $line | ConvertFrom-Json -ErrorAction Stop
            $State.Steps.Add($obj)
        } catch {}
    }
}

function Evaluate-TranscriptTurn {
    param(
        [Parameter(Mandatory=$true)]
        [AllowEmptyCollection()]
        [object[]]$Steps,

        [Alias("BaselineStepCount")]
        [int]$MinStepIndex = -1,

        [double]$QuietElapsedSeconds = 0.0,

        [int]$QuietSeconds = 20
    )

    $afterMin = @($Steps | Where-Object { $null -ne $_ -and $null -ne $_.step_index -and [int]$_.step_index -gt $MinStepIndex })
    if ($afterMin.Count -eq 0) {
        return [PSCustomObject]@{
            Completed    = $false
            StepObj      = $null
            StepIndex    = -1
            CreatedAt    = ""
            Content      = ""
            Text         = ""
            WaitingQuiet = $false
        }
    }

    # Find the last USER_INPUT step (if any) so we only inspect the latest turn
    $startIdx = 0
    for ($i = 0; $i -lt $afterMin.Count; $i++) {
        if ($afterMin[$i].type -eq "USER_INPUT") {
            $startIdx = $i + 1
        }
    }

    $candidateIdx = -1
    $latestPlanner = $null

    for ($i = $startIdx; $i -lt $afterMin.Count; $i++) {
        $st = $afterMin[$i]
        if ($st.type -eq "PLANNER_RESPONSE") {
            $latestPlanner = $st
            $hasToolCalls = ($null -ne $st.tool_calls -and @($st.tool_calls).Count -gt 0)
            # R3: A PLANNER_RESPONSE (DONE, no tool_calls, non-empty content) is interim if the step
            # immediately preceding it has status == "RUNNING" (an async background task was just launched)
            $prevIsRunning = ($i -gt 0 -and ([string]$afterMin[$i - 1].status -eq "RUNNING"))
            if ($st.status -eq "DONE" -and -not $hasToolCalls -and $st.content -and -not $prevIsRunning) {
                $candidateIdx = $i
            } else {
                $candidateIdx = -1
            }
        }
    }

    # Condition (a): A candidate final response is valid ONLY if no later step exists except SYSTEM_MESSAGE
    if ($candidateIdx -ge 0) {
        for ($j = $candidateIdx + 1; $j -lt $afterMin.Count; $j++) {
            $laterType = [string]$afterMin[$j].type
            if ($laterType -ne "SYSTEM_MESSAGE") {
                $candidateIdx = -1
                break
            }
        }
    }

    if ($candidateIdx -ge 0) {
        $cand = $afterMin[$candidateIdx]
        $candText = [string]$cand.content
        # Condition (b): transcript.jsonl has not been written for >= $QuietSeconds
        if ($QuietElapsedSeconds -ge $QuietSeconds) {
            return [PSCustomObject]@{
                Completed    = $true
                StepObj      = $cand
                StepIndex    = [int]$cand.step_index
                CreatedAt    = [string]$cand.created_at
                Content      = $candText
                Text         = $candText
                WaitingQuiet = $false
            }
        } else {
            return [PSCustomObject]@{
                Completed    = $false
                StepObj      = $cand
                StepIndex    = [int]$cand.step_index
                CreatedAt    = [string]$cand.created_at
                Content      = $candText
                Text         = $candText
                WaitingQuiet = $true
            }
        }
    }

    if ($null -ne $latestPlanner) {
        $lpText = [string]$latestPlanner.content
        return [PSCustomObject]@{
            Completed    = $false
            StepObj      = $latestPlanner
            StepIndex    = [int]$latestPlanner.step_index
            CreatedAt    = [string]$latestPlanner.created_at
            Content      = $lpText
            Text         = $lpText
            WaitingQuiet = $false
        }
    }

    return [PSCustomObject]@{
        Completed    = $false
        StepObj      = $null
        StepIndex    = -1
        CreatedAt    = ""
        Content      = ""
        Text         = ""
        WaitingQuiet = $false
    }
}

function Read-TranscriptTurnIncremental {
    param(
        [string]$TranscriptPath = "",

        [Parameter(Mandatory=$true)]
        [hashtable]$State,

        [Alias("BaselineStepCount")]
        [int]$MinStepIndex = -999999,

        [int]$QuietSeconds = 20,

        [AllowNull()]
        $QuietElapsedOverride = $null
    )

    if (-not $TranscriptPath -and $State.TranscriptPath) {
        $TranscriptPath = [string]$State.TranscriptPath
    }
    if ($MinStepIndex -eq -999999) {
        $MinStepIndex = if ($null -ne $State.MinStepIndex) { [int]$State.MinStepIndex } else { -1 }
    }

    Update-TranscriptReaderState -State $State -TranscriptPath $TranscriptPath

    $quietElapsed = 0.0
    if ($null -ne $QuietElapsedOverride) {
        $quietElapsed = [double]$QuietElapsedOverride
    } elseif ($TranscriptPath -and (Test-Path -LiteralPath $TranscriptPath -PathType Leaf)) {
        $item = Get-Item -LiteralPath $TranscriptPath -Force -ErrorAction SilentlyContinue
        if ($item) {
            $quietElapsed = [Math]::Max(0.0, ((Get-Date).ToUniversalTime() - $item.LastWriteTimeUtc).TotalSeconds)
        }
    }

    $turn = Evaluate-TranscriptTurn -Steps $State.Steps.ToArray() -MinStepIndex $MinStepIndex -QuietElapsedSeconds $quietElapsed -QuietSeconds $QuietSeconds

    if ($turn.StepObj -and $turn.StepObj.truncated_fields -and ($turn.StepObj.truncated_fields -contains "content")) {
        $fullPath = [string]$State.FullTranscriptPath
        if (-not $fullPath -and $TranscriptPath) {
            $fullPath = Join-Path (Split-Path -Parent $TranscriptPath) "transcript_full.jsonl"
        }
        if ($fullPath -and (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            $targetStep = $turn.StepObj.step_index
            foreach ($fLine in (Get-Content -LiteralPath $fullPath -Encoding UTF8 -ErrorAction SilentlyContinue)) {
                try {
                    $fObj = $fLine | ConvertFrom-Json -ErrorAction Stop
                    if ($fObj.step_index -eq $targetStep -and $fObj.content) {
                        $turn.Content = [string]$fObj.content
                        $turn.Text    = [string]$fObj.content
                        break
                    }
                } catch {}
            }
        }
    }

    return $turn
}

# ==============================================================================
# 9. Shared Model Pricing & Audit Telemetry Helpers (v5 Hardening H4 / H5)
# ==============================================================================
$script:MawModelPricingTable = @{
    "codex"       = @{ InputRate = 2.50;  CachedInputRate = 0.25;  OutputRate = 10.00 }
    "gpt-5-codex" = @{ InputRate = 2.50;  CachedInputRate = 0.25;  OutputRate = 10.00 }
    "gpt-5"       = @{ InputRate = 2.50;  CachedInputRate = 0.25;  OutputRate = 10.00 }
    "sonnet"      = @{ InputRate = 3.00;  CachedInputRate = 0.30;  OutputRate = 15.00 }
    "opus"        = @{ InputRate = 15.00; CachedInputRate = 1.50;  OutputRate = 75.00 }
    "haiku"       = @{ InputRate = 0.80;  CachedInputRate = 0.08;  OutputRate = 4.00  }
    "fable"       = @{ InputRate = 6.00;  CachedInputRate = 0.60;  OutputRate = 30.00 }
    "gemini"      = @{ InputRate = 1.25;  CachedInputRate = 0.125; OutputRate = 5.00  }
    "antigravity" = @{ InputRate = 1.25;  CachedInputRate = 0.125; OutputRate = 5.00  }
}

function Get-MawModelPricing {
    param(
        [string]$Model = "",
        [string]$Tool = ""
    )

    $m = if ($Model) { $Model.Trim().ToLowerInvariant() } else { "" }
    $t = if ($Tool) { $Tool.Trim().ToLowerInvariant() } else { "" }

    if ($m -and $script:MawModelPricingTable.ContainsKey($m)) {
        return $script:MawModelPricingTable[$m]
    }
    if ($m -match 'opus') {
        return $script:MawModelPricingTable["opus"]
    }
    if ($m -match 'haiku') {
        return $script:MawModelPricingTable["haiku"]
    }
    if ($m -match 'fable') {
        return $script:MawModelPricingTable["fable"]
    }
    if ($t -eq 'codex' -or $m -match 'gpt|codex') {
        return $script:MawModelPricingTable["codex"]
    }
    if ($t -eq 'antigravity' -or $t -eq 'gemini' -or $m -match 'gemini') {
        return $script:MawModelPricingTable["gemini"]
    }
    return $script:MawModelPricingTable["sonnet"]
}

function Get-MawTokenCostUsd {
    param(
        [string]$Model = "",
        [string]$Tool = "",
        [long]$InputTokens = 0,
        [long]$CachedInputTokens = 0,
        [long]$OutputTokens = 0
    )

    $rates = Get-MawModelPricing -Model $Model -Tool $Tool
    $totalIn = [Math]::Max([long]0, $InputTokens)
    $cachedIn = [Math]::Max([long]0, [Math]::Min($totalIn, $CachedInputTokens))
    $uncachedIn = [Math]::Max([long]0, $totalIn - $cachedIn)
    $totalOut = [Math]::Max([long]0, $OutputTokens)

    $rawUsd = (($uncachedIn * [double]$rates.InputRate) + ($cachedIn * [double]$rates.CachedInputRate) + ($totalOut * [double]$rates.OutputRate)) / 1000000.0
    return [Math]::Round($rawUsd, 5)
}

function Resolve-MawAuditFilePath {
    param(
        [string]$AuditFileOverride = ""
    )

    $candidate = if ($AuditFileOverride -and $AuditFileOverride.Trim() -ne "") {
        $AuditFileOverride.Trim()
    } elseif ($env:MAW_AUDIT_FILE -and $env:MAW_AUDIT_FILE.Trim() -ne "") {
        $env:MAW_AUDIT_FILE.Trim()
    } else {
        Join-Path $env:USERPROFILE ".gemini\antigravity\multi-ai-audit.jsonl"
    }

    if ($env:MAW_TEST -eq "1") {
        $realProfile = [Environment]::GetFolderPath("UserProfile")
        if (-not $realProfile -and $env:LOCALAPPDATA) {
            try {
                $realProfile = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA "..\.."))
            } catch {}
        }
        if ($realProfile) {
            $normRealGemini = ([System.IO.Path]::GetFullPath((Join-Path $realProfile ".gemini"))).TrimEnd('\', '/').ToLowerInvariant()
            $normCandidate = ""
            try {
                $normCandidate = ([System.IO.Path]::GetFullPath($candidate)).TrimEnd('\', '/').ToLowerInvariant()
            } catch {
                $normCandidate = $candidate.Replace('/', '\').TrimEnd('\').ToLowerInvariant()
            }
            if ($normCandidate -eq $normRealGemini -or $normCandidate.StartsWith("$normRealGemini\")) {
                Write-Warning "[MAW_TEST=1] Refusing to write audit entry to real user profile path: $candidate"
                return $null
            }
        }
    }

    return $candidate
}

function Write-MawAuditEntry {
    param(
        [Parameter(Mandatory=$true)]
        $Entry,
        [string]$AuditFileOverride = ""
    )

    $auditFile = Resolve-MawAuditFilePath -AuditFileOverride $AuditFileOverride
    if (-not $auditFile) {
        return $false
    }

    try {
        $auditDir = Split-Path -Parent $auditFile
        if ($auditDir -and -not (Test-Path -LiteralPath $auditDir)) {
            New-Item -ItemType Directory -Path $auditDir -Force | Out-Null
        }
        $line = ($Entry | ConvertTo-Json -Compress) + [Environment]::NewLine
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::AppendAllText($auditFile, $line, $utf8NoBom)
        return $true
    } catch {
        return $false
    }
}
