# =============================================================================
# Multi-AI Coding Workflow Installer (Antigravity + Claude Code + OpenAI Codex)
# =============================================================================
$ErrorActionPreference = "Stop"
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Installing Multi-AI Workflow (Antigravity + Claude + Codex)" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan

$repoRoot = $PSScriptRoot
$geminiDir = Join-Path $env:USERPROFILE ".gemini"
$geminiConfigDir = Join-Path $geminiDir "config"
$geminiRulesDir = Join-Path $geminiConfigDir "rules"
$geminiSkillDir = Join-Path $geminiConfigDir "skills\claude-leader"
$geminiMultiAiSkillDir = Join-Path $geminiConfigDir "skills\multi-ai"
$geminiScriptsDir = Join-Path $geminiSkillDir "scripts"
$geminiScriptsLibDir = Join-Path $geminiScriptsDir "lib"
$geminiTemplatesDir = Join-Path $geminiSkillDir "templates"
$geminiRolesTemplatesDir = Join-Path $geminiTemplatesDir "roles"

$claudeDir = Join-Path $env:USERPROFILE ".claude"
$claudeCommandsDir = Join-Path $claudeDir "commands"

$codexDir = Join-Path $env:USERPROFILE ".codex"
$codexSkillDir = Join-Path $codexDir "skills\multi-ai-leader"
$codexSkillAgentsDir = Join-Path $codexSkillDir "agents"
$codexMultiAiSkillDir = Join-Path $codexDir "skills\multi-ai"
$codexMultiAiAgentsDir = Join-Path $codexMultiAiSkillDir "agents"

# 1. Create target directories
New-Item -ItemType Directory -Force -Path $geminiRulesDir | Out-Null
New-Item -ItemType Directory -Force -Path $geminiScriptsDir | Out-Null
New-Item -ItemType Directory -Force -Path $geminiScriptsLibDir | Out-Null
New-Item -ItemType Directory -Force -Path $geminiTemplatesDir | Out-Null
New-Item -ItemType Directory -Force -Path $geminiRolesTemplatesDir | Out-Null
New-Item -ItemType Directory -Force -Path $geminiMultiAiSkillDir | Out-Null
New-Item -ItemType Directory -Force -Path $claudeCommandsDir | Out-Null
New-Item -ItemType Directory -Force -Path $codexSkillAgentsDir | Out-Null
New-Item -ItemType Directory -Force -Path $codexMultiAiAgentsDir | Out-Null

$backupTimestamp = (Get-Date).ToString("yyyyMMdd-HHmmss")

function Write-ManagedFile([string]$dest, [string]$content, [bool]$useBom) {
    $parent = Split-Path -Parent $dest
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }

    if (Test-Path -LiteralPath $dest -PathType Leaf) {
        $existingText = [System.IO.File]::ReadAllText($dest, [System.Text.Encoding]::UTF8)
        if ($existingText -cne $content) {
            $bakPath = "$dest.bak-$backupTimestamp"
            Copy-Item -LiteralPath $dest -Destination $bakPath -Force
            Write-Host "  [BACKUP] Existing file backed up -> $bakPath" -ForegroundColor DarkYellow
        }
    }

    $enc = New-Object System.Text.UTF8Encoding($useBom)
    [System.IO.File]::WriteAllText($dest, $content, $enc)
}

# 2. Helper to replace hardcoded C:\Users\Admin with current user's $env:USERPROFILE
#    Writes UTF-8 WITHOUT BOM for .md/.yaml files so YAML frontmatter parsers (like Rust codex_core) never fail,
#    and UTF-8 WITH BOM for .ps1 scripts so Windows PowerShell 5.1 reads Unicode strings accurately.
function Copy-WithUserPath([string]$src, [string]$dest) {
    $content = Get-Content -LiteralPath $src -Raw -Encoding UTF8
    $content = $content.Replace("C:\Users\Admin", $env:USERPROFILE)
    $useBom = $dest.EndsWith(".ps1", [System.StringComparison]::OrdinalIgnoreCase)
    Write-ManagedFile -dest $dest -content $content -useBom $useBom
}

# 3. Install Antigravity Global Rules & Skills (/multi-ai + alias /claude-leader)
Copy-WithUserPath "$repoRoot\antigravity\rules\claude-leader-workflow.md" "$geminiRulesDir\claude-leader-workflow.md"

$ruleBody = (Get-Content -LiteralPath "$repoRoot\antigravity\rules\claude-leader-workflow.md" -Raw -Encoding UTF8) -replace "(?s)^---.*?---\s*", ""
$ruleBody = $ruleBody.Replace("C:\Users\Admin", $env:USERPROFILE)
Write-ManagedFile -dest "$geminiConfigDir\GEMINI.md" -content $ruleBody -useBom $false
Write-ManagedFile -dest "$geminiDir\GEMINI.md" -content $ruleBody -useBom $false

Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\SKILL.md" "$geminiSkillDir\SKILL.md"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\agents.json" "$geminiSkillDir\agents.json"
if (Test-Path -LiteralPath "$repoRoot\antigravity\skills\multi-ai\SKILL.md") {
    Copy-WithUserPath "$repoRoot\antigravity\skills\multi-ai\SKILL.md" "$geminiMultiAiSkillDir\SKILL.md"
}
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\lib\maw-common.ps1" "$geminiScriptsLibDir\maw-common.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\lib\maw-registry.ps1" "$geminiScriptsLibDir\maw-registry.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\lib\maw-hooks.ps1" "$geminiScriptsLibDir\maw-hooks.ps1"

