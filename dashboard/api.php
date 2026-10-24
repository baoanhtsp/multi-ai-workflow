<?php
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
date_default_timezone_set('Asia/Ho_Chi_Minh');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('X-Content-Type-Options: nosniff');

function respondJson(array $data, int $status = 200): void {
    http_response_code($status);
    $json = json_encode(
        $data,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT | JSON_INVALID_UTF8_SUBSTITUTE
    );
    if ($json === false) {
        http_response_code(500);
        echo '{"ok":false,"error":"JSON encoding failed."}';
        exit;
    }
    echo $json;
    exit;
}

set_exception_handler(static function (Throwable $e): void {
    error_log('Dashboard API exception: ' . $e->getMessage());
    respondJson(['ok' => false, 'error' => 'Internal server error while processing request.'], 500);
});

// 1. Loopback IP, Host & CSRF/Origin Security Guard
$isCli = (PHP_SAPI === 'cli');
if (!$isCli) {
    $remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '';
    if (!in_array($remoteAddr, ['127.0.0.1', '::1'], true)) {
        respondJson(['ok' => false, 'error' => 'Forbidden: Loopback access only.'], 403);
    }

    $httpHost = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
    $hostOnly = preg_replace('/:\d+$/', '', $httpHost);
    if ($hostOnly !== '' && !in_array($hostOnly, ['localhost', '127.0.0.1', '[::1]'], true)) {
        respondJson(['ok' => false, 'error' => 'Forbidden: Invalid Host header.'], 403);
    }

    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if ($method === 'POST') {
        $contentType = strtolower((string)($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? ''));
        if (strpos($contentType, 'application/json') !== 0) {
            respondJson(['ok' => false, 'error' => 'Unsupported Media Type: Content-Type must be application/json.'], 415);
        }

        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if ($origin !== '') {
            $parsedOrigin = parse_url($origin);
            $originHost = strtolower((string)($parsedOrigin['host'] ?? ''));
            $originPort = isset($parsedOrigin['port']) ? ':' . (int)$parsedOrigin['port'] : '';
            $originAuthority = $originHost . $originPort;
            if (
                !in_array($originHost, ['localhost', '127.0.0.1', '[::1]'], true) ||
                ($httpHost !== '' && $originAuthority !== $httpHost)
            ) {
                respondJson(['ok' => false, 'error' => 'Forbidden: Cross-origin request denied.'], 403);
            }
        }
    }
}

$action = (string)($_GET['action'] ?? 'status');
$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
$userProfile = getenv('USERPROFILE') ?: 'C:\\Users\\Admin';
if (stripos($userProfile, 'systemprofile') !== false && is_dir('C:\\Users\\Admin\\.gemini')) {
    $userProfile = 'C:\\Users\\Admin';
}
$antigravityDir = $userProfile . '\\.gemini\\antigravity';
$bridgeFile = $antigravityDir . '\\agentapi-bridge.json';
$presenceDir = $antigravityDir . '\\presence';
$brainDir = $antigravityDir . '\\brain';
$auditFile = $antigravityDir . '\\multi-ai-audit.jsonl';
$laragonWww = 'C:\\laragon\\www';
$repoRoot = dirname(__DIR__);

function getJsonBody(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        respondJson(['ok' => false, 'error' => 'Malformed JSON request body.'], 400);
    }
    return $decoded;
}

/**
 * Safe PowerShell single-quoted string literal (prevents $() and $var interpolation).
 */
function psq(string $s): string {
    $escaped = preg_replace('/([\'\x{2018}-\x{201B}])/u', '$1$1', $s);
    return "'" . ($escaped ?? $s) . "'";
}

/**
 * Validates that $projectPath is a real subdirectory strictly inside $laragonWww.
 */
