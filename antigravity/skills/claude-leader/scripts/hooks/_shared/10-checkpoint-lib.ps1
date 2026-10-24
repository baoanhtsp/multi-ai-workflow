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
            [Console]::Out.WriteLine("[checkpoint] skipped: not a git repository")
            return $null
        }

        $normJobKey = if ($JobKey) { $JobKey.Trim() } else { "" }
        if (-not $normJobKey -or $normJobKey.StartsWith("-") -or $normJobKey -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$') {
            [Console]::Out.WriteLine("[checkpoint] failed: invalid job key '$normJobKey'")
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

        # Ensure maw-common is loaded for Invoke-NativeProcess if available
        if (-not (Get-Command -Name "Invoke-NativeProcess" -ErrorAction SilentlyContinue)) {
            $scriptsDir = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
            $commonPath = Join-Path $scriptsDir "lib\maw-common.ps1"
            if (Test-Path -LiteralPath $commonPath -PathType Leaf) {
                . $commonPath
            }
        }

        # Check git repo
        $topLevelRes = if (Get-Command -Name "Invoke-NativeProcess" -ErrorAction SilentlyContinue) {
            Invoke-NativeProcess -FilePath "git" -ArgumentList @("rev-parse", "--show-toplevel") -WorkingDirectory $WorkDir -TimeoutMs 10000
        } else {
            $psi = New-Object System.Diagnostics.ProcessStartInfo "git", "rev-parse --show-toplevel"
            $psi.WorkingDirectory = $WorkDir
            $psi.RedirectStandardOutput = $true
            $psi.RedirectStandardError = $true
            $psi.UseShellExecute = $false
            $psi.CreateNoWindow = $true
            $p = [System.Diagnostics.Process]::Start($psi)
            $p.WaitForExit(10000)
            [PSCustomObject]@{ ExitCode = $p.ExitCode; StdOut = $p.StandardOutput.ReadToEnd() }
        }

        if ($topLevelRes.ExitCode -ne 0 -or -not $topLevelRes.StdOut -or -not $topLevelRes.StdOut.Trim()) {
            [Console]::Out.WriteLine("[checkpoint] skipped: not a git repository")
            return $null
        }

        $normWorkDir = [System.IO.Path]::GetFullPath($WorkDir).TrimEnd('\', '/').ToLowerInvariant()

        $tempDir = [System.IO.Path]::GetTempPath()
        $randHex = [System.Guid]::NewGuid().ToString('N').Substring(0, 12)
        $tmpIndex = Join-Path $tempDir "maw-cp-$randHex.idx"
        $msgFile = Join-Path $tempDir "maw-cp-msg-$randHex.txt"

        $origIndex = $env:GIT_INDEX_FILE
        $origAuthorName = $env:GIT_AUTHOR_NAME
        $origAuthorEmail = $env:GIT_AUTHOR_EMAIL
        $origCommitterName = $env:GIT_COMMITTER_NAME
        $origCommitterEmail = $env:GIT_COMMITTER_EMAIL
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'SilentlyContinue'

        try {
            # Copy real index if present
            $gitPathRes = & git -C $WorkDir rev-parse --git-path index 2>$null
            if ($LASTEXITCODE -eq 0 -and $gitPathRes) {
                $rawIdx = ($gitPathRes | Select-Object -First 1).Trim()
                $realIdx = if ([System.IO.Path]::IsPathRooted($rawIdx)) { $rawIdx } else { Join-Path $WorkDir $rawIdx }
                if (Test-Path -LiteralPath $realIdx -PathType Leaf) {
                    Copy-Item -LiteralPath $realIdx -Destination $tmpIndex -Force -ErrorAction SilentlyContinue
                }
            }

            $env:GIT_INDEX_FILE = $tmpIndex
            $env:GIT_TERMINAL_PROMPT = "0"
            $env:GIT_OPTIONAL_LOCKS = "0"

            & git -C $WorkDir add -A -- . 2>$null
            if ($LASTEXITCODE -ne 0) {
                [Console]::Out.WriteLine("[checkpoint] failed: git add failed")
                return $null
            }

            $writeTreeRes = & git -C $WorkDir write-tree 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $writeTreeRes) {
                [Console]::Out.WriteLine("[checkpoint] failed: git write-tree failed")
                return $null
            }
            $treeSha = ($writeTreeRes | Select-Object -First 1).Trim()

            # Check dedup: get highest n for this JobKey
            $refPrefix = "refs/maw/checkpoints/$normJobKey/"
            $existingRefs = @(& git -C $WorkDir for-each-ref --format="%(refname)" $refPrefix 2>$null)
            $maxN = 0
            $newestRef = $null
            foreach ($r in $existingRefs) {
                if ($r -match '/(\d{4})$') {
                    $n = [int]$Matches[1]
                    if ($n -gt $maxN) {
                        $maxN = $n
                        $newestRef = $r.Trim()
                    }
                }
            }

            if ($newestRef) {
                $existingTreeRes = & git -C $WorkDir rev-parse "$newestRef^{tree}" 2>$null
                if ($LASTEXITCODE -eq 0 -and $existingTreeRes) {
                    $existingTree = ($existingTreeRes | Select-Object -First 1).Trim()
                    if ($existingTree -eq $treeSha) {
                        # Dedup: same tree captured, return existing id
                        $nFormatted = "{0:D4}" -f $maxN
                        return "$normJobKey/$nFormatted"
                    }
                }
            }

            $nextN = $maxN + 1
            $nStr = "{0:D4}" -f $nextN
            $newRef = "$refPrefix$nStr"

            # Check HEAD parent
            $parentRes = & git -C $WorkDir rev-parse --verify -q HEAD 2>$null
            $parentSha = if ($LASTEXITCODE -eq 0 -and $parentRes) { ($parentRes | Select-Object -First 1).Trim() } else { $null }

            # Prepare message
            $roundVal = if ($null -ne $Round -and [string]$Round -ne "") { [string]$Round } else { "" }
            $msgLines = @(
                "maw checkpoint: $Label",
                "",
                "MAW-Event: $Event",
                "MAW-Job: $normJobKey",
                "MAW-Agent: $Agent",
                "MAW-Role: $Role",
                "MAW-Round: $roundVal",
                "MAW-Workdir: $normWorkDir"
            )
            [System.IO.File]::WriteAllText($msgFile, ($msgLines -join "`n"), [System.Text.Encoding]::UTF8)

            $env:GIT_AUTHOR_NAME = "MAW Checkpoint"
            $env:GIT_AUTHOR_EMAIL = "maw@localhost"
            $env:GIT_COMMITTER_NAME = "MAW Checkpoint"
            $env:GIT_COMMITTER_EMAIL = "maw@localhost"

            $commitRes = if ($parentSha) {
                & git -C $WorkDir commit-tree $treeSha -p $parentSha -F $msgFile 2>$null
            } else {
                & git -C $WorkDir commit-tree $treeSha -F $msgFile 2>$null
            }

            if ($LASTEXITCODE -ne 0 -or -not $commitRes) {
                [Console]::Out.WriteLine("[checkpoint] failed: git commit-tree failed")
                return $null
            }
            $commitSha = ($commitRes | Select-Object -First 1).Trim()

            & git -C $WorkDir update-ref $newRef $commitSha 2>$null
            if ($LASTEXITCODE -ne 0) {
                [Console]::Out.WriteLine("[checkpoint] failed: git update-ref failed")
                return $null
            }

            # Retention pruning: delete older refs exceeding retention for this workdir
            $rawCheckpoints = (& git -C $WorkDir for-each-ref --format="%(refname)%00%(authordate:iso-strict)%00%(contents)%00@@MAW_END@@%0a" "refs/maw/checkpoints/" 2>$null) -join "`n"
            $allCheckpoints = @($rawCheckpoints -split "\0@@MAW_END@@`n")
            $matched = @()
            foreach ($entry in $allCheckpoints) {
                $parts = $entry -split [char]0
                if ($parts.Count -ge 3) {
                    $rName = $parts[0].Trim()
                    $rDate = $parts[1].Trim()
                    $rContent = $parts[2]
                    $wMatch = [regex]::Match($rContent, '(?m)^MAW-Workdir:\s*(.*)$')
                    if ($wMatch.Success) {
                        $wDir = $wMatch.Groups[1].Value.Trim().TrimEnd('\', '/').ToLowerInvariant()
                        if ($wDir -eq $normWorkDir) {
                            $matched += [PSCustomObject]@{
                                Ref  = $rName
                                Date = $rDate
                            }
                        }
                    }
                }
            }

            if ($matched.Count -gt $effectiveRetention) {
                $sorted = @($matched | Sort-Object -Property Date -Descending)
                $toDelete = $sorted | Select-Object -Skip $effectiveRetention
                foreach ($del in $toDelete) {
                    & git -C $WorkDir update-ref -d $del.Ref 2>$null
                }
            }

            return "$normJobKey/$nStr"
        } finally {
            $ErrorActionPreference = $prevEap
            $env:GIT_INDEX_FILE = $origIndex
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
        [Console]::Out.WriteLine("[checkpoint] failed: $($_.Exception.Message)")
        return $null
    }
}
