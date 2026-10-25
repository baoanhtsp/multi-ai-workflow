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
            Block         = $false
            Reason        = ""
            PrependPrompt = ""
            Suggest       = ""
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
            Block         = $false
            Reason        = ""
            PrependPrompt = ""
            Suggest       = ""
        }
    }

    if ($null -eq $Context) {
        $Context = @{}
    }

    $prependList = [System.Collections.Generic.List[string]]::new()
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
                if ($item -is [string]) {
                    if ($item.Trim()) {
                        Write-Output $item
                    }
                    continue
                }

                $isBlock = $false
                $reason = ""
                $suggest = ""
                $prepend = ""

                if ($item -is [System.Collections.IDictionary]) {
                    if ($item.Contains("PrependPrompt") -and $null -ne $item["PrependPrompt"]) {
                        $prepend = [string]$item["PrependPrompt"]
                    }
                    if ($item.Contains("Suggest") -and $null -ne $item["Suggest"]) {
                        $suggest = ([string]$item["Suggest"]).Trim()
                    }
                    if ($item.Contains("Block") -and [bool]$item["Block"]) {
                        $isBlock = $true
                        $reason = if ($item.Contains("Reason") -and $null -ne $item["Reason"]) { [string]$item["Reason"] } else { "Blocked by hook $($hf.Name)" }
                    }
                } else {
                    if ($null -ne $item.PSObject.Properties["PrependPrompt"] -and $null -ne $item.PrependPrompt) {
                        $prepend = [string]$item.PrependPrompt
                    }
                    if ($null -ne $item.PSObject.Properties["Suggest"] -and $null -ne $item.Suggest) {
                        $suggest = ([string]$item.Suggest).Trim()
                    }
                    if ($null -ne $item.PSObject.Properties["Block"] -and [bool]$item.Block) {
                        $isBlock = $true
                        $reason = if ($null -ne $item.PSObject.Properties["Reason"] -and $null -ne $item.Reason) { [string]$item.Reason } else { "Blocked by hook $($hf.Name)" }
                    }
                }

                if ($prepend -and $prepend.Trim()) {
                    $prependList.Add($prepend.Trim())
                }

                if ($isBlock) {
                    if (-not $reason.Trim()) {
                        $reason = "Blocked by hook $($hf.Name)"
                    }
                    if (-not $suggest -and $reason -match '\bfallback=([a-z0-9-]+)\b') {
                        $fbCandidate = $Matches[1]
                        if ($fbCandidate -and $fbCandidate -ne "none") {
                            $suggest = $fbCandidate
                        }
                    }
                    return @{
                        Block         = $true
                        Reason        = $reason
                        Hook          = $hf.Name
                        PrependPrompt = ($prependList -join "`n`n")
                        Suggest       = $suggest
                    }
                }
            }
        } catch {
            Write-Output "[MAW-HOOK ERROR] ($normEvent/$($hf.Name)): $($_.Exception.Message)"
        }
    }

    return @{
        Block         = $false
        Reason        = ""
        PrependPrompt = ($prependList -join "`n`n")
        Suggest       = ""
    }
}