function resolveProjectPath(string $projectPath, string $laragonWww): ?string {
    if ($projectPath === '' || preg_match('/[%!"]/', $projectPath)) {
        return null;
    }
    $realBase = realpath($laragonWww);
    $realTarget = realpath($projectPath);
    if ($realBase === false || $realTarget === false || !is_dir($realTarget)) {
        return null;
    }
    $baseNorm = rtrim($realBase, '\\/') . DIRECTORY_SEPARATOR;
    $targetNorm = rtrim($realTarget, '\\/') . DIRECTORY_SEPARATOR;
    if (strlen($targetNorm) <= strlen($baseNorm)) {
        return null;
    }
    if (stripos($targetNorm, $baseNorm) !== 0) {
        return null;
    }
    return rtrim($realTarget, '\\/');
}

/**
 * Lightweight file metadata cache (keyed by path + mtime + size) to avoid re-scanning unchanged transcripts on 10s polls.
 */
function loadLineCountCache(): array {
    $cacheFile = sys_get_temp_dir() . '\\agy_dashboard_linecache.json';
    if (!is_file($cacheFile)) {
        return [];
    }
    $data = json_decode((string)@file_get_contents($cacheFile), true);
    return is_array($data) ? $data : [];
}

function saveLineCountCache(array $cache): void {
    $cacheFile = sys_get_temp_dir() . '\\agy_dashboard_linecache.json';
    if (count($cache) > 64) {
        $cache = array_slice($cache, -64, null, true);
    }
    @file_put_contents($cacheFile, json_encode($cache, JSON_UNESCAPED_SLASHES));
}

/**
 * Reads up to the last $maxBytes of a file and returns non-empty tail lines, using cached total line counts.
 */
function readTailLines(string $filePath, array &$lineCache, int $maxBytes = 65536): array {
    if (!is_file($filePath)) {
        return ['total_lines' => 0, 'lines' => []];
    }
    $size = filesize($filePath);
    $mtime = filemtime($filePath);
    if ($size === false || $size === 0) {
        return ['total_lines' => 0, 'lines' => []];
    }

    $cacheKey = $filePath . '|' . (int)$mtime . '|' . $size;
    $fp = @fopen($filePath, 'rb');
    if (!is_resource($fp)) {
        return ['total_lines' => 0, 'lines' => []];
    }

    if (isset($lineCache[$cacheKey]) && is_int($lineCache[$cacheKey])) {
        $totalLines = $lineCache[$cacheKey];
    } else {
        $totalLines = 0;
        while (!feof($fp)) {
            $chunk = fread($fp, 65536);
            if ($chunk !== false) {
                $totalLines += substr_count($chunk, "\n");
            }
        }
        $lineCache[$cacheKey] = $totalLines;
    }

    $readLen = min($size, $maxBytes);
    fseek($fp, -$readLen, SEEK_END);
    $tailRaw = (string)fread($fp, $readLen);
    fclose($fp);

    if ($readLen < $size) {
        $firstNl = strpos($tailRaw, "\n");
        if ($firstNl !== false) {
            $tailRaw = substr($tailRaw, $firstNl + 1);
        }
    }

    $lines = array_values(array_filter(
        explode("\n", str_replace("\r\n", "\n", $tailRaw)),
        static fn(string $l): bool => trim($l) !== ''
    ));

    return ['total_lines' => max($totalLines, count($lines)), 'lines' => $lines];
}

function getBridgeStatus(string $bridgeFile): array {
    if (!is_file($bridgeFile)) {
        return [
            'online' => false,
            'ls_address' => null,
            'csrf_masked' => null,
            'ls_version' => null,
            'updated_at' => null,
        ];
    }

    $raw = @file_get_contents($bridgeFile);
    $raw = preg_replace('/^\xEF\xBB\xBF/', '', (string)$raw);
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return [
            'online' => false,
            'ls_address' => null,
            'csrf_masked' => null,
            'ls_version' => null,
            'updated_at' => null,
        ];
    }

    $lsAddress = (string)($data['ANTIGRAVITY_LS_ADDRESS'] ?? '');
    $csrf = (string)($data['ANTIGRAVITY_CSRF_TOKEN'] ?? '');
    $csrfMasked = strlen($csrf) > 12 ? (substr($csrf, 0, 8) . '...' . substr($csrf, -4)) : ($csrf !== '' ? 'configured' : null);

    $online = false;
    if (preg_match('/:(\d+)$/', $lsAddress, $m)) {
        $port = (int)$m[1];
        $fp = @fsockopen('127.0.0.1', $port, $errno, $errstr, 0.25);
        if (is_resource($fp)) {
            $online = true;
            fclose($fp);
        }
    }

    return [
        'online' => $online,
        'ls_address' => $lsAddress !== '' ? $lsAddress : null,
        'csrf_masked' => $csrfMasked,
        'ls_version' => !empty($data['ANTIGRAVITY_LS_VERSION']) ? (string)$data['ANTIGRAVITY_LS_VERSION'] : null,
        'updated_at' => !empty($data['UpdatedAt']) ? (string)$data['UpdatedAt'] : null,
    ];
}

