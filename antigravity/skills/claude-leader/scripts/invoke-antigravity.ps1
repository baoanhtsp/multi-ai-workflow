param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("send-latest", "send", "new", "status", "list-active", "wait")]
    [string]$Action,

    [string]$Prompt = "",

    [string]$PromptFile = "",

    [string]$ConversationId = "",

    [string]$ProjectId = "",

    [string]$WorkDir = "",

    [string]$Title = "Task from Claude Leader",

    [ValidateSet("flash_lite", "flash", "pro")]
    [string]$Model = "pro",

    [switch]$Wait,

    [switch]$NoWait,

    [int]$TimeoutSeconds = 600,

    [int]$QuietSeconds = 20
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

. (Join-Path $PSScriptRoot "lib\maw-common.ps1")

$agentApi = Join-Path $env:USERPROFILE ".gemini\antigravity\bin\agentapi.bat"
$brainDir = Join-Path $env:USERPROFILE ".gemini\antigravity\brain"
$presenceDir = Join-Path $env:USERPROFILE ".gemini\antigravity\presence"
$bridgeFile = Join-Path $env:USERPROFILE ".gemini\antigravity\agentapi-bridge.json"

# Load PromptFile if provided
if ($PromptFile) {
    if (-not (Test-Path -LiteralPath $PromptFile)) {
        Write-Error "PromptFile not found: $PromptFile"
        exit 1
    }
    $fileContent = Get-Content -LiteralPath $PromptFile -Raw -Encoding UTF8
    if ($Prompt) {
        $Prompt = "$Prompt`n`n$fileContent"
    } else {
        $Prompt = $fileContent
    }
}

# Cap prompt at 30000 chars (Windows CreateProcess command-line limit is 32767)
if ($Prompt -and $Prompt.Length -gt 30000) {
    $truncatedChars = $Prompt.Length - 30000
    $Prompt = $Prompt.Substring(0, 30000) + "`n`n[...truncated $truncatedChars chars by invoke-antigravity...]"
}

