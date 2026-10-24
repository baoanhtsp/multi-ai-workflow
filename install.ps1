# =============================================================================
# Multi-AI Coding Workflow Installer (Antigravity + Claude Code + OpenAI Codex)
# =============================================================================
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Installing Multi-AI Workflow (Antigravity + Claude + Codex)" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

$repoRoot = $PSScriptRoot
$geminiDir = Join-Path $env:USERPROFILE ".gemini"
$geminiConfigDir = Join-Path $geminiDir "config"
$geminiRulesDir = Join-Path $geminiConfigDir "rules"
$geminiSkillDir = Join-Path $geminiConfigDir "skills\claude-leader"
$geminiScriptsDir = Join-Path $geminiSkillDir "scripts"

$claudeDir = Join-Path $env:USERPROFILE ".claude"
$claudeCommandsDir = Join-Path $claudeDir "commands"

# 1. Create target directories
New-Item -ItemType Directory -Force -Path $geminiRulesDir | Out-Null
New-Item -ItemType Directory -Force -Path $geminiScriptsDir | Out-Null
New-Item -ItemType Directory -Force -Path $claudeCommandsDir | Out-Null

# 2. Helper to replace hardcoded C:\Users\Admin with current user's $env:USERPROFILE
function Copy-WithUserPath([string]$src, [string]$dest) {
    $content = Get-Content -Path $src -Raw -Encoding UTF8
    $content = $content.Replace("C:\Users\Admin", $env:USERPROFILE)
    Set-Content -Path $dest -Value $content -Encoding UTF8
}

# 3. Install Antigravity Global Rules & Skills
Copy-WithUserPath "$repoRoot\antigravity\rules\claude-leader-workflow.md" "$geminiRulesDir\claude-leader-workflow.md"

$ruleBody = (Get-Content -Path "$repoRoot\antigravity\rules\claude-leader-workflow.md" -Raw -Encoding UTF8) -replace "(?s)^---.*?---\s*", ""
$ruleBody = $ruleBody.Replace("C:\Users\Admin", $env:USERPROFILE)
Set-Content -Path "$geminiConfigDir\GEMINI.md" -Value $ruleBody -Encoding UTF8
Set-Content -Path "$geminiDir\GEMINI.md" -Value $ruleBody -Encoding UTF8

Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\SKILL.md" "$geminiSkillDir\SKILL.md"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\invoke-claude.ps1" "$geminiScriptsDir\invoke-claude.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\invoke-codex.ps1" "$geminiScriptsDir\invoke-codex.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\invoke-antigravity.ps1" "$geminiScriptsDir\invoke-antigravity.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\save-agentapi-env.ps1" "$geminiScriptsDir\save-agentapi-env.ps1"

# 4. Install Claude Code Global Memory & Slash Command (/antigravity)
Copy-WithUserPath "$repoRoot\claude\CLAUDE.md" "$claudeDir\CLAUDE.md"
Copy-WithUserPath "$repoRoot\claude\commands\antigravity.md" "$claudeCommandsDir\antigravity.md"

Write-Host "`n[OK] Installed Antigravity Global Rules -> $geminiRulesDir\claude-leader-workflow.md" -ForegroundColor Green
Write-Host "[OK] Installed Antigravity Skill (/claude-leader) -> $geminiSkillDir\SKILL.md" -ForegroundColor Green
Write-Host "[OK] Installed Orchestration Scripts -> $geminiScriptsDir\" -ForegroundColor Green
Write-Host "[OK] Installed Claude Code Memory & (/antigravity) -> $claudeDir\" -ForegroundColor Green
Write-Host "`nDone! Restart or open a new conversation in Antigravity / Claude Code to use." -ForegroundColor Yellow