function getConversations(string $presenceDir, string $brainDir, array &$lineCache): array {
    $activeLocks = [];
    $now = time();
    if (is_dir($presenceDir)) {
        foreach (glob($presenceDir . '\\*.lock') ?: [] as $lockFile) {
            $cid = pathinfo($lockFile, PATHINFO_FILENAME);
            $mtime = filemtime($lockFile) ?: 0;
            // Consider locks modified within the last 30 minutes as actively open
            if ($mtime > 0 && ($now - $mtime) < 1800) {
                $activeLocks[$cid] = $mtime;
            }
        }
    }
    arsort($activeLocks);

    $candidates = [];
    foreach ($activeLocks as $cid => $mtime) {
        $candidates[$cid] = ['id' => $cid, 'is_active' => true, 'mtime' => $mtime];
    }

    if (is_dir($brainDir)) {
        $dirs = glob($brainDir . '\\*', GLOB_ONLYDIR) ?: [];
        usort($dirs, static fn(string $a, string $b): int => (filemtime($b) ?: 0) <=> (filemtime($a) ?: 0));
        foreach (array_slice($dirs, 0, 8) as $dir) {
            $cid = basename($dir);
            if ($cid === '' || $cid[0] === '.') {
                continue;
            }
            $mtime = filemtime($dir) ?: 0;
            if (!isset($candidates[$cid])) {
                $candidates[$cid] = ['id' => $cid, 'is_active' => false, 'mtime' => $mtime];
            }
        }
    }

    $result = [];
    foreach (array_slice(array_values($candidates), 0, 8) as $item) {
        $cid = $item['id'];
        $transcript = $brainDir . '\\' . $cid . '\\.system_generated\\logs\\transcript.jsonl';
        $stepCount = 0;
        $lastStatus = 'IDLE';
        $lastPreview = '';
        $mtime = $item['mtime'];

        if (is_file($transcript)) {
            $tMtime = filemtime($transcript) ?: 0;
            $mtime = max($mtime, $tMtime);
            if (($now - $tMtime) < 600) {
                $item['is_active'] = true;
            }
            $tailData = readTailLines($transcript, $lineCache, 65536);
            $stepCount = $tailData['total_lines'];
            foreach (array_slice($tailData['lines'], -15) as $line) {
                $obj = json_decode($line, true);
                if (!is_array($obj)) {
                    continue;
                }
                if (!empty($obj['status'])) {
                    $lastStatus = (string)$obj['status'];
                }
                if (($obj['type'] ?? '') === 'PLANNER_RESPONSE' && !empty($obj['content'])) {
                    $text = trim((string)$obj['content']);
                    $lastPreview = mb_substr($text, 0, 180, 'UTF-8') . (mb_strlen($text, 'UTF-8') > 180 ? '...' : '');
                }
            }
        }

        $result[] = [
            'id' => $cid,
            'is_active' => (bool)$item['is_active'],
            'updated_at' => date('Y-m-d H:i:s', $mtime),
            'step_count' => $stepCount,
            'last_status' => $lastStatus,
            'last_preview' => $lastPreview ?: 'Waiting for response or tool execution...',
        ];
    }

    return $result;
}

