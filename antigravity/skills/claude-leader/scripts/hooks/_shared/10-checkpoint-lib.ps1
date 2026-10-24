# PowerShell 5.1 Checkpoint Library for Multi-AI Workflow (SPEC §1.1-1.2)

function New-MawCheckpoint {
    param(
        [Parameter(Mandatory=$true)]
        [string]$WorkDir,

        [Parameter(Mandatory=$true)]
        [string]$JobKey,

        [Parameter(Mandatory=$true)]
        [string]$Event,

        [Parameter(Mandatory=$true)]
        [string]$Label,

        [Parameter(Mandatory=$false)]
        [string]$Agent = "",

        [Parameter(Mandatory=$false)]
        [string]$Role = "",

        [Parameter(Mandatory=$false)]
        $Round = $null,

        [Parameter(Mandatory=$false)]
        [int]$Retention = 0
    )

    try {
        if ($env:MAW_CHECKPOINTS -eq "0") {
            return $null
        }

        if (-not $WorkDir -or -not (Test-Path -LiteralPath $WorkDir -PathType Container)) {
            $script:MawCheckpointLastMessage = "[checkpoint] skipped: not a git repository"
            Write-Verbose $script:MawCheckpointLastMessage
            return $null
        }

        $normJobKey = if ($JobKey) { $JobKey.Trim() } else { "" }
        if (-not $normJobKey -or $normJobKey.StartsWith("-") -or $normJobKey -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$') {
            $script:MawCheckpointLastMessage = "[checkpoint] failed: invalid job key '$normJobKey'"
            Write-Verbose $script:MawCheckpointLastMessage
            return $null
        }

        # Resolve mawHome and check config.json
        $mawHome = if ($env:MAW_HOME -and $env:MAW_HOME.Trim()) {
            $env:MAW_HOME.Trim()
        } else {
            Join-Path ([Environment]::GetFolderPath('UserProfile')) ".maw"
        }
        $cfgFile = Join-Path $mawHome "data\checkpoints\config.json"
        $effectiveRetention = 50
        if (Test-Path -LiteralPath $cfgFile -PathType Leaf) {
            try {
                $cfgJson = Get-Content -LiteralPath $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($null -ne $cfgJson) {
                    if ($null -ne $cfgJson.enabled -and [bool]$cfgJson.enabled -eq $false) {
                        return $null
                    }
                    if ($null -ne $cfgJson.retention) {
                        $r = [int]$cfgJson.retention
                        if ($r -ge 5 -and $r -le 500) {
                            $effectiveRetention = $r
                        }
                    }
                }
            } catch {}
        }
        if ($Retention -ge 5 -and $Retention -le 500) {
            $effectiveRetention = $Retention
        }

        # Ensure maw-common is loaded for Invoke-NativeProcess (C4)
        if (-not (Get-Command -Name "Invoke-NativeProcess" -ErrorAction SilentlyContinue)) {
            $thisDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path $MyInvocation.MyCommand.Path -Parent } else { "" }
            $candidatePaths = @()
            if ($thisDir) {
                $hooksParent = Split-Path $thisDir -Parent
                $scriptsParent = Split-Path $hooksParent -Parent
                $candidatePaths += Join-Path $scriptsParent "lib\maw-common.ps1"
            }
            if (Get-Variable -Name "scriptsDir" -Scope Script -ErrorAction SilentlyContinue) {
                $candidatePaths += Join-Path $script:scriptsDir "lib\maw-common.ps1"
            }
            $candidatePaths += Join-Path ([Environment]::GetFolderPath('UserProfile')) ".gemini\config\skills\claude-leader\scripts\lib\maw-common.ps1"
            $candidatePaths += Join-Path ([Environment]::GetFolderPath('UserProfile')) ".maw\scripts\lib\maw-common.ps1"

            foreach ($cPath in $candidatePaths) {
                if ($cPath -and (Test-Path -LiteralPath $cPath -PathType Leaf)) {
                    . $cPath
                    if (Get-Command -Name "Invoke-NativeProcess" -ErrorAction SilentlyContinue) {
                        break
                    }
                }
            }
        }

        if (-not (Get-Command -Name "Invoke-NativeProcess" -ErrorAction SilentlyContinue)) {
            $script:MawCheckpointLastMessage = "[checkpoint] skipped: Invoke-NativeProcess not available"
            Write-Verbose $script:MawCheckpointLastMessage
            return $null
        }

        # Resolve git top-level (C6)
        $topRes = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $WorkDir, "rev-parse", "--show-toplevel") -WorkingDirectory $WorkDir -TimeoutMs 10000
        if ($topRes.ExitCode -ne 0 -or -not $topRes.StdOut -or -not $topRes.StdOut.Trim()) {
            $script:MawCheckpointLastMessage = "[checkpoint] skipped: not a git repository"
            Write-Verbose $script:MawCheckpointLastMessage
            return $null
        }

        $top = ($topRes.StdOut.Trim() -split "[\r\n]+")[0].Trim()
        $normWorkDir = [System.IO.Path]::GetFullPath($top).TrimEnd('\', '/').ToLowerInvariant()

        # Sanitize message inputs (C7)
        $cleanLabel = ($Label -replace '[\x00-\x1f\x7f]', ' ').Trim()
        if ($cleanLabel.Length -gt 200) {
            $cleanLabel = $cleanLabel.Substring(0, 200)
        }
        $cleanAgent = if ($Agent -match '^[a-zA-Z0-9-]{0,32}$') { $Agent.ToLowerInvariant() } else { "" }
        $cleanRole = if ($Role -match '^[a-zA-Z0-9-]{0,32}$') { $Role.ToLowerInvariant() } else { "" }

        $tempDir = [System.IO.Path]::GetTempPath()
        $randHex = [System.Guid]::NewGuid().ToString('N').Substring(0, 12)
        $tmpIndex = Join-Path $tempDir "maw-cp-$randHex.idx"
        $msgFile = Join-Path $tempDir "maw-cp-msg-$randHex.txt"

        $origIndex = $env:GIT_INDEX_FILE
        $origTerminalPrompt = $env:GIT_TERMINAL_PROMPT
        $origOptionalLocks = $env:GIT_OPTIONAL_LOCKS
        $origAuthorName = $env:GIT_AUTHOR_NAME
        $origAuthorEmail = $env:GIT_AUTHOR_EMAIL
        $origCommitterName = $env:GIT_COMMITTER_NAME
        $origCommitterEmail = $env:GIT_COMMITTER_EMAIL
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'SilentlyContinue'

        try {
            # Copy real index if present
            $gitPathRes = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $top, "rev-parse", "--git-path", "index") -WorkingDirectory $top -TimeoutMs 5000
            if ($gitPathRes.ExitCode -eq 0 -and $gitPathRes.StdOut.Trim()) {
                $rawIdx = ($gitPathRes.StdOut.Trim() -split "[\r\n]+")[0].Trim()
                $realIdx = if ([System.IO.Path]::IsPathRooted($rawIdx)) { $rawIdx } else { Join-Path $top $rawIdx }
                if (Test-Path -LiteralPath $realIdx -PathType Leaf) {
                    Copy-Item -LiteralPath $realIdx -Destination $tmpIndex -Force -ErrorAction SilentlyContinue
                }
            }

            $env:GIT_INDEX_FILE = $tmpIndex
            $env:GIT_TERMINAL_PROMPT = "0"
            $env:GIT_OPTIONAL_LOCKS = "0"

            $addRes = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $top, "add", "-A", "--", ".") -WorkingDirectory $top -TimeoutMs 30000
            if ($addRes.ExitCode -ne 0) {
                $script:MawCheckpointLastMessage = "[checkpoint] failed: git add failed"
                Write-Verbose $script:MawCheckpointLastMessage
                return $null
            }

            $writeTreeRes = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $top, "write-tree") -WorkingDirectory $top -TimeoutMs 15000
            if ($writeTreeRes.ExitCode -ne 0 -or -not $writeTreeRes.StdOut.Trim()) {
                $script:MawCheckpointLastMessage = "[checkpoint] failed: git write-tree failed"
                Write-Verbose $script:MawCheckpointLastMessage
                return $null
            }
            $treeSha = ($writeTreeRes.StdOut.Trim() -split "[\r\n]+")[0].Trim()

            # Check dedup: get highest n for this JobKey
            $refPrefix = "refs/maw/checkpoints/$normJobKey/"
            $existingRefsRes = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $top, "for-each-ref", "--format=%(refname)", $refPrefix) -WorkingDirectory $top -TimeoutMs 10000
            $maxN = 0
            $newestRef = $null
            if ($existingRefsRes.ExitCode -eq 0 -and $existingRefsRes.StdOut) {
                $existingRefs = $existingRefsRes.StdOut -split "[\r\n]+"
                foreach ($r in $existingRefs) {
                    if ($r -match '/(\d{4})$') {
                        $n = [int]$Matches[1]
                        if ($n -gt $maxN) {
                            $maxN = $n
                            $newestRef = $r.Trim()
                        }
                    }
                }
            }

            if ($newestRef) {
                $existingTreeRes = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $top, "rev-parse", "$newestRef^{tree}") -WorkingDirectory $top -TimeoutMs 5000
                if ($existingTreeRes.ExitCode -eq 0 -and $existingTreeRes.StdOut.Trim()) {
                    $existingTree = ($existingTreeRes.StdOut.Trim() -split "[\r\n]+")[0].Trim()
                    if ($existingTree -eq $treeSha) {
                        # Dedup: same tree captured, return existing id
                        $nFormatted = "{0:D4}" -f $maxN
                        return "$normJobKey/$nFormatted"
                    }
                }
            }

            # Check HEAD parent
            $parentRes = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $top, "rev-parse", "--verify", "-q", "HEAD") -WorkingDirectory $top -TimeoutMs 5000
            $parentSha = if ($parentRes.ExitCode -eq 0 -and $parentRes.StdOut.Trim()) {
                ($parentRes.StdOut.Trim() -split "[\r\n]+")[0].Trim()
            } else {
                $null
            }

            # Prepare message without BOM (C10)
            $roundVal = if ($null -ne $Round -and [string]$Round -ne "") { [string]$Round } else { "" }
            $msgLines = @(
                "maw checkpoint: $cleanLabel",
                "",
                "MAW-Event: $Event",
                "MAW-Job: $normJobKey",
                "MAW-Agent: $cleanAgent",
                "MAW-Role: $cleanRole",
                "MAW-Round: $roundVal",
                "MAW-Workdir: $normWorkDir"
            )
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText($msgFile, ($msgLines -join "`n"), $utf8NoBom)

            $env:GIT_AUTHOR_NAME = "MAW Checkpoint"
            $env:GIT_AUTHOR_EMAIL = "maw@localhost"
            $env:GIT_COMMITTER_NAME = "MAW Checkpoint"
            $env:GIT_COMMITTER_EMAIL = "maw@localhost"

            $commitArgs = if ($parentSha) {
                @("-C", $top, "commit-tree", $treeSha, "-p", $parentSha, "-F", $msgFile)
            } else {
                @("-C", $top, "commit-tree", $treeSha, "-F", $msgFile)
            }
            $commitRes = Invoke-NativeProcess -FilePath "git" -ArgumentList $commitArgs -WorkingDirectory $top -TimeoutMs 15000
            if ($commitRes.ExitCode -ne 0 -or -not $commitRes.StdOut.Trim()) {
                $script:MawCheckpointLastMessage = "[checkpoint] failed: git commit-tree failed"
                Write-Verbose $script:MawCheckpointLastMessage
                return $null
            }
            $commitSha = ($commitRes.StdOut.Trim() -split "[\r\n]+")[0].Trim()

            # Concurrency retry loop with 40-zero expected old SHA (C3)
            $zeroSha = "0000000000000000000000000000000000000000"
            $createdId = $null

            for ($attempt = 0; $attempt -lt 5; $attempt++) {
                $curRefsRes = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $top, "for-each-ref", "--format=%(refname)", $refPrefix) -WorkingDirectory $top -TimeoutMs 10000
                $curMax = 0
                if ($curRefsRes.ExitCode -eq 0 -and $curRefsRes.StdOut) {
                    foreach ($line in ($curRefsRes.StdOut -split "[\r\n]+")) {
                        if ($line -match '/(\d{4})$') {
                            $val = [int]$Matches[1]
                            if ($val -gt $curMax) { $curMax = $val }
                        }
                    }
                }
                $nextN = $curMax + 1
                $nStr = "{0:D4}" -f $nextN
                $newRef = "$refPrefix$nStr"

                $updRes = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $top, "update-ref", $newRef, $commitSha, $zeroSha) -WorkingDirectory $top -TimeoutMs 10000
                if ($updRes.ExitCode -eq 0) {
                    $createdId = "$normJobKey/$nStr"
                    break
                }
            }

            if (-not $createdId) {
                $script:MawCheckpointLastMessage = "[checkpoint] failed: git update-ref concurrency limit exceeded"
                Write-Verbose $script:MawCheckpointLastMessage
                return $null
            }

            # Retention pruning: sort by creatordate:unix integer comparison (C2, Y2)
            $rawCheckpointsRes = Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $top, "for-each-ref", "--format=%(refname)%00%(creatordate:unix)%00%(contents)%00@@MAW_END@@%0a", "refs/maw/checkpoints/") -WorkingDirectory $top -TimeoutMs 15000
            if ($rawCheckpointsRes.ExitCode -eq 0 -and $rawCheckpointsRes.StdOut) {
                $allCheckpoints = @($rawCheckpointsRes.StdOut -split "\0@@MAW_END@@`r?`n")
                $matched = @()
                $newRef = "refs/maw/checkpoints/$createdId"
                foreach ($entry in $allCheckpoints) {
                    $parts = $entry -split [char]0
                    if ($parts.Count -ge 3) {
                        $rName = $parts[0].Trim()
                        # Exclude newly created ref so it is never pruned (Y2)
                        if ($rName -eq $newRef) { continue }
                        $rUnix = 0
                        [int64]::TryParse($parts[1].Trim(), [ref]$rUnix) | Out-Null
                        $rContent = $parts[2]
                        $wMatch = [regex]::Match($rContent, '(?m)^MAW-Workdir:\s*(.*)$')
                        if ($wMatch.Success) {
                            $wDir = $wMatch.Groups[1].Value.Trim().TrimEnd('\', '/').ToLowerInvariant()
                            if ($wDir -eq $normWorkDir) {
                                $matched += [PSCustomObject]@{
                                    Ref  = $rName
                                    Unix = $rUnix
                                }
                            }
                        }
                    }
                }

                $maxOthers = [Math]::Max(0, $effectiveRetention - 1)
                if ($matched.Count -gt $maxOthers) {
                    $sorted = @($matched | Sort-Object -Property Unix -Descending)
                    $toDelete = $sorted | Select-Object -Skip $maxOthers
                    foreach ($del in $toDelete) {
                        Invoke-NativeProcess -FilePath "git" -ArgumentList @("-C", $top, "update-ref", "-d", $del.Ref) -WorkingDirectory $top -TimeoutMs 5000 | Out-Null
                    }
                }
            }

            return $createdId
        } finally {
            $ErrorActionPreference = $prevEap
            $env:GIT_INDEX_FILE = $origIndex
            $env:GIT_TERMINAL_PROMPT = $origTerminalPrompt
            $env:GIT_OPTIONAL_LOCKS = $origOptionalLocks
            $env:GIT_AUTHOR_NAME = $origAuthorName
            $env:GIT_AUTHOR_EMAIL = $origAuthorEmail
            $env:GIT_COMMITTER_NAME = $origCommitterName
            $env:GIT_COMMITTER_EMAIL = $origCommitterEmail
            if (Test-Path -LiteralPath $tmpIndex) {
                Remove-Item -LiteralPath $tmpIndex -Force -ErrorAction SilentlyContinue
            }
            if (Test-Path -LiteralPath $msgFile) {
                Remove-Item -LiteralPath $msgFile -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {
        $script:MawCheckpointLastMessage = "[checkpoint] failed: $($_.Exception.Message)"
        Write-Verbose $script:MawCheckpointLastMessage
        return $null
    }
}
