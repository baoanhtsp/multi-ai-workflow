param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("send-latest", "send", "new", "status", "list-active", "wait")]
    [string]$Action,

    [string]$Prompt = "",

    [string]$PromptFile = "",

    [string]$ConversationId = "",

    [string]$WorkDir = "",

    [string]$Title = "Task from Claude Leader",

    [ValidateSet("flash_lite", "flash", "pro")]
    [string]$Model = "pro",

    [switch]$Wait,

    [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

$agentApi = Join-Path $env:USERPROFILE ".gemini\antigravity\bin\agentapi.bat"
$brainDir = Join-Path $env:USERPROFILE ".gemini\antigravity\brain"
$presenceDir = Join-Path $env:USERPROFILE ".gemini\antigravity\presence"
$bridgeFile = Join-Path $env:USERPROFILE ".gemini\antigravity\agentapi-bridge.json"

if (-not (Test-Path $agentApi)) {
    Write-Error "Could not locate agentapi.bat at $agentApi"
    exit 1
}

# Load PromptFile if provided
if ($PromptFile) {
    if (-not (Test-Path $PromptFile)) {
        Write-Error "PromptFile not found: $PromptFile"
        exit 1
    }
    $fileContent = Get-Content -Path $PromptFile -Raw -Encoding UTF8
    if ($Prompt) {
        $Prompt = "$Prompt`n`n$fileContent"
    } else {
        $Prompt = $fileContent
    }
}

# 1. Zero-Config Live Self-Healing Bridge
if (Test-Path $bridgeFile) {
    try {
        $bridgeData = Get-Content -Path $bridgeFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if (-not $env:ANTIGRAVITY_CSRF_TOKEN -and $bridgeData.ANTIGRAVITY_CSRF_TOKEN) {
            $env:ANTIGRAVITY_CSRF_TOKEN = $bridgeData.ANTIGRAVITY_CSRF_TOKEN
        }
        if (-not $env:ANTIGRAVITY_LS_ADDRESS -and $bridgeData.ANTIGRAVITY_LS_ADDRESS) {
            $env:ANTIGRAVITY_LS_ADDRESS = $bridgeData.ANTIGRAVITY_LS_ADDRESS
        }
        if (-not $env:ANTIGRAVITY_LS_VERSION -and $bridgeData.ANTIGRAVITY_LS_VERSION) {
            $env:ANTIGRAVITY_LS_VERSION = $bridgeData.ANTIGRAVITY_LS_VERSION
        }
        if (-not $env:ANTIGRAVITY_APP_DATA_DIR -and $bridgeData.ANTIGRAVITY_APP_DATA_DIR) {
            $env:ANTIGRAVITY_APP_DATA_DIR = $bridgeData.ANTIGRAVITY_APP_DATA_DIR
        }
        if (-not $env:ANTIGRAVITY_AGENTAPI_EXE -and $bridgeData.ANTIGRAVITY_AGENTAPI_EXE) {
            $env:ANTIGRAVITY_AGENTAPI_EXE = $bridgeData.ANTIGRAVITY_AGENTAPI_EXE
        }
        if (-not $env:ANTIGRAVITY_AGENT) {
            $env:ANTIGRAVITY_AGENT = "1"
        }
    } catch {
        Write-Warning "Failed to parse $bridgeFile : $_"
    }
}

$isListening = $false
if ($env:ANTIGRAVITY_LS_ADDRESS -match ':(\d+)$') {
    $port = [int]$Matches[1]
    $isListening = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

if (-not $env:ANTIGRAVITY_CSRF_TOKEN -or -not $env:ANTIGRAVITY_LS_ADDRESS -or -not $isListening) {
    try {
        $lsProc = Get-CimInstance Win32_Process -Filter "Name = 'language_server.exe'" -ErrorAction SilentlyContinue |
            Sort-Object CreationDate -Descending |
            Select-Object -First 1
        if ($lsProc -and $lsProc.CommandLine -match '--csrf_token\s+([^\s"]+)') {
            $csrf = $Matches[1]
            $ports = @(Get-NetTCPConnection -OwningProcess $lsProc.ProcessId -State Listen -ErrorAction SilentlyContinue |
                Select-Object -ExpandProperty LocalPort |
                Sort-Object -Descending -Unique)
            if ($ports.Count -gt 0) {
                $env:ANTIGRAVITY_CSRF_TOKEN = $csrf
                $env:ANTIGRAVITY_LS_ADDRESS = "localhost:$($ports[0])"
                $env:ANTIGRAVITY_AGENT = "1"
                if (-not $env:ANTIGRAVITY_APP_DATA_DIR) {
                    $env:ANTIGRAVITY_APP_DATA_DIR = (Join-Path $env:USERPROFILE ".gemini\antigravity").Replace('\', '/')
                }
                if (-not $env:ANTIGRAVITY_AGENTAPI_EXE -and $lsProc.ExecutablePath) {
                    $env:ANTIGRAVITY_AGENTAPI_EXE = $lsProc.ExecutablePath
                }

                $bridgeDir = Split-Path -Parent $bridgeFile
                if (-not (Test-Path $bridgeDir)) {
                    New-Item -ItemType Directory -Path $bridgeDir -Force | Out-Null
                }
                @{
                    ANTIGRAVITY_AGENT        = $env:ANTIGRAVITY_AGENT
                    ANTIGRAVITY_AGENTAPI_EXE = $env:ANTIGRAVITY_AGENTAPI_EXE
                    ANTIGRAVITY_APP_DATA_DIR = $env:ANTIGRAVITY_APP_DATA_DIR
                    ANTIGRAVITY_CSRF_TOKEN   = $env:ANTIGRAVITY_CSRF_TOKEN
                    ANTIGRAVITY_LS_ADDRESS   = $env:ANTIGRAVITY_LS_ADDRESS
                    ANTIGRAVITY_LS_VERSION   = $env:ANTIGRAVITY_LS_VERSION
                    UpdatedAt                = (Get-Date).ToString("o")
                } | ConvertTo-Json | Set-Content -Path $bridgeFile -Encoding UTF8 -ErrorAction SilentlyContinue
            }
        }
    } catch {
        Write-Warning "Auto-discovery of language_server.exe failed: $_"
    }
}

function Normalize-WorkspacePath([string]$rawPath) {
    if (-not $rawPath) { return "" }
    $decoded = [uri]::UnescapeDataString($rawPath)
    $clean = $decoded -replace '^file:///', ''
    return $clean.Replace('\', '/').TrimEnd('/').ToLowerInvariant()
}

# 2. Workspace-Aware Target Conversation Discovery
function Get-TargetConversationId {
    if ($ConversationId) {
        return $ConversationId
    }

    $candidates = New-Object System.Collections.Generic.List[string]
    if (Test-Path $presenceDir) {
        $locks = Get-ChildItem -Path $presenceDir -Filter "*.lock" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending
        foreach ($l in $locks) {
            $cid = [System.IO.Path]::GetFileNameWithoutExtension($l.Name)
            if ($cid -and -not $candidates.Contains($cid)) {
                $candidates.Add($cid)
            }
        }
    }
    if (Test-Path $brainDir) {
        $dirs = Get-ChildItem -Path $brainDir -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 10
        foreach ($d in $dirs) {
            if ($d.Name -and -not $candidates.Contains($d.Name)) {
                $candidates.Add($d.Name)
            }
        }
    }

    if ($candidates.Count -eq 0) {
        return $null
    }

    if ($WorkDir) {
        $normWorkDir = Normalize-WorkspacePath $WorkDir
        foreach ($cid in $candidates) {
            try {
                $metaRaw = (& $agentApi get-conversation-metadata $cid 2>$null) -join "`n"
                if ($metaRaw) {
                    $metaObj = $metaRaw | ConvertFrom-Json
                    $meta = $metaObj.response.conversationMetadata.metadata
                    if ($meta) {
                        if ($meta.workspaces) {
                            foreach ($ws in $meta.workspaces) {
                                $wsFolder = Normalize-WorkspacePath $ws.workspaceFolderAbsoluteUri
                                $gitRoot  = Normalize-WorkspacePath $ws.gitRootAbsoluteUri
                                if (($wsFolder -and $wsFolder -eq $normWorkDir) -or ($gitRoot -and $gitRoot -eq $normWorkDir)) {
                                    return $cid
                                }
                            }
                        }
                        if ($meta.workspaceUris) {
                            foreach ($u in $meta.workspaceUris) {
                                $normUri = Normalize-WorkspacePath $u
                                if ($normUri -and $normUri -eq $normWorkDir) {
                                    return $cid
                                }
                            }
                        }
                    }
                }
            } catch {}
        }
    }

    return $candidates[0]
}

# 3. Untruncated Response Reader & Wait Polling
function Get-UntruncatedStepContent([psobject]$stepObj, [string]$logDir) {
    $fullContent = $stepObj.content
    if ($stepObj.truncated_fields -and ($stepObj.truncated_fields -contains "content")) {
        $fullTranscript = Join-Path $logDir "transcript_full.jsonl"
        if (Test-Path $fullTranscript) {
            $targetStep = $stepObj.step_index
            foreach ($fLine in (Get-Content -Path $fullTranscript -Encoding UTF8 -ErrorAction SilentlyContinue)) {
                try {
                    $fObj = $fLine | ConvertFrom-Json
                    if ($fObj.step_index -eq $targetStep -and $fObj.content) {
                        return $fObj.content
                    }
                } catch {}
            }
        }
    }
    return $fullContent
}

function Get-MaxStepIndex([string]$cid) {
    $transcript = Join-Path $brainDir "$cid\.system_generated\logs\transcript.jsonl"
    if (-not (Test-Path $transcript)) {
        return -1
    }
    $maxIdx = -1
    foreach ($line in (Get-Content -Path $transcript -Encoding UTF8 -ErrorAction SilentlyContinue)) {
        try {
            $obj = $line | ConvertFrom-Json
            if ($null -ne $obj.step_index -and [int]$obj.step_index -gt $maxIdx) {
                $maxIdx = [int]$obj.step_index
            }
        } catch {}
    }
    return $maxIdx
}

function Get-ConversationTurnResponse([string]$cid, [int]$minStepIndex = -1) {
    $logDir = Join-Path $brainDir "$cid\.system_generated\logs"
    $transcript = Join-Path $logDir "transcript.jsonl"
    if (-not (Test-Path $transcript)) {
        return [PSCustomObject]@{
            Completed = $false
            StepIndex = -1
            CreatedAt = ""
            Content   = ""
        }
    }

    $latestCompleted = $null
    $latestPartial   = $null

    foreach ($line in (Get-Content -Path $transcript -Encoding UTF8 -ErrorAction SilentlyContinue)) {
        try {
            $obj = $line | ConvertFrom-Json
            if ([int]$obj.step_index -gt $minStepIndex) {
                if ($obj.type -eq "USER_INPUT") {
                    $latestCompleted = $null
                    $latestPartial   = $null
                } elseif ($obj.type -eq "PLANNER_RESPONSE") {
                    $hasToolCalls = ($null -ne $obj.tool_calls -and @($obj.tool_calls).Count -gt 0)
                    if ($obj.status -eq "DONE" -and -not $hasToolCalls -and $obj.content) {
                        $latestCompleted = $obj
                    } else {
                        $latestCompleted = $null
                        $latestPartial   = $obj
                    }
                }
            }
        } catch {}
    }

    if ($null -ne $latestCompleted) {
        $fullContent = Get-UntruncatedStepContent -stepObj $latestCompleted -logDir $logDir
        return [PSCustomObject]@{
            Completed = $true
            StepIndex = $latestCompleted.step_index
            CreatedAt = $latestCompleted.created_at
            Content   = $fullContent
        }
    }

    if ($null -ne $latestPartial) {
        $partialContent = Get-UntruncatedStepContent -stepObj $latestPartial -logDir $logDir
        return [PSCustomObject]@{
            Completed = $false
            StepIndex = $latestPartial.step_index
            CreatedAt = $latestPartial.created_at
            Content   = $partialContent
        }
    }

    return [PSCustomObject]@{
        Completed = $false
        StepIndex = -1
        CreatedAt = ""
        Content   = ""
    }
}

function Wait-AntigravityTurn([string]$cid, [int]$initialStepIndex, [int]$timeoutSec) {
    $elapsed = 0
    $lastResult = $null
    while ($elapsed -lt $timeoutSec) {
        $res = Get-ConversationTurnResponse -cid $cid -minStepIndex $initialStepIndex
        $lastResult = $res
        if ($res.Completed) {
            Write-Output "[Step $($res.StepIndex) - $($res.CreatedAt)]:"
            Write-Output $res.Content
            return
        }
        Start-Sleep -Seconds 2
        $elapsed += 2
    }

    Write-Warning "Timed out after ${timeoutSec}s waiting for Antigravity conversation $cid to complete turn."
    if ($lastResult -and $lastResult.StepIndex -ge 0) {
        Write-Output "[Partial Step $($lastResult.StepIndex) - $($lastResult.CreatedAt)]:"
        Write-Output $lastResult.Content
    }
}

switch ($Action) {
    "list-active" {
        Write-Output "=== ACTIVE LOCKS (OPEN CONVERSATIONS) ==="
        if (Test-Path $presenceDir) {
            Get-ChildItem -Path $presenceDir -Filter "*.lock" -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                ForEach-Object {
                    $cid = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
                    Write-Output "ConversationId: $cid (LastActive: $($_.LastWriteTime))"
                }
        }
        Write-Output "`n=== RECENT BRAIN CONVERSATIONS ==="
        if (Test-Path $brainDir) {
            Get-ChildItem -Path $brainDir -Directory -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 5 |
                ForEach-Object {
                    Write-Output "ConversationId: $($_.Name) (Updated: $($_.LastWriteTime))"
                }
        }
    }
    "new" {
        if (-not $Prompt) {
            Write-Error "Prompt is required for -Action new"
            exit 1
        }
        $newOut = (& $agentApi new-conversation "--model=$Model" "--title=$Title" $Prompt) -join "`n"
        Write-Output $newOut
        if ($Wait) {
            $newCid = $null
            if ($newOut -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') {
                $newCid = $Matches[1]
            } else {
                Start-Sleep -Seconds 2
                $newCid = Get-TargetConversationId
            }
            if ($newCid) {
                Wait-AntigravityTurn -cid $newCid -initialStepIndex -1 -timeoutSec $TimeoutSeconds
            }
        }
    }
    "send" {
        if (-not $ConversationId) {
            Write-Error "ConversationId is required for -Action send"
            exit 1
        }
        if (-not $Prompt) {
            Write-Error "Prompt is required for -Action send"
            exit 1
        }
        $initialMaxStep = Get-MaxStepIndex -cid $ConversationId
        & $agentApi send-message "--title=$Title" $ConversationId $Prompt
        Write-Output "Sent message to Antigravity conversation: $ConversationId"
        if ($Wait) {
            Wait-AntigravityTurn -cid $ConversationId -initialStepIndex $initialMaxStep -timeoutSec $TimeoutSeconds
        }
    }
    "send-latest" {
        $targetId = Get-TargetConversationId
        if (-not $targetId) {
            Write-Error "No active Antigravity conversation found. Use -Action new instead."
            exit 1
        }
        if (-not $Prompt) {
            Write-Error "Prompt is required for -Action send-latest"
            exit 1
        }
        $initialMaxStep = Get-MaxStepIndex -cid $targetId
        & $agentApi send-message "--title=$Title" $targetId $Prompt
        Write-Output "Sent message to latest Antigravity conversation: $targetId"
        if ($Wait) {
            Wait-AntigravityTurn -cid $targetId -initialStepIndex $initialMaxStep -timeoutSec $TimeoutSeconds
        }
    }
    "wait" {
        $targetId = Get-TargetConversationId
        if (-not $targetId) {
            Write-Error "No conversation ID found to wait on."
            exit 1
        }
        Wait-AntigravityTurn -cid $targetId -initialStepIndex -1 -timeoutSec $TimeoutSeconds
    }
    "status" {
        $targetId = Get-TargetConversationId
        if (-not $targetId) {
            Write-Error "No conversation ID found."
            exit 1
        }
        Write-Output "=== METADATA FOR $targetId ==="
        & $agentApi get-conversation-metadata $targetId

        $logDir = Join-Path $brainDir "$targetId\.system_generated\logs"
        $transcript = Join-Path $logDir "transcript.jsonl"
        if (Test-Path $transcript) {
            Write-Output "`n=== LATEST ANTIGRAVITY RESPONSE ==="
            $lines = Get-Content -Path $transcript -Tail 15 -Encoding UTF8
            foreach ($line in $lines) {
                try {
                    $obj = $line | ConvertFrom-Json
                    if ($obj.type -eq "PLANNER_RESPONSE" -and $obj.content) {
                        $fullContent = Get-UntruncatedStepContent -stepObj $obj -logDir $logDir
                        Write-Output "[Step $($obj.step_index) - $($obj.created_at)]:"
                        Write-Output $fullContent
                    }
                } catch {}
            }
        }
    }
}