function getLocalProjects(string $laragonWww): array {
    if (!is_dir($laragonWww)) {
        return [];
    }
    $dirs = glob($laragonWww . '\\*', GLOB_ONLYDIR) ?: [];
    $projects = [];
    foreach ($dirs as $dir) {
        $name = basename($dir);
        if ($name === '' || $name[0] === '.') {
            continue;
        }
        $projects[] = [
            'name' => $name,
            'path' => $dir,
            'has_git' => is_dir($dir . '\\.git'),
            'has_spec' => is_file($dir . '\\SPEC.md'),
            'has_gemini_md' => is_file($dir . '\\GEMINI.md'),
            'updated_at' => date('Y-m-d H:i', filemtime($dir) ?: time()),
        ];
    }
    usort($projects, static function (array $a, array $b): int {
        if ($a['name'] === 'multi-ai-workflow') return -1;
        if ($b['name'] === 'multi-ai-workflow') return 1;
        return strcmp($b['updated_at'], $a['updated_at']);
    });
    return $projects;
}

function getAuditStats(string $auditFile): array {
    $stats = [
        'total_calls' => 0,
        'total_prompt_chars' => 0,
        'estimated_tokens_saved' => 0,
        'by_tool' => ['claude' => 0, 'codex' => 0],
        'by_role' => [
            'architect' => 0,
            'frontend' => 0,
            'reviewer' => 0,
            'ui-tweak' => 0,
            'review-diff' => 0,
            'critic' => 0,
            'coder' => 0,
        ],
        'verdicts' => ['APPROVED' => 0, 'CHANGES_REQUESTED' => 0, 'COMPLETED' => 0],
        'recent_logs' => [],
    ];

    if (!is_file($auditFile)) {
        return $stats;
    }

    $fp = @fopen($auditFile, 'rb');
    if (!is_resource($fp)) {
        return $stats;
    }

    $recentRing = [];
    while (($line = fgets($fp)) !== false) {
        $line = trim((string)preg_replace('/^\xEF\xBB\xBF/', '', $line));
        if ($line === '') {
            continue;
        }
        $entry = json_decode($line, true);
        if (!is_array($entry)) {
            continue;
        }
        $stats['total_calls']++;
        $chars = (int)($entry['PromptChars'] ?? 0);
        $stats['total_prompt_chars'] += $chars;

        $tool = strtolower(trim((string)($entry['Tool'] ?? 'unknown')));
        if ($tool === '') {
            $tool = 'unknown';
        }
        $stats['by_tool'][$tool] = ($stats['by_tool'][$tool] ?? 0) + 1;

        $role = strtolower(trim((string)($entry['Role'] ?? 'unknown')));
        if ($role === '') {
            $role = 'unknown';
        }
        $stats['by_role'][$role] = ($stats['by_role'][$role] ?? 0) + 1;

        $verdict = strtoupper(trim((string)($entry['Verdict'] ?? 'COMPLETED')));
        if ($verdict === '') {
            $verdict = 'COMPLETED';
        }
        $stats['verdicts'][$verdict] = ($stats['verdicts'][$verdict] ?? 0) + 1;

        $recentRing[] = [
            'Timestamp' => $entry['Timestamp'] ?? date('c'),
            'Tool' => $tool,
            'Role' => $role,
            'Model' => $entry['Model'] ?? 'default',
            'WorkDir' => $entry['WorkDir'] ?? '',
            'PromptChars' => $chars,
            'Score' => $entry['Score'] ?? '',
            'Verdict' => $verdict,
        ];
        if (count($recentRing) > 15) {
            array_shift($recentRing);
        }
    }
    fclose($fp);

    $stats['estimated_tokens_saved'] = $stats['total_calls'] * 15000;
    $stats['recent_logs'] = array_reverse($recentRing);

    return $stats;
}

function getCodexModels(string $userProfile): array {
    $defaultModels = [
        'gpt-6.1-sol',
        'gpt-6-astra',
        'gpt-6-sol',
        'gpt-reserve',
        'gpt-6-luna',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'codex-auto-review',
    ];
    $cacheFile = $userProfile . '\\.codex\\models_cache.json';
    if (!is_file($cacheFile)) {
        return $defaultModels;
    }
    $raw = @file_get_contents($cacheFile);
    $data = json_decode((string)$raw, true);
    if (!is_array($data) || empty($data['models']) || !is_array($data['models'])) {
        return $defaultModels;
    }
    $slugs = [];
    foreach ($data['models'] as $m) {
        if (is_array($m) && !empty($m['slug']) && is_string($m['slug'])) {
            $slugs[] = $m['slug'];
        }
    }
    return !empty($slugs) ? array_values(array_unique($slugs)) : $defaultModels;
}

