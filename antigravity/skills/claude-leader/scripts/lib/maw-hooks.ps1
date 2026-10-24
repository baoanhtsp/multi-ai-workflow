# Script Hook Runner for Multi-AI Workflow (SPEC §9.0, Windows PowerShell 5.1 compatible)

function Invoke-MawHooks {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Event,

        [Parameter(Mandatory=$false)]
        [hashtable]$Context = @{},

        [Parameter(Mandatory=$false)]
        [string]$HooksRoot = ""
    )

    $normEvent = if ($Event) { $Event.Trim().ToLowerInvariant() } else { "" }
    if (-not $normEvent -or $normEvent -notmatch '^[a-z0-9-]+$') {
        return @{
            Block  = $false
            Reason = ""
        }
    }

    if (-not $HooksRoot) {
        if ($env:MAW_HOOKS_DIR -and $env:MAW_HOOKS_DIR.Trim()) {
            $HooksRoot = $env:MAW_HOOKS_DIR.Trim()
        } else {
            $scriptsDir = Split-Path -Parent $PSScriptRoot
            $HooksRoot = Join-Path $scriptsDir "hooks"
        }
    }

    $eventDir = Join-Path $HooksRoot $normEvent
    if (-not (Test-Path -LiteralPath $eventDir -PathType Container)) {
        return @{
            Block  = $false
            Reason = ""
        }
    }

    if ($null -eq $Context) {
        $Context = @{}
    }

    $hookFiles = @(Get-ChildItem -LiteralPath $eventDir -Filter "*.ps1" -File -ErrorAction SilentlyContinue | Sort-Object Name)
    foreach ($hf in $hookFiles) {
        try {
            $hookPath = $hf.FullName
            $results = @(
                & {
                    $ErrorActionPreference = "Stop"
                    . $hookPath
                }
            )
            foreach ($item in $results) {
                if ($null -eq $item) { continue }
                $isBlock = $false
                $reason = ""
                if ($item -is [System.Collections.IDictionary]) {
                    if ($item.Contains("Block") -and [bool]$item["Block"]) {
                        $isBlock = $true
                        $reason = if ($item.Contains("Reason") -and $null -ne $item["Reason"]) { [string]$item["Reason"] } else { "Blocked by hook $($hf.Name)" }
                    }
                } elseif ($null -ne $item.PSObject.Properties["Block"] -and [bool]$item.Block) {
                    $isBlock = $true
                    $reason = if ($null -ne $item.PSObject.Properties["Reason"] -and $null -ne $item.Reason) { [string]$item.Reason } else { "Blocked by hook $($hf.Name)" }
                }
                if ($isBlock) {
                    if (-not $reason.Trim()) {
                        $reason = "Blocked by hook $($hf.Name)"
                    }
                    return @{
                        Block  = $true
                        Reason = $reason
                        Hook   = $hf.Name
                    }
                }
            }
        } catch {
            Write-Output "[MAW-HOOK ERROR] ($normEvent/$($hf.Name)): $($_.Exception.Message)"
        }
    }

    return @{
        Block  = $false
        Reason = ""
    }
}
