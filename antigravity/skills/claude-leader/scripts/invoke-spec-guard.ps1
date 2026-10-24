param(
    [Parameter(Mandatory=$true)]
    [string]$WorkDir,

    [Parameter(Mandatory=$false)]
    [string]$Owner = "",

    [Parameter(Mandatory=$false)]
    [string]$Baseline = "",

    [Parameter(Mandatory=$false)]
    [switch]$Json
)

$ErrorActionPreference = "Continue"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot "lib\maw-common.ps1")
. (Join-Path $PSScriptRoot "lib\maw-registry.ps1")

$script:Registry = Get-AgentRegistry -ScriptsDir $PSScriptRoot
$enabledOwnerIds = @($script:Registry.agents | ForEach-Object { [string]$_.id })
$normCheckOwner = if ($Owner) { $Owner.Trim().ToLowerInvariant() } else { "" }
if ($normCheckOwner -and ($normCheckOwner -notin $enabledOwnerIds)) {
    $err = @{ ok = $false; error = "Invalid Owner '$Owner'. Allowed: $($enabledOwnerIds -join ', '), or empty." }
    if ($Json) { $err | ConvertTo-Json -Compress; exit 1 }
    Write-Error $err.error
    exit 1
}

if (-not (Test-Path -LiteralPath $WorkDir)) {
    $err = @{ ok = $false; error = "WorkDir does not exist: $WorkDir" }
    if ($Json) { $err | ConvertTo-Json -Compress; exit 1 }
    Write-Error $err.error
    exit 1
}

function Test-SpecGlobMatch {
    param(
        [Parameter(Mandatory=$true)]
        [string]$RelPath,

        [Parameter(Mandatory=$true)]
        [string]$Pattern
    )

    $normPath = ($RelPath -replace '\\', '/').TrimStart('/')
    $normPat  = ($Pattern -replace '\\', '/').Trim()
    if (-not $normPat) { return $false }

    # A pattern without '/' matches the basename anywhere
    $target = if ($normPat -notmatch '/') {
        ($normPath -split '/')[-1]
    } else {
        $normPath
    }

    $work = $normPat
    $work = $work.Replace('/**/', '__GLOBSTAR_MID__')
    if ($work.EndsWith('/**')) {
        $work = $work.Substring(0, $work.Length - 3) + '__GLOBSTAR_END__'
    }
    if ($work.StartsWith('**/')) {
        $work = '__GLOBSTAR_START__' + $work.Substring(3)
    }
    $work = $work.Replace('**', '__GLOBSTAR_ANY__')
    $work = $work.Replace('*', '__STAR__')
    $work = $work.Replace('?', '__QMARK__')

    $escaped = [regex]::Escape($work)
    $escaped = $escaped.Replace('__GLOBSTAR_MID__', '(?:/|/.+/)')
    $escaped = $escaped.Replace('__GLOBSTAR_END__', '(?:/.*)?')
    $escaped = $escaped.Replace('__GLOBSTAR_START__', '(?:.+/|)')
    $escaped = $escaped.Replace('__GLOBSTAR_ANY__', '.*')
    $escaped = $escaped.Replace('__STAR__', '[^/]*')
    $escaped = $escaped.Replace('__QMARK__', '[^/]')

    $rx = '(?i)^' + $escaped + '$'
    return ($target -match $rx)
}

function Get-BacktickPathPatterns {
    param([string]$CellText)

    $patterns = [System.Collections.Generic.List[string]]::new()
    if (-not $CellText) { return @() }

    $matchesList = [regex]::Matches($CellText, '`([^`]+)`')
    foreach ($m in $matchesList) {
        $tok = $m.Groups[1].Value.Trim()
        if ($tok -and ($tok -match '[*/.]') -and (-not $tok.StartsWith('-'))) {
            if (-not $patterns.Contains($tok)) {
                $patterns.Add($tok)
            }
        }
    }
    return $patterns.ToArray()
}

