param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("send-latest", "send", "new", "status", "list-active")]
    [string]$Action,

    [string]$Prompt = "",

    [string]$ConversationId = "",

    [string]$Title = "Task from Claude Leader",

    [ValidateSet("flash_lite", "flash", "pro")]
    [string]$Model = "pro"
)

$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

$agentApi = Join-Path $env:USERPROFILE ".gemini\antigravity\bin\agentapi.bat"
$brainDir = Join-Path $env:USERPROFILE ".gemini\antigravity\brain"
$presenceDir = Join-Path $env:USERPROFILE ".gemini\antigravity\presence"

if (-not (Test-Path $agentApi)) {
    Write-Error "Could not locate agentapi.bat at $agentApi"
    exit 1
}

function Get-LatestConversationId {
    if (Test-Path $presenceDir) {
        $locks = Get-ChildItem -Path $presenceDir -Filter "*.lock" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending
        if ($locks -and $locks.Count -gt 0) {
            return [System.IO.Path]::GetFileNameWithoutExtension($locks[0].Name)
        }
    }
    if (Test-Path $brainDir) {
        $dirs = Get-ChildItem -Path $brainDir -Directory -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending
        if ($dirs -and $dirs.Count -gt 0) {
            return $dirs[0].Name
        }
    }
    return $null
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
        & $agentApi new-conversation "--model=$Model" "--title=$Title" $Prompt
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
        & $agentApi send-message "--title=$Title" $ConversationId $Prompt
        Write-Output "Sent message to Antigravity conversation: $ConversationId"
    }
    "send-latest" {
        $targetId = if ($ConversationId) { $ConversationId } else { Get-LatestConversationId }
        if (-not $targetId) {
            Write-Error "No active Antigravity conversation found. Use -Action new instead."
            exit 1
        }
        if (-not $Prompt) {
            Write-Error "Prompt is required for -Action send-latest"
            exit 1
        }
        & $agentApi send-message "--title=$Title" $targetId $Prompt
        Write-Output "Sent message to latest Antigravity conversation: $targetId"
    }
    "status" {
        $targetId = if ($ConversationId) { $ConversationId } else { Get-LatestConversationId }
        if (-not $targetId) {
            Write-Error "No conversation ID found."
            exit 1
        }
        Write-Output "=== METADATA FOR $targetId ==="
        & $agentApi get-conversation-metadata $targetId

        $transcript = Join-Path $brainDir "$targetId\.system_generated\logs\transcript.jsonl"
        if (Test-Path $transcript) {
            Write-Output "`n=== LATEST ANTIGRAVITY RESPONSE ==="
            $lines = Get-Content -Path $transcript -Tail 15 -Encoding UTF8
            foreach ($line in $lines) {
                try {
                    $obj = $line | ConvertFrom-Json
                    if ($obj.type -eq "PLANNER_RESPONSE" -and $obj.content) {
                        Write-Output "[Step $($obj.step_index) - $($obj.created_at)]:"
                        Write-Output $obj.content
                    }
                } catch {}
            }
        }
    }
}