if ($action === 'status') {
    if ($method !== 'GET') {
        respondJson(['ok' => false, 'error' => 'Method Not Allowed: Use GET for status.'], 405);
    }

    $lineCache = loadLineCountCache();
    $bridge = getBridgeStatus($bridgeFile);
    $conversations = getConversations($presenceDir, $brainDir, $lineCache);
    saveLineCountCache($lineCache);

    $claudeInstalled = is_dir($userProfile . '\\.claude');
    $codexInstalled = is_dir($userProfile . '\\.codex');
    $agyInstalled = is_file($antigravityDir . '\\bin\\agentapi.bat');
    $codexModels = getCodexModels($userProfile);

    respondJson([
        'ok' => true,
        'timestamp' => date('c'),
        'user_profile' => $userProfile,
        'bridge' => $bridge,
        'tools' => [
            'antigravity' => [
                'installed' => $agyInstalled,
                'model' => 'Gemini 4 Argon (High)',
                'models' => [
                    'gemini-4-argon-high',
                    'gemini-4-argon-medium',
                    'gemini-4-argon-low',
                    'gemini-3.8-flash-high',
                    'gemini-3.8-flash-medium',
                    'gemini-3.7-flash-high',
                    'gemini-3.5-flash-lite',
                ],
                'cli_models' => ['pro', 'flash', 'flash_lite'],
                'command' => '/claude-leader',
                'role_summary' => 'Backend/Core Dev, Multi-Subagent Branch Coordinator & Context Filter',
            ],
            'claude' => [
                'installed' => $claudeInstalled,
                'version' => '2.1.308',
                'models' => [
                    'claude-opus-5-5',
                    'claude-sonnet-5-5',
                    'claude-haiku-5-5',
                    'claude-fable-5-1',
                    'claude-opus-4-6',
                    'claude-sonnet-4-6',
                    'claude-haiku-4-5',
                ],
                'cli_models' => [
                    'opus',
                    'sonnet',
                    'haiku',
                    'fable',
                    'claude-opus-5-5',
                    'claude-sonnet-5-5',
                    'claude-haiku-5-5',
                    'claude-fable-5-1',
                    'claude-opus-4-8',
                    'claude-opus-4-7',
                    'claude-opus-4-6',
                    'claude-sonnet-4-6',
                    'claude-haiku-4-5',
                ],
                'efforts' => ['low', 'medium', 'high', 'xhigh', 'max'],
                'command' => '/antigravity',
                'role_summary' => 'Tech Lead, 100% Frontend UI Specialist & Code Grader',
            ],
            'codex' => [
                'installed' => $codexInstalled,
                'version' => '0.163.0',
                'model' => 'gpt-6-sol (high)',
                'models' => $codexModels,
                'cli_models' => $codexModels,
                'efforts' => ['low', 'medium', 'high', 'xhigh'],
                'command' => '$multi-ai-leader',
                'role_summary' => 'Security/Logic Critic, Native Diff Reviewer & Algorithm Coder',
            ],
        ],
        'conversations' => $conversations,
        'projects' => getLocalProjects($laragonWww),
        'audit' => getAuditStats($auditFile),
    ]);
}