function Parse-SpecOwnershipTable {
    param([string]$SpecText)

    $rules = [System.Collections.Generic.List[psobject]]::new()
    if (-not $SpecText) { return @() }

    $lines = $SpecText -replace "`r`n", "`n" -split "`n"
    $inTargetTable = $false
    $ownerIdx = -1
    $allowedIdx = -1
    $forbiddenIdx = -1

    foreach ($rawLine in $lines) {
        $line = $rawLine.Trim()
        if (-not $line.StartsWith('|') -or -not $line.EndsWith('|')) {
            if ($inTargetTable) {
                break
            }
            continue
        }

        $cells = @($line.Substring(1, $line.Length - 2) -split '\|' | ForEach-Object { $_.Trim() })

        if (-not $inTargetTable) {
            $oIdx = -1
            $aIdx = -1
            $fIdx = -1
            for ($i = 0; $i -lt $cells.Count; $i++) {
                if ($oIdx -lt 0 -and $cells[$i] -match '(?i)\bOwner\b') { $oIdx = $i }
                if ($aIdx -lt 0 -and $cells[$i] -match '(?i)\bAllowed\b') { $aIdx = $i }
                if ($fIdx -lt 0 -and $cells[$i] -match '(?i)\bForbidden\b') { $fIdx = $i }
            }
            if ($oIdx -ge 0 -and $aIdx -ge 0) {
                $inTargetTable = $true
                $ownerIdx = $oIdx
                $allowedIdx = $aIdx
                $forbiddenIdx = $fIdx
            }
            continue
        }

        # Skip markdown separator row (e.g. | :--- | :--- |)
        $isSeparator = $true
        foreach ($c in $cells) {
            if ($c -notmatch '^[\s:\-]+$') {
                $isSeparator = $false
                break
            }
        }
        if ($isSeparator) { continue }

        if ($ownerIdx -ge $cells.Count -or $allowedIdx -ge $cells.Count) {
            continue
        }

        $ownerCell = $cells[$ownerIdx]
        $resolvedOwners = @(Resolve-AgentOwner -CellText $ownerCell -Registry $script:Registry)
        if ($resolvedOwners.Count -eq 0) {
            $fallbackKey = ($ownerCell -replace '[*`]', '').ToLowerInvariant().Trim()
            if ($fallbackKey) {
                $resolvedOwners = @($fallbackKey)
            }
        }

        $allowedPats = @(Get-BacktickPathPatterns -CellText $cells[$allowedIdx])
        $forbiddenPats = if ($forbiddenIdx -ge 0 -and $forbiddenIdx -lt $cells.Count) {
            @(Get-BacktickPathPatterns -CellText $cells[$forbiddenIdx])
        } else {
            @()
        }

        foreach ($ownerKey in $resolvedOwners) {
            $rules.Add([PSCustomObject]@{
                owner     = $ownerKey
                allowed   = $allowedPats
                forbidden = $forbiddenPats
            })
        }
    }

    return $rules.ToArray()
}

# Load baseline snapshot if provided (R2)
$baselineMap = @{}
if ($Baseline -and (Test-Path -LiteralPath $Baseline -PathType Leaf)) {
    try {
        $baseObj = Get-Content -LiteralPath $Baseline -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
        if ($null -ne $baseObj) {
            foreach ($prop in $baseObj.PSObject.Properties) {
                $normKey = ($prop.Name -replace '\\', '/').TrimStart('/')
                $baselineMap[$normKey] = [string]$prop.Value
            }
        }
    } catch {}
}

