param(
    [Parameter(Mandatory=$false)]
    [string]$Title = "Multi-AI Mission Control",

    [Parameter(Mandatory=$true)]
    [string]$Message,

    [Parameter(Mandatory=$false)]
    [ValidateSet("info", "success", "warn", "error")]
    [string]$Status = "info",

    [Parameter(Mandatory=$false)]
    [switch]$TestOnly
)

$ErrorActionPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$configPath = Join-Path $env:USERPROFILE ".gemini\antigravity\notify-config.json"
$cfg = @{
    desktop_toast = $true
    webhook_url   = ""
    telegram_bot_token = ""
    telegram_chat_id   = ""
}

if (Test-Path $configPath) {
    try {
        $loaded = Get-Content -Path $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $loaded.desktop_toast) { $cfg.desktop_toast = [bool]$loaded.desktop_toast }
        if ($loaded.webhook_url) { $cfg.webhook_url = [string]$loaded.webhook_url }
        if ($loaded.telegram_bot_token) { $cfg.telegram_bot_token = [string]$loaded.telegram_bot_token }
        if ($loaded.telegram_chat_id) { $cfg.telegram_chat_id = [string]$loaded.telegram_chat_id }
    } catch {}
}

$results = @{
    desktop_sent  = $false
    webhook_sent  = $false
    telegram_sent = $false
}

# 1. Windows 10/11 Native Toast Notification (with WScript.Shell Popup / Balloon fallback)
if ($cfg.desktop_toast) {
    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

        $safeTitle = [System.Security.SecurityElement]::Escape($Title)
        $safeMsg   = [System.Security.SecurityElement]::Escape($Message)
        $xmlStr = @"
<toast>
    <visual>
        <binding template="ToastGeneric">
            <text>$safeTitle</text>
            <text>$safeMsg</text>
        </binding>
    </visual>
</toast>
"@
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml($xmlStr)
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Windows PowerShell")
        $notifier.Show($toast)
        $results.desktop_sent = $true
    } catch {
        try {
            Add-Type -AssemblyName System.Windows.Forms
            $notify = New-Object System.Windows.Forms.NotifyIcon
            $notify.Icon = [System.Drawing.SystemIcons]::Information
            $notify.BalloonTipTitle = $Title
            $notify.BalloonTipText = $Message
            $notify.Visible = $true
            $notify.ShowBalloonTip(4000)
            Start-Sleep -Milliseconds 500
            $notify.Dispose()
            $results.desktop_sent = $true
        } catch {}
    }
}

# 2. Discord / Slack / Generic JSON Webhook
if ($cfg.webhook_url -and $cfg.webhook_url.StartsWith("http")) {
    try {
        $payload = @{
            content  = "**[$Title]** ($Status)`n$Message"
            username = "Multi-AI Mission Control"
            text     = "[$Title] $Message"
        } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $cfg.webhook_url -Method Post -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 5 | Out-Null
        $results.webhook_sent = $true
    } catch {}
}

# 3. Telegram Bot API
if ($cfg.telegram_bot_token -and $cfg.telegram_chat_id) {
    try {
        $tgUrl = "https://api.telegram.org/bot$($cfg.telegram_bot_token)/sendMessage"
        $tgBody = @{
            chat_id    = $cfg.telegram_chat_id
            text       = "🚀 *$( $Title )*%0A$( $Message )"
            parse_mode = "Markdown"
        } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri $tgUrl -Method Post -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($tgBody)) -TimeoutSec 5 | Out-Null
        $results.telegram_sent = $true
    } catch {}
}

$results | ConvertTo-Json -Compress