if ($action === 'init_spec') {
    if ($method !== 'POST') {
        respondJson(['ok' => false, 'error' => 'Method Not Allowed: Use POST for init_spec.'], 405);
    }

    $body = getJsonBody();
    $rawProjectPath = trim((string)($body['project_path'] ?? ''));
    $realTarget = resolveProjectPath($rawProjectPath, $laragonWww);

    if ($realTarget === null) {
        respondJson([
            'ok' => false,
            'error' => 'Invalid project_path. Must be an existing project subdirectory strictly inside C:\\laragon\\www.',
        ], 400);
    }

    $projectName = trim((string)($body['project_name'] ?? basename($realTarget)));
    if ($projectName === '' || mb_strlen($projectName, 'UTF-8') > 120) {
        $projectName = basename($realTarget);
    }

    $specDest = $realTarget . '\\SPEC.md';
    if (is_file($specDest)) {
        respondJson([
            'ok' => true,
            'created' => false,
            'spec_path' => $specDest,
            'message' => 'SPEC.md already exists in ' . $projectName,
        ]);
    }

    $templatePath = $repoRoot . '\\templates\\SPEC.template.md';
    if (!is_file($templatePath)) {
        respondJson(['ok' => false, 'error' => 'SPEC.template.md not found in templates/.'], 500);
    }

    $content = (string)file_get_contents($templatePath);
    $content = str_replace('<Project / Feature Name>', $projectName, $content);

    $fp = @fopen($specDest, 'xb');
    if ($fp === false) {
        if (is_file($specDest)) {
            respondJson([
                'ok' => true,
                'created' => false,
                'spec_path' => $specDest,
                'message' => 'SPEC.md already exists in ' . $projectName,
            ]);
        }
        respondJson(['ok' => false, 'error' => 'Permission denied or unable to create SPEC.md in target folder.'], 500);
    }

    $expectedLen = strlen($content);
    $written = fwrite($fp, $content);
    fclose($fp);

    if ($written === false || $written !== $expectedLen) {
        @unlink($specDest);
        respondJson(['ok' => false, 'error' => 'Failed to write complete SPEC.md to disk.'], 500);
    }

    respondJson([
        'ok' => true,
        'created' => true,
        'spec_path' => $specDest,
        'message' => 'Successfully initialized SPEC.md in ' . $projectName,
    ]);
}