Push-Location $WorkDir
try {
    $specPath = Join-Path $WorkDir "SPEC.md"
    $hasSpec  = Test-Path -LiteralPath $specPath -PathType Leaf
    $normOwner = if ($Owner) { $Owner.Trim().ToLowerInvariant() } else { "" }

    $specEndpoints  = [System.Collections.Generic.List[string]]::new()
    $ownershipRules = @()
    $violations     = [System.Collections.Generic.List[string]]::new()
    $warnings       = [System.Collections.Generic.List[string]]::new()

    if ($hasSpec) {
        $specContent = Get-Content -LiteralPath $specPath -Raw -Encoding UTF8

        # Extract endpoints like GET api.php?action=status, POST /api/..., POST ?action=...
        $epMatches = [regex]::Matches($specContent, '\b(GET|POST|PUT|PATCH|DELETE)\s+`?([^\s`"'')|]+)')
        foreach ($m in $epMatches) {
            $verb = $m.Groups[1].Value.ToUpperInvariant()
            $rawTarget = $m.Groups[2].Value -replace '[`.,;:]+$', ''
            if ($rawTarget -match '[/?\.]') {
                $ep = "$verb $rawTarget"
                if (-not $specEndpoints.Contains($ep)) {
                    $specEndpoints.Add($ep)
                }
            }
        }

        $ownershipRules = @(Parse-SpecOwnershipTable -SpecText $specContent)
        if ($ownershipRules.Count -eq 0) {
            $headSpec = (& git -C $WorkDir show HEAD:SPEC.md 2>$null) -join "`n"
            $global:LASTEXITCODE = 0
            if ($headSpec) {
                $ownershipRules = @(Parse-SpecOwnershipTable -SpecText $headSpec)
            }
        }

        if ($specContent -match '(?m)^#.*<Project / Feature Name>' -or $specContent -match '<Project / Feature Name>') {
            $warnings.Add("SPEC.md still contains unfilled template placeholders.")
        }
    } else {
        $warnings.Add("SPEC.md is missing in project root. Run 'Init SPEC.md' before multi-AI execution.")
    }

    # R4: If -Owner is specified but has no row in the ownership matrix, emit warning
    $ownerRows = @()
    if ($normOwner -and $ownershipRules.Count -gt 0) {
        $ownerRows = @($ownershipRules | Where-Object { $_.owner -eq $normOwner })
        if ($ownerRows.Count -eq 0) {
            $warnings.Add("Owner '$normOwner' has no row in the ownership matrix; nothing was enforced.")
        }
    }

    # Check if WorkDir is a git repository
    $gitInside = (& git -C $WorkDir rev-parse --is-inside-work-tree 2>$null) -join ""
    $hasGit = ($LASTEXITCODE -eq 0 -and $gitInside.Trim() -eq "true")
    $global:LASTEXITCODE = 0

    $modifiedFiles = [System.Collections.Generic.List[psobject]]::new()

    if (-not $hasGit) {
        $warnings.Add("WorkDir is not a Git repository.")
    } else {
        $gitStatusLines = @(& git -C $WorkDir -c core.quotepath=false status --porcelain -uall 2>$null)
        $global:LASTEXITCODE = 0

        foreach ($line in $gitStatusLines) {
            if (-not $line -or $line.Length -lt 4) { continue }
            $statusFlag = $line.Substring(0, 2).Trim()
            $relPath = $line.Substring(3).Trim().Trim('"')
            if ($relPath -match ' -> ') {
                $relPath = ($relPath -split ' -> ')[-1].Trim().Trim('"')
            }
            $normRel = ($relPath -replace '\\', '/').TrimStart('/')

            $ext = [System.IO.Path]::GetExtension($normRel).ToLowerInvariant()
            $isFrontend = $ext -in @('.html', '.htm', '.css', '.scss', '.sass', '.less', '.jsx', '.tsx', '.vue', '.svelte') -or
                          $normRel -match '(?i)\.blade\.php$' -or
                          $normRel -match '(?i)\.ejs$' -or
                          ($normRel -match '(?i)^(frontend|client|public|resources/views|dashboard)/.*\.(js|ts)$')

            $matchedRowOwners = [System.Collections.Generic.List[string]]::new()
            foreach ($rule in $ownershipRules) {
                foreach ($allowPat in $rule.allowed) {
                    if (Test-SpecGlobMatch -RelPath $normRel -Pattern $allowPat) {
                        if (-not $matchedRowOwners.Contains($rule.owner)) {
                            $matchedRowOwners.Add($rule.owner)
                        }
                        break
                    }
                }
            }

            if ($matchedRowOwners.Count -gt 0) {
                $assignedOwner = ($matchedRowOwners -join "/")
            } else {
                if ($ownershipRules.Count -gt 0) {
                    $warnings.Add("Modified file '$normRel' is not covered by any Allowed pattern in SPEC.md.")
                }
                $isTestFile = ($normRel -match '(?i)(^|/)(tests?|__tests__)/|\.(test|spec)\.[a-z]+$')
                $assignedOwner = if ($isFrontend) {
                    "claude"
                } elseif ($isTestFile) {
                    "antigravity/codex"
                } else {
                    "antigravity"
                }
            }

            # R2: Skip -Owner enforcement if file's current signature matches the pre-existing baseline
            $isUnchangedBaseline = $false
            if ($baselineMap.ContainsKey($normRel)) {
                $fullFilePath = Join-Path $WorkDir ($normRel -replace '/', '\')
                $currentSig = Get-FileContentSignature -FullPath $fullFilePath
                if ($baselineMap[$normRel] -eq $currentSig) {
                    $isUnchangedBaseline = $true
                }
            }

            if ($normOwner -and $ownerRows.Count -gt 0 -and -not $isUnchangedBaseline) {
                $ownerAllowed = @($ownerRows | ForEach-Object { $_.allowed } | Where-Object { $_ })
                $ownerForbidden = @($ownerRows | ForEach-Object { $_.forbidden } | Where-Object { $_ })

                $hitForbidden = $false
                foreach ($fPat in $ownerForbidden) {
                    if (Test-SpecGlobMatch -RelPath $normRel -Pattern $fPat) {
                        $hitForbidden = $true
                        break
                    }
                }

                $hitAllowed = $false
                foreach ($aPat in $ownerAllowed) {
                    if (Test-SpecGlobMatch -RelPath $normRel -Pattern $aPat) {
                        $hitAllowed = $true
                        break
                    }
                }

                if ($hitForbidden) {
                    $violations.Add("Owner '$normOwner' modified forbidden file: $normRel")
                } elseif (-not $hitAllowed) {
                    $violations.Add("Owner '$normOwner' modified file outside Allowed paths: $normRel")
                }
            }

            $modifiedFiles.Add([PSCustomObject]@{
                path     = $normRel
                status   = $statusFlag
                category = if ($isFrontend) { "frontend" } else { "backend" }
                owner    = $assignedOwner
            })
        }
    }

    $feFiles = @($modifiedFiles | Where-Object { $_.category -eq "frontend" })
    $beFiles = @($modifiedFiles | Where-Object { $_.category -eq "backend" })

    $verdict = if ($violations.Count -gt 0) {
        "FAIL"
    } elseif ($warnings.Count -gt 0) {
        "WARN"
    } else {
        "PASS"
    }

    $report = [ordered]@{
        ok              = $true
        verdict         = $verdict
        work_dir        = $WorkDir
        has_spec        = [bool]$hasSpec
        has_git         = [bool]$hasGit
        owner           = $normOwner
        total_modified  = $modifiedFiles.Count
        frontend_count  = $feFiles.Count
        backend_count   = $beFiles.Count
        modified_files  = $modifiedFiles.ToArray()
        spec_endpoints  = $specEndpoints.ToArray()
        ownership_rules = @($ownershipRules)
        violations      = $violations.ToArray()
        warnings        = $warnings.ToArray()
        checked_at      = (Get-Date).ToString("o")
    }

    if ($Json) {
        [PSCustomObject]$report | ConvertTo-Json -Depth 6 -Compress
    } else {
        Write-Output "=== SPEC.md CONTRACT GUARD REPORT ==="
        Write-Output "Project        : $WorkDir"
        Write-Output "SPEC.md Present: $hasSpec"
        Write-Output "Git Repository : $hasGit"
        if ($normOwner) {
            Write-Output "Checked Owner  : $normOwner"
        }
        Write-Output "Verdict        : $verdict"
        Write-Output "Modified Files : $($modifiedFiles.Count) (Frontend: $($feFiles.Count), Backend/Core: $($beFiles.Count))"
        if ($specEndpoints.Count -gt 0) {
            Write-Output "SPEC Endpoints : $($specEndpoints -join ', ')"
        }
        if ($modifiedFiles.Count -gt 0) {
            Write-Output "`n--- File Ownership Classification ---"
            foreach ($f in $modifiedFiles) {
                Write-Output ("  [{0}] {1} -> {2}" -f $f.status, $f.path, $f.owner)
            }
        }
        if ($warnings.Count -gt 0) {
            Write-Output "`n--- Warnings ---"
            foreach ($w in $warnings) {
                Write-Output "  [WARN] $w"
            }
        }
        if ($violations.Count -gt 0) {
            Write-Output "`n--- Violations ---"
            foreach ($v in $violations) {
                Write-Output "  [FAIL] $v"
            }
        }
        if ($verdict -eq "FAIL") {
            exit 1
        }
    }
} finally {
    Pop-Location
}