# 1. Zero-Config Live Self-Healing Bridge
if (Test-Path -LiteralPath $bridgeFile) {
    try {
        $bridgeData = Get-Content -LiteralPath $bridgeFile -Raw -Encoding UTF8 | ConvertFrom-Json
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
        $lsProc = Get-CimInstance Win32_Process -Filter "Name LIKE 'language_server%.exe'" -ErrorAction SilentlyContinue |
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
                if (-not (Test-Path -LiteralPath $bridgeDir)) {
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

# Resolve real native language_server.exe binary so prompts never pass through cmd.exe
$agentApiExe = $null
if (Test-Path -LiteralPath $agentApi) {
    $batRaw = Get-Content -LiteralPath $agentApi -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($batRaw -match '"([^"]+\.exe)"') {
        $candidateExe = $Matches[1]
        if (Test-Path -LiteralPath $candidateExe) {
            $agentApiExe = $candidateExe
        }
    }
}
if (-not $agentApiExe -and $env:ANTIGRAVITY_AGENTAPI_EXE -and (Test-Path -LiteralPath $env:ANTIGRAVITY_AGENTAPI_EXE)) {
    $agentApiExe = $env:ANTIGRAVITY_AGENTAPI_EXE
}

function Invoke-AgentApi {
    param(
        [Parameter(Mandatory=$true)]
        [string[]]$SubArgs,

        [switch]$AllowBatFallback
    )

    if ($agentApiExe) {
        $fullArgs = @("agentapi") + $SubArgs
        return Invoke-NativeProcess -FilePath $agentApiExe -ArgumentList $fullArgs
    }

    if ($AllowBatFallback -and (Test-Path -LiteralPath $agentApi)) {
        return Invoke-NativeProcess -FilePath $agentApi -ArgumentList $SubArgs
    }

    Write-Output "ERROR: Could not locate native language_server.exe binary (parsed from $agentApi or ANTIGRAVITY_AGENTAPI_EXE)."
    exit 1
}

function Assert-AgentApiSuccess {
    param(
        [Parameter(Mandatory=$true)]
        [hashtable]$Result,

        [string]$Context = "agentapi"
    )

    $combined = (($Result.StdOut, $Result.StdErr) | Where-Object { $_ -and $_.Trim() }) -join "`n"
    $trimmed = $combined.Trim()

    if ($trimmed) {
        try {
            $parsed = $trimmed | ConvertFrom-Json -ErrorAction Stop
            if ($null -ne $parsed.error -and ([string]$parsed.error).Trim() -ne "") {
                Write-Output $trimmed
                Write-Error "[$Context] agentapi returned error: $($parsed.error)"
                exit 1
            }
        } catch {
            if ($trimmed -match '"error"\s*:\s*"([^"]+)"') {
                Write-Output $trimmed
                Write-Error "[$Context] agentapi returned error: $($Matches[1])"
                exit 1
            }
        }
    }

    if ($Result.ExitCode -ne 0) {
        if ($trimmed) { Write-Output $trimmed }
        Write-Error "[$Context] agentapi exited with code $($Result.ExitCode)"
        exit 1
    }

    return $trimmed
}

function Normalize-WorkspacePath([string]$rawPath) {
    return Normalize-MawWorkspacePath -RawPath $rawPath
}

function Get-CandidateConversationIds {
    $candidates = New-Object System.Collections.Generic.List[string]
    if (Test-Path -LiteralPath $presenceDir) {
        $locks = Get-ChildItem -LiteralPath $presenceDir -Filter "*.lock" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending
        foreach ($l in $locks) {
            $cid = [System.IO.Path]::GetFileNameWithoutExtension($l.Name)
            if ($cid -and -not $candidates.Contains($cid)) {
                $candidates.Add($cid)
            }
        }
    }
    if (Test-Path -LiteralPath $brainDir) {
        $dirs = Get-ChildItem -LiteralPath $brainDir -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 12
        foreach ($d in $dirs) {
            if ($d.Name -and -not $d.Name.StartsWith(".") -and -not $candidates.Contains($d.Name)) {
                $candidates.Add($d.Name)
            }
        }
    }
    return $candidates.ToArray()
}

function Resolve-EffectiveProjectId {
    if ($ProjectId -and $ProjectId.Trim()) {
        return $ProjectId.Trim()
    }
    if ($env:ANTIGRAVITY_PROJECT_ID -and $env:ANTIGRAVITY_PROJECT_ID.Trim()) {
        return $env:ANTIGRAVITY_PROJECT_ID.Trim()
    }

    $candidates = @(Get-CandidateConversationIds)
    if ($candidates.Count -eq 0) {
        return ""
    }

    $metaJsons = New-Object System.Collections.Generic.List[string]
    foreach ($cid in $candidates) {
        try {
            $metaRes = Invoke-AgentApi -SubArgs @("get-conversation-metadata", $cid) -AllowBatFallback
            if ($metaRes.StdOut -and $metaRes.StdOut.Trim()) {
                $metaJsons.Add($metaRes.StdOut.Trim())
            }
        } catch {}
    }

    if ($metaJsons.Count -eq 0) {
        return ""
    }

    $resolved = Resolve-AntigravityProjectIdFromMetas -WorkDir $WorkDir -MetadataList $metaJsons.ToArray()
    if (-not $resolved) {
        $resolved = Resolve-AntigravityProjectIdFromMetas -WorkDir "" -MetadataList $metaJsons.ToArray()
    }
    return $resolved
}

# 2. Workspace-Aware Target Conversation Discovery
function Get-TargetConversationId {
    if ($ConversationId -and $ConversationId.Trim()) {
        return $ConversationId.Trim()
    }

    $candidates = @(Get-CandidateConversationIds)
    if ($candidates.Count -eq 0) {
        return $null
    }

    if ($WorkDir) {
        $normWorkDir = Normalize-WorkspacePath $WorkDir
        $mainWt = Resolve-GitMainWorktreePath -WorkDir $WorkDir
        $normMainRepo = Normalize-WorkspacePath $mainWt
        foreach ($cid in $candidates) {
            try {
                $metaRes = Invoke-AgentApi -SubArgs @("get-conversation-metadata", $cid) -AllowBatFallback
                $metaRaw = $metaRes.StdOut
                if ($metaRaw) {
                    $metaObj = $metaRaw | ConvertFrom-Json
                    $meta = $metaObj.response.conversationMetadata.metadata
                    if ($meta) {
                        if ($meta.workspaces) {
                            foreach ($ws in $meta.workspaces) {
                                $wsFolder = Normalize-WorkspacePath $ws.workspaceFolderAbsoluteUri
                                $gitRoot  = Normalize-WorkspacePath $ws.gitRootAbsoluteUri
                                if (($wsFolder -and ($wsFolder -eq $normWorkDir -or ($normMainRepo -and $wsFolder -eq $normMainRepo))) -or
                                    ($gitRoot -and ($gitRoot -eq $normWorkDir -or ($normMainRepo -and $gitRoot -eq $normMainRepo)))) {
                                    return $cid
                                }
                            }
                        }
                        if ($meta.workspaceUris) {
                            foreach ($u in $meta.workspaceUris) {
                                $normUri = Normalize-WorkspacePath $u
                                if ($normUri -and ($normUri -eq $normWorkDir -or ($normMainRepo -and $normUri -eq $normMainRepo))) {
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

# 3. Untruncated Response Reader & Incremental Wait Polling (R3)
function Get-UntruncatedStepContent([psobject]$stepObj, [string]$logDir) {
    if ($null -eq $stepObj) { return "" }
    $fullContent = $stepObj.content
    if ($stepObj.truncated_fields -and ($stepObj.truncated_fields -contains "content")) {
        $fullTranscript = Join-Path $logDir "transcript_full.jsonl"
        if (Test-Path -LiteralPath $fullTranscript) {
            $targetStep = $stepObj.step_index
            foreach ($fLine in (Get-Content -LiteralPath $fullTranscript -Encoding UTF8 -ErrorAction SilentlyContinue)) {
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
    if (-not (Test-Path -LiteralPath $transcript)) {
        return -1
    }
    $state = New-TranscriptReaderState
    Update-TranscriptReaderState -State $state -TranscriptPath $transcript
    $maxIdx = -1
    foreach ($obj in $state.Steps) {
        if ($null -ne $obj.step_index -and [int]$obj.step_index -gt $maxIdx) {
            $maxIdx = [int]$obj.step_index
        }
    }
    return $maxIdx
}

function Wait-AntigravityTurn([string]$cid, [int]$initialStepIndex, [int]$timeoutSec, [int]$quietSec = 20) {
    $logDir = Join-Path $brainDir "$cid\.system_generated\logs"
    $transcript = Join-Path $logDir "transcript.jsonl"
    $readerState = New-TranscriptReaderState

    $elapsed = 0
    $lastResult = $null
    $lastLoggedStep = $initialStepIndex
    $ts = (Get-Date).ToString("HH:mm:ss")
    Write-Output "[$ts] Waiting for Antigravity IDE (Conversation: $cid, QuietWindow: ${quietSec}s)..."

    while ($elapsed -lt $timeoutSec) {
        $res = Read-TranscriptTurnIncremental -TranscriptPath $transcript -State $readerState -MinStepIndex $initialStepIndex -QuietSeconds $quietSec
        $lastResult = $res
        if ($res.Completed) {
            $fullText = Get-UntruncatedStepContent -stepObj $res.StepObj -logDir $logDir
            Write-Output "[Step $($res.StepIndex) - $($res.CreatedAt)]:"
            Write-Output $fullText
            return
        }
        if ($res.StepIndex -gt $lastLoggedStep) {
            $lastLoggedStep = $res.StepIndex
            $stepTs = (Get-Date).ToString("HH:mm:ss")
            Write-Output "[$stepTs] Antigravity executing step $($res.StepIndex)..."
        }
        Start-Sleep -Seconds 2
        $elapsed += 2
    }

    Write-Warning "Timed out after ${timeoutSec}s waiting for Antigravity conversation $cid to complete turn."
    if ($lastResult -and $lastResult.StepIndex -ge 0) {
        $partialText = Get-UntruncatedStepContent -stepObj $lastResult.StepObj -logDir $logDir
        Write-Output "[Partial Step $($lastResult.StepIndex) - $($lastResult.CreatedAt)]:"
        Write-Output $partialText
    }
    exit 124
}

switch ($Action) {
    "list-active" {
        Write-Output "=== ACTIVE LOCKS (OPEN CONVERSATIONS) ==="
        if (Test-Path -LiteralPath $presenceDir) {
            Get-ChildItem -LiteralPath $presenceDir -Filter "*.lock" -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                ForEach-Object {
                    $cid = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
                    Write-Output "ConversationId: $cid (LastActive: $($_.LastWriteTime))"
                }
        }
        Write-Output "`n=== RECENT BRAIN CONVERSATIONS ==="
        if (Test-Path -LiteralPath $brainDir) {
            Get-ChildItem -LiteralPath $brainDir -Directory -ErrorAction SilentlyContinue |
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
        $effProjectId = Resolve-EffectiveProjectId
        if ($effProjectId) {
            $env:ANTIGRAVITY_PROJECT_ID = $effProjectId
        }
        $procRes = Invoke-AgentApi -SubArgs @("new-conversation", "--model=$Model", "--title=$Title", $Prompt)
        $newOut = Assert-AgentApiSuccess -Result $procRes -Context "new-conversation"
        if ($newOut) {
            Write-Output $newOut
        }
        $newCid = $null
        if ($newOut -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') {
            $newCid = $Matches[1]
            Write-Output "CONVERSATION_ID: $newCid"
        }
        if (-not $NoWait) {
            if (-not $newCid) {
                Write-Error "new-conversation did not return a valid Conversation UUID; refusing to wait on an unrelated conversation."
                exit 1
            }
            Wait-AntigravityTurn -cid $newCid -initialStepIndex -1 -timeoutSec $TimeoutSeconds -quietSec $QuietSeconds
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
        $procRes = Invoke-AgentApi -SubArgs @("send-message", "--title=$Title", $ConversationId, $Prompt)
        $sendOut = Assert-AgentApiSuccess -Result $procRes -Context "send-message"
        if ($sendOut) {
            Write-Output $sendOut
        }
        Write-Output "Sent message to Antigravity conversation: $ConversationId"
        if (-not $NoWait) {
            Wait-AntigravityTurn -cid $ConversationId -initialStepIndex $initialMaxStep -timeoutSec $TimeoutSeconds -quietSec $QuietSeconds
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
        $procRes = Invoke-AgentApi -SubArgs @("send-message", "--title=$Title", $targetId, $Prompt)
        $sendOut = Assert-AgentApiSuccess -Result $procRes -Context "send-message"
        if ($sendOut) {
            Write-Output $sendOut
        }
        Write-Output "Sent message to latest Antigravity conversation: $targetId"
        if (-not $NoWait) {
            Wait-AntigravityTurn -cid $targetId -initialStepIndex $initialMaxStep -timeoutSec $TimeoutSeconds -quietSec $QuietSeconds
        }
    }
    "wait" {
        $targetId = Get-TargetConversationId
        if (-not $targetId) {
            Write-Error "No conversation ID found to wait on."
            exit 1
        }
        Wait-AntigravityTurn -cid $targetId -initialStepIndex -1 -timeoutSec $TimeoutSeconds -quietSec $QuietSeconds
    }
    "status" {
        $targetId = Get-TargetConversationId
        if (-not $targetId) {
            Write-Error "No conversation ID found."
            exit 1
        }
        Write-Output "=== METADATA FOR $targetId ==="
        $metaRes = Invoke-AgentApi -SubArgs @("get-conversation-metadata", $targetId) -AllowBatFallback
        if ($metaRes.StdOut) {
            Write-Output $metaRes.StdOut.Trim()
        }

        $logDir = Join-Path $brainDir "$targetId\.system_generated\logs"
        $transcript = Join-Path $logDir "transcript.jsonl"
        if (Test-Path -LiteralPath $transcript) {
            Write-Output "`n=== LATEST ANTIGRAVITY RESPONSE ==="
            $lines = Get-Content -LiteralPath $transcript -Tail 15 -Encoding UTF8
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