if ($action === 'dispatch') {
    if ($method !== 'POST') {
        respondJson(['ok' => false, 'error' => 'Method Not Allowed: Use POST for dispatch.'], 405);
    }

    $body = getJsonBody();
    $mode = strtolower(trim((string)($body['mode'] ?? '')));
    $allowedModes = ['antigravity', 'claude', 'codex', 'council'];
    if (!in_array($mode, $allowedModes, true)) {
        respondJson([
            'ok' => false,
            'error' => 'Invalid mode. Must be one of: antigravity, claude, codex, council.',
        ], 400);
    }

    $rawProjectPath = trim((string)($body['project_path'] ?? $repoRoot));
    $validatedProjectPath = resolveProjectPath($rawProjectPath, $laragonWww);
    if ($validatedProjectPath === null) {
        respondJson([
            'ok' => false,
            'error' => 'Invalid project_path. Must be an existing project subdirectory strictly inside C:\\laragon\\www.',
        ], 400);
    }

    $role = strtolower(trim((string)($body['role'] ?? '')));
    $allowedRolesByMode = [
        'claude' => ['architect', 'frontend', 'reviewer', 'ui-tweak'],
        'codex' => ['review-diff', 'critic', 'coder'],
        'antigravity' => ['send-latest', 'new', 'status', 'wait'],
        'council' => ['reviewer', ''],
    ];

    if ($mode === 'claude' && !in_array($role, $allowedRolesByMode['claude'], true)) {
        respondJson(['ok' => false, 'error' => 'Invalid role for claude. Allowed: architect, frontend, reviewer, ui-tweak.'], 400);
    }
    if ($mode === 'codex') {
        if ($role === '') {
            $role = 'review-diff';
        }
        if (!in_array($role, $allowedRolesByMode['codex'], true)) {
            respondJson(['ok' => false, 'error' => 'Invalid role for codex. Allowed: review-diff, critic, coder.'], 400);
        }
    }
    if ($mode === 'antigravity') {
        if ($role === '') {
            $role = 'send-latest';
        }
        if (!in_array($role, $allowedRolesByMode['antigravity'], true)) {
            respondJson(['ok' => false, 'error' => 'Invalid role/action for antigravity. Allowed: send-latest, new, status, wait.'], 400);
        }
    }
    if ($mode === 'council') {
        if ($role === '') {
            $role = 'reviewer';
        }
        if (!in_array($role, $allowedRolesByMode['council'], true)) {
            respondJson(['ok' => false, 'error' => 'Invalid role for council. Allowed: reviewer.'], 400);
        }
    }

    $rawPrompt = $body['prompt'] ?? '';
    if (!is_string($rawPrompt)) {
        respondJson(['ok' => false, 'error' => 'Invalid prompt format: must be a string.'], 400);
    }
    $prompt = trim($rawPrompt);
    if (mb_strlen($prompt, 'UTF-8') > 4000) {
        respondJson(['ok' => false, 'error' => 'Prompt exceeds maximum inline length (4000 characters). Use -PromptFile for larger inputs.'], 400);
    }

    $requiresPrompt = (
        $mode === 'claude' ||
        ($mode === 'codex' && in_array($role, ['critic', 'coder'], true)) ||
        ($mode === 'antigravity' && in_array($role, ['send-latest', 'new'], true))
    );
    if ($requiresPrompt && $prompt === '') {
        respondJson(['ok' => false, 'error' => 'Prompt is required for ' . $mode . ' (' . $role . ').'], 400);
    }

    $executeAntigravity = ($body['execute_antigravity'] ?? false) === true;
    if ($executeAntigravity) {
        if ($mode !== 'antigravity' || !in_array($role, ['send-latest', 'new'], true)) {
            respondJson(['ok' => false, 'error' => 'Live execution (execute_antigravity) is only supported for antigravity mode with send-latest or new.'], 400);
        }
        if ($prompt === '') {
            respondJson(['ok' => false, 'error' => 'Prompt is required when execute_antigravity is true.'], 400);
        }
    }

    $rawModel = $body['model'] ?? '';
    $rawEffort = $body['effort'] ?? '';
    if (!is_string($rawModel) || !is_string($rawEffort)) {
        respondJson(['ok' => false, 'error' => 'Invalid model or effort format: must be strings.'], 400);
    }
    $modelOverride = strtolower(trim($rawModel));
    $effortOverride = strtolower(trim($rawEffort));

    $allowedClaudeModels = [
        '', 'opus', 'sonnet', 'haiku', 'fable',
        'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-5',
        'claude-haiku-5-5', 'claude-fable-5-1', 'claude-fable-5',
        'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
        'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5',
    ];
    $allowedClaudeEfforts = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
    $allowedCodexModels = array_merge([''], array_map('strtolower', getCodexModels($userProfile)));
    $allowedCodexEfforts = ['', 'low', 'medium', 'high', 'xhigh'];
    $allowedAgyModels = ['', 'pro', 'flash', 'flash_lite'];

    if ($mode === 'claude') {
        if (!in_array($modelOverride, $allowedClaudeModels, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid Claude model override.'], 400);
        }
        if (!in_array($effortOverride, $allowedClaudeEfforts, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid Claude effort override.'], 400);
        }
    } elseif ($mode === 'codex') {
        if (!in_array($modelOverride, $allowedCodexModels, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid Codex model override.'], 400);
        }
        if (!in_array($effortOverride, $allowedCodexEfforts, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid Codex effort override.'], 400);
        }
    } elseif ($mode === 'antigravity') {
        if (!in_array($modelOverride, $allowedAgyModels, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid Antigravity model tier (allowed: pro, flash, flash_lite).'], 400);
        }
    }

    $scriptsDir = $userProfile . '\\.gemini\\config\\skills\\claude-leader\\scripts';

    if ($mode === 'claude') {
        $extra = ($role === 'reviewer') ? ' -IncludeGitDiff' : '';
        if ($modelOverride !== '') {
            $extra .= ' -ModelOverride ' . psq($modelOverride);
        }
        if ($effortOverride !== '') {
            $extra .= ' -EffortOverride ' . psq($effortOverride);
        }
        $cmd = sprintf(
            'powershell -NoProfile -ExecutionPolicy Bypass -File %s -Role %s -WorkDir %s%s -Prompt %s',
            psq($scriptsDir . '\\invoke-claude.ps1'),
            psq($role),
            psq($validatedProjectPath),
            $extra,
            psq($prompt)
        );
    } elseif ($mode === 'codex') {
        $extra = '';
        if ($modelOverride !== '') {
            $extra .= ' -ModelOverride ' . psq($modelOverride);
        }
        if ($effortOverride !== '') {
            $extra .= ' -EffortOverride ' . psq($effortOverride);
        }
        $promptArg = ($prompt !== '') ? (' -Prompt ' . psq($prompt)) : '';
        $cmd = sprintf(
            'powershell -NoProfile -ExecutionPolicy Bypass -File %s -Role %s -WorkDir %s%s%s',
            psq($scriptsDir . '\\invoke-codex.ps1'),
            psq($role),
            psq($validatedProjectPath),
            $extra,
            $promptArg
        );
    } elseif ($mode === 'council') {
        $effectivePrompt = $prompt !== '' ? $prompt : 'Review uncommitted changes against SPEC.md and score X/10.';
        $cmd = sprintf(
            'powershell -NoProfile -ExecutionPolicy Bypass -File %s -WorkDir %s -Prompt %s',
            psq($scriptsDir . '\\invoke-council-review.ps1'),
            psq($validatedProjectPath),
            psq($effectivePrompt)
        );
    } else {
        if (in_array($role, ['status', 'wait'], true)) {
            $cmd = sprintf(
                'powershell -NoProfile -ExecutionPolicy Bypass -File %s -Action %s -WorkDir %s',
                psq($scriptsDir . '\\invoke-antigravity.ps1'),
                psq($role),
                psq($validatedProjectPath)
            );
        } else {
            $modelArg = ($role === 'new' && $modelOverride !== '') ? (' -Model ' . psq($modelOverride)) : '';
            $cmd = sprintf(
                'powershell -NoProfile -ExecutionPolicy Bypass -File %s -Action %s -WorkDir %s%s -Title %s -Prompt %s',
                psq($scriptsDir . '\\invoke-antigravity.ps1'),
                psq($role),
                psq($validatedProjectPath),
                $modelArg,
                psq('Task from Mission Control'),
                psq($prompt)
            );
        }
    }

    $dispatched = false;
    $dispatchOutput = '';

    if ($mode === 'antigravity' && $executeAntigravity) {
        set_time_limit(30);
        $tempDir = sys_get_temp_dir();
        foreach (glob($tempDir . '\\agy_dispatch_*.txt') ?: [] as $oldFile) {
            if ((time() - (filemtime($oldFile) ?: 0)) > 300) {
                @unlink($oldFile);
            }
        }

        $tempPromptFile = $tempDir . '\\agy_dispatch_' . bin2hex(random_bytes(8)) . '.txt';
        // Write with UTF-8 BOM so Windows PowerShell 5.1 always reads UTF-8 accurately
        if (file_put_contents($tempPromptFile, "\xEF\xBB\xBF" . $prompt) === false) {
            respondJson(['ok' => false, 'error' => 'Failed to create temporary prompt file.'], 500);
        }

        $execCmd = sprintf(
            'powershell -NoProfile -ExecutionPolicy Bypass -File %s -Action %s -WorkDir %s -NoWait -Title %s -PromptFile %s 2>&1',
            escapeshellarg($scriptsDir . '\\invoke-antigravity.ps1'),
            escapeshellarg($role),
            escapeshellarg($validatedProjectPath),
            escapeshellarg('Task from Mission Control'),
            escapeshellarg($tempPromptFile)
        );

        $outLines = [];
        $exitCode = 1;
        exec($execCmd, $outLines, $exitCode);
        @unlink($tempPromptFile);

        $dispatchOutput = trim(implode("\n", $outLines));
        $dispatched = ($exitCode === 0);

        if (!$dispatched) {
            respondJson([
                'ok' => false,
                'command' => $cmd,
                'dispatched' => false,
                'output' => $dispatchOutput,
                'error' => 'Failed to dispatch task to Antigravity (exit code ' . $exitCode . ').',
            ], 502);
        }
    }

    respondJson([
        'ok' => true,
        'command' => $cmd,
        'dispatched' => $dispatched,
        'output' => $dispatchOutput,
    ]);
}

respondJson(['ok' => false, 'error' => 'Unsupported action: ' . $action], 400);