$geminiHooksDir = Join-Path $geminiScriptsDir "hooks"
foreach ($hookEvt in @("job-start", "job-finish", "round-start", "after-implement", "before-review", "before-agent")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $geminiHooksDir $hookEvt) | Out-Null
}
$srcHooksDir = "$repoRoot\antigravity\skills\claude-leader\scripts\hooks"
if (Test-Path -LiteralPath $srcHooksDir -PathType Container) {
    foreach ($hookFile in (Get-ChildItem -LiteralPath $srcHooksDir -Filter "*.ps1" -File -Recurse)) {
        $relHook = $hookFile.FullName.Substring($srcHooksDir.Length).TrimStart('\', '/')
        Copy-WithUserPath $hookFile.FullName (Join-Path $geminiHooksDir $relHook)
    }
}
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\invoke-agent.ps1" "$geminiScriptsDir\invoke-agent.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\invoke-cli-agent.ps1" "$geminiScriptsDir\invoke-cli-agent.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\invoke-claude.ps1" "$geminiScriptsDir\invoke-claude.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\invoke-codex.ps1" "$geminiScriptsDir\invoke-codex.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\invoke-antigravity.ps1" "$geminiScriptsDir\invoke-antigravity.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\invoke-council-review.ps1" "$geminiScriptsDir\invoke-council-review.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\invoke-spec-guard.ps1" "$geminiScriptsDir\invoke-spec-guard.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\invoke-auto-gate.ps1" "$geminiScriptsDir\invoke-auto-gate.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\send-notification.ps1" "$geminiScriptsDir\send-notification.ps1"
Copy-WithUserPath "$repoRoot\antigravity\skills\claude-leader\scripts\save-agentapi-env.ps1" "$geminiScriptsDir\save-agentapi-env.ps1"
if (Test-Path -LiteralPath "$repoRoot\start-dashboard.ps1") {
    $startDashContent = Get-Content -LiteralPath "$repoRoot\start-dashboard.ps1" -Raw -Encoding UTF8
    $startDashContent = $startDashContent.Replace("C:\Users\Admin", $env:USERPROFILE)
    $startDashContent = $startDashContent.Replace("C:\laragon\www\multi-ai-workflow", $repoRoot)
    Write-ManagedFile -dest "$geminiScriptsDir\start-dashboard.ps1" -content $startDashContent -useBom $true
}

$rolesSrcDir = "$repoRoot\antigravity\skills\claude-leader\templates\roles"
if (Test-Path -LiteralPath $rolesSrcDir) {
    foreach ($roleFile in (Get-ChildItem -LiteralPath $rolesSrcDir -Filter "*.md" -File)) {
        Copy-WithUserPath $roleFile.FullName (Join-Path $geminiRolesTemplatesDir $roleFile.Name)
    }
}

if (Test-Path -LiteralPath "$repoRoot\templates\SPEC.template.md") {
    Copy-WithUserPath "$repoRoot\templates\SPEC.template.md" "$geminiTemplatesDir\SPEC.template.md"
}

# 4. Install Claude Code Global Memory & Slash Commands (/multi-ai + alias /antigravity)
Copy-WithUserPath "$repoRoot\claude\CLAUDE.md" "$claudeDir\CLAUDE.md"
Copy-WithUserPath "$repoRoot\claude\commands\antigravity.md" "$claudeCommandsDir\antigravity.md"
if (Test-Path -LiteralPath "$repoRoot\claude\commands\multi-ai.md") {
    Copy-WithUserPath "$repoRoot\claude\commands\multi-ai.md" "$claudeCommandsDir\multi-ai.md"
}

# 5. Install OpenAI Codex Global Memory & Skills ($multi-ai + alias $multi-ai-leader)
Copy-WithUserPath "$repoRoot\codex\AGENTS.md" "$codexDir\AGENTS.md"
Copy-WithUserPath "$repoRoot\codex\skills\multi-ai-leader\SKILL.md" "$codexSkillDir\SKILL.md"
Copy-WithUserPath "$repoRoot\codex\skills\multi-ai-leader\agents\openai.yaml" "$codexSkillAgentsDir\openai.yaml"
if (Test-Path -LiteralPath "$repoRoot\codex\skills\multi-ai\SKILL.md") {
    Copy-WithUserPath "$repoRoot\codex\skills\multi-ai\SKILL.md" "$codexMultiAiSkillDir\SKILL.md"
    Copy-WithUserPath "$repoRoot\codex\skills\multi-ai\agents\openai.yaml" "$codexMultiAiAgentsDir\openai.yaml"
}

Write-Host "`n[OK] Installed Antigravity Global Rules -> $geminiRulesDir\claude-leader-workflow.md" -ForegroundColor Green
Write-Host "[OK] Installed Antigravity Skills (/multi-ai & /claude-leader) -> $geminiConfigDir\skills\" -ForegroundColor Green
Write-Host "[OK] Installed Orchestration Scripts -> $geminiScriptsDir\" -ForegroundColor Green
Write-Host "[OK] Installed Claude Code Memory & Commands (/multi-ai & /antigravity) -> $claudeDir\" -ForegroundColor Green
Write-Host "[OK] Installed OpenAI Codex Memory & Skills (`$multi-ai & `$multi-ai-leader) -> $codexDir\" -ForegroundColor Green
Write-Host "`nDone! Restart or open a new conversation in Antigravity / Claude Code / Codex to use." -ForegroundColor Yellow
