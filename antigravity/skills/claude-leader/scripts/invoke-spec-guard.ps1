param(
    [Parameter(Mandatory=$true)]
    [string]$WorkDir,

    [Parameter(Mandatory=$false)]
    [switch]$Json
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Test-Path $WorkDir)) {
    $err = @{ ok = $false; error = "WorkDir does not exist: $WorkDir" }
    if ($Json) { $err | ConvertTo-Json -Compress; exit 1 }
    Write-Error $err.error
    exit 1
}

Push-Location $WorkDir
try {
    $specPath = Join-Path $WorkDir "SPEC.md"
    $hasSpec = Test-Path $specPath

    # 1. Collect modified & untracked files via git status --porcelain
    $gitStatusLines = @(git status --porcelain 2>$null)
    $modifiedFiles = @()
    foreach ($line in $gitStatusLines) {
        if ($line -and $line.Length -gt 3) {
            $statusFlag = $line.Substring(0, 2).Trim()
            $relPath = $line.Substring(3).Trim().Trim('"')
            if ($relPath -match ' -> ') {
                $relPath = ($relPath -split ' -> ')[-1].Trim()
            }
            $ext = [System.IO.Path]::GetExtension($relPath).ToLowerInvariant()
            $isFrontend = $ext -in @('.html', '.htm', '.css', '.scss', '.sass', '.less', '.jsx', '.tsx', '.vue', '.svelte') -or
                          $relPath -match '\.blade\.php$' -or
                          $relPath -match '\.ejs$' -or
                          ($relPath -match '^(frontend|client|public|resources/views|dashboard)/.*\.(js|ts)$')
            $owner = if ($isFrontend) { "Claude Code (Frontend)" } elseif ($relPath -match 'test|spec' -and $relPath -notmatch '^SPEC\.md$') { "Antigravity / Codex (Tests)" } else { "Antigravity (Backend/Core)" }
            $modifiedFiles += [PSCustomObject]@{
                path        = $relPath
                status      = $statusFlag
                category    = if ($isFrontend) { "frontend" } else { "backend" }
                owner       = $owner
            }
        }
    }

    # 2. Parse SPEC.md for Ownership rules & API Endpoints
    $specEndpoints = @()
    $specOwnershipRules = @()
    $violations = @()

    if ($hasSpec) {
        $specContent = Get-Content -Path $specPath -Raw -Encoding UTF8
        # Extract endpoints like GET /api..., POST ?action=...
        $epMatches = [regex]::Matches($specContent, '\b(GET|POST|PUT|PATCH|DELETE)\s+([/`?][^\s|`"]+)')
        foreach ($m in $epMatches) {
            $ep = ($m.Groups[1].Value + " " + $m.Groups[2].Value).Trim()
            if ($ep -notin $specEndpoints) {
                $specEndpoints += $ep
            }
        }

        # Check if SPEC.md still has unfilled template placeholders in the title header
        if ($specContent -match '(?m)^#.*<Project / Feature Name>') {
            $violations += "SPEC.md still contains unfilled template placeholders."
        }
    } else {
        $violations += "SPEC.md is missing in project root. Run 'Init SPEC.md' before multi-AI execution."
    }

    $feFiles = @($modifiedFiles | Where-Object { $_.category -eq "frontend" })
    $beFiles = @($modifiedFiles | Where-Object { $_.category -eq "backend" })

    $verdict = if ($violations.Count -eq 0) { "PASS" } else { "WARN" }

    $report = [PSCustomObject]@{
        ok               = $true
        work_dir         = $WorkDir
        has_spec         = $hasSpec
        verdict          = $verdict
        total_modified   = $modifiedFiles.Count
        frontend_count   = $feFiles.Count
        backend_count    = $beFiles.Count
        modified_files   = $modifiedFiles
        spec_endpoints   = $specEndpoints
        violations       = $violations
        checked_at       = (Get-Date).ToString("o")
    }

    if ($Json) {
        $report | ConvertTo-Json -Depth 5 -Compress
    } else {
        Write-Output "=== SPEC.md CONTRACT GUARD REPORT ==="
        Write-Output "Project        : $WorkDir"
        Write-Output "SPEC.md Present: $hasSpec"
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
        if ($violations.Count -gt 0) {
            Write-Output "`n--- Warnings / Violations ---"
            foreach ($v in $violations) {
                Write-Output "  [!] $v"
            }
        }
    }
} finally {
    Pop-Location
}
