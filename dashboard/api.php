<?php
declare(strict_types=1);

/**
 * Multi-AI Workflow — Mission Control Backend & Telemetry API (v2.2)
 * Zero-dependency PHP 8.x endpoint for C:\laragon\www\multi-ai-workflow\dashboard\api.php
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');

function respondJson(array $payload, int $statusCode = 200): never {
    http_response_code($statusCode);
    echo json_encode(
        $payload,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE
    );
    exit;
}

// 1. Strict Local-Only Access Control & DNS Rebinding Protection (SPEC §3.0)
$remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '';
$allowedLoopbacks = ['127.0.0.1', '::1', 'localhost'];
if ($remoteAddr !== '' && !in_array($remoteAddr, $allowedLoopbacks, true)) {
    respondJson(['ok' => false, 'error' => 'Forbidden: Localhost access only.'], 403);
}

$httpHost = strtolower((string)($_SERVER['HTTP_HOST'] ?? ''));
$hostOnly = (string)preg_replace('/:\d+$/', '', $httpHost);
if ($hostOnly !== '' && !in_array($hostOnly, ['localhost', '127.0.0.1', '[::1]'], true) && !str_ends_with($hostOnly, '.test') && !str_ends_with($hostOnly, '.local')) {
    respondJson(['ok' => false, 'error' => 'Forbidden: Untrusted Host header.'], 403);
}

// 2. Method & CSRF / Origin / Sec-Fetch-Site Validation for State-Changing Requests (SPEC §3.0)
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
if ($method === 'OPTIONS') {
    header('Allow: GET, POST, OPTIONS');
    http_response_code(204);
    exit;
}

if ($method === 'POST') {
    // (1) Custom header X-MAW-Request: 1 required on every POST
    $mawHeader = trim((string)($_SERVER['HTTP_X_MAW_REQUEST'] ?? ''));
    if ($mawHeader !== '1') {
        respondJson([
            'ok' => false,
            'error' => 'Forbidden: Missing or invalid X-MAW-Request header.',
        ], 403);
    }

    // (2) Media type (part before ';', trimmed, lower-cased) must be exactly 'application/json'
    $rawContentType = (string)($_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '');
    $mediaType = strtolower(trim(explode(';', $rawContentType, 2)[0]));
    if ($mediaType !== 'application/json') {
        respondJson([
            'ok' => false,
            'error' => 'Unsupported Media Type: Content-Type must be application/json.',
        ], 415);
    }

    // (3) Origin, if present, must be a real origin whose host equals the request host; Origin: null is rejected
    if (array_key_exists('HTTP_ORIGIN', $_SERVER)) {
        $rawOrigin = trim((string)$_SERVER['HTTP_ORIGIN']);
        if ($rawOrigin !== '') {
            if (strtolower($rawOrigin) === 'null') {
                respondJson([
                    'ok' => false,
                    'error' => 'Forbidden: Origin null is not allowed.',
                ], 403);
            }
            $originScheme = strtolower((string)parse_url($rawOrigin, PHP_URL_SCHEME));
            $originHost   = strtolower((string)parse_url($rawOrigin, PHP_URL_HOST));
            if (!in_array($originScheme, ['http', 'https'], true) || $originHost === '' || ($hostOnly !== '' && $originHost !== $hostOnly)) {
                respondJson([
                    'ok' => false,
                    'error' => 'Forbidden: Cross-origin POST requests are not allowed.',
                ], 403);
            }
        }
    }

    // (4) Sec-Fetch-Site, if present, must be 'same-origin' or 'none'
    $secFetchSite = strtolower(trim((string)($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '')));
    if ($secFetchSite !== '' && !in_array($secFetchSite, ['same-origin', 'none'], true)) {
        respondJson([
            'ok' => false,
            'error' => 'Forbidden: Cross-site request blocked by Sec-Fetch-Site policy.',
        ], 403);
    }
}

$action = trim((string)($_GET['action'] ?? 'status'));
$repoRoot = realpath(dirname(__DIR__)) ?: 'C:\\laragon\\www\\multi-ai-workflow';
$laragonWww = realpath(dirname($repoRoot)) ?: 'C:\\laragon\\www';

$userProfile = getenv('USERPROFILE') ?: ($_SERVER['USERPROFILE'] ?? '');
if ($userProfile === '' || !is_dir($userProfile)) {
    $userProfile = 'C:\\Users\\Admin';
}
$userProfile = rtrim($userProfile, "\\/");

$antigravityDir = $userProfile . '\\.gemini\\antigravity';
$bridgeFile     = $antigravityDir . '\\agentapi-bridge.json';
$auditFile      = $antigravityDir . '\\multi-ai-audit.jsonl';
$notifyCfgFile  = $antigravityDir . '\\notify-config.json';
$presenceDir    = $antigravityDir . '\\presence';
$brainDir       = $antigravityDir . '\\brain';
$jobsDir        = sys_get_temp_dir() . '\\maw_jobs';
$scriptsDir     = $userProfile . '\\.gemini\\config\\skills\\claude-leader\\scripts';
if (!is_dir($scriptsDir)) {
    $scriptsDir = $repoRoot . '\\antigravity\\skills\\claude-leader\\scripts';
}

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

function psq(string $val): string {
    $clean = str_replace(["\0", "\r"], '', $val);
    $escaped = preg_replace('/[\'\x{2018}\x{2019}\x{201A}\x{201B}]/u', '$0$0', $clean);
    return "'" . ($escaped ?? $clean) . "'";
}

function resolveProjectPath(string $candidatePath, string $laragonWww): ?string {
    $candidatePath = trim($candidatePath);
    if ($candidatePath === '') {
        return null;
    }
    $realTarget = realpath($candidatePath);
    $realBase = realpath($laragonWww);
    if ($realTarget === false || $realBase === false || !is_dir($realTarget)) {
        return null;
    }
    $normTarget = strtolower(rtrim(str_replace('/', '\\', $realTarget), '\\'));
    $normBase = strtolower(rtrim(str_replace('/', '\\', $realBase), '\\'));
    if (!str_starts_with($normTarget, $normBase . '\\')) {
        return null;
    }
    return $realTarget;
}

function loadLineCountCache(): array {
    $cacheFile = sys_get_temp_dir() . '\\agy_dashboard_linecache.json';
    if (!is_file($cacheFile)) {
        return [];
    }
    $raw = @file_get_contents($cacheFile);
    $data = json_decode((string)$raw, true);
    return is_array($data) ? $data : [];
}

function saveLineCountCache(array $cache): void {
    $cacheFile = sys_get_temp_dir() . '\\agy_dashboard_linecache.json';
    if (count($cache) > 64) {
        $cache = array_slice($cache, -64, null, true);
    }
    $tmpFile = $cacheFile . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (@file_put_contents($tmpFile, json_encode($cache, JSON_UNESCAPED_SLASHES)) !== false) {
        @rename($tmpFile, $cacheFile);
    } else {
        @unlink($tmpFile);
    }
}

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
    if ($lsAddress !== '' && str_contains($lsAddress, ':')) {
        [$host, $port] = explode(':', $lsAddress, 2);
        $portNum = (int)$port;
        if ($portNum > 0) {
            $sock = @fsockopen($host ?: '127.0.0.1', $portNum, $errno, $errstr, 0.25);
            if (is_resource($sock)) {
                $online = true;
                fclose($sock);
            }
        }
    }

    return [
        'online' => $online,
        'ls_address' => $lsAddress ?: null,
        'csrf_masked' => $csrfMasked,
        'ls_version' => $data['ANTIGRAVITY_LS_VERSION'] ?? null,
        'updated_at' => $data['UpdatedAt'] ?? (filemtime($bridgeFile) ? date('c', filemtime($bridgeFile)) : null),
    ];
}

function getDetectedToolVersions(string $userProfile): array {
    $cacheFile = sys_get_temp_dir() . '\\maw_tool_versions_cache_v2.json';
    if (is_file($cacheFile) && (time() - (int)@filemtime($cacheFile)) < 3600) {
        $cached = json_decode((string)@file_get_contents($cacheFile), true);
        if (is_array($cached) && array_key_exists('claude', $cached) && array_key_exists('codex', $cached)) {
            return [
                'claude' => is_string($cached['claude']) ? $cached['claude'] : null,
                'codex' => is_string($cached['codex']) ? $cached['codex'] : null,
            ];
        }
    }

    $claudeVer = null;
    $claudeOut = trim((string)@shell_exec('claude --version 2>NUL'));
    if ($claudeOut === '') {
        $claudeBase = $userProfile . '\\AppData\\Roaming\\Claude\\claude-code';
        if (is_dir($claudeBase)) {
            $exes = array_merge(
                glob($claudeBase . '\\*\\*\\claude.exe') ?: [],
                glob($claudeBase . '\\*\\claude.exe') ?: []
            );
            if (!empty($exes)) {
                usort($exes, static fn(string $a, string $b): int => (filemtime($b) ?: 0) <=> (filemtime($a) ?: 0));
                $claudeOut = trim((string)@shell_exec(escapeshellarg($exes[0]) . ' --version 2>NUL'));
            }
        }
    }
    if ($claudeOut !== '' && preg_match('/(\d+\.\d+\.\d+(?:-[a-zA-Z0-9._]+)?)/', $claudeOut, $m)) {
        $claudeVer = $m[1];
    }

    $codexVer = null;
    $codexOut = trim((string)@shell_exec('codex --version 2>NUL'));
    if ($codexOut === '') {
        $npmCodex = $userProfile . '\\AppData\\Roaming\\npm\\codex.cmd';
        if (is_file($npmCodex)) {
            $codexOut = trim((string)@shell_exec(escapeshellarg($npmCodex) . ' --version 2>NUL'));
        }
    }
    if ($codexOut !== '' && preg_match('/(\d+\.\d+\.\d+(?:-[a-zA-Z0-9._]+)?)/', $codexOut, $m)) {
        $codexVer = $m[1];
    }

    $result = ['claude' => $claudeVer, 'codex' => $codexVer];
    @file_put_contents($cacheFile, json_encode($result, JSON_UNESCAPED_SLASHES));
    return $result;
}

function getConversations(string $presenceDir, string $brainDir, array &$lineCache): array {
    $activeLocks = [];
    $now = time();
    if (is_dir($presenceDir)) {
        foreach (glob($presenceDir . '\\*.lock') ?: [] as $lockFile) {
            $cid = pathinfo($lockFile, PATHINFO_FILENAME);
            $mtime = filemtime($lockFile) ?: 0;
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
            'last_preview' => $lastPreview,
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

/**
 * Computes per-call token & USD cost for audit records (B9: no fabricated saved-token metrics).
 */
function estimateEntryTelemetry(array $entry): array {
    $promptChars = max(0, (int)($entry['PromptChars'] ?? 0));
    $outputChars = max(0, (int)($entry['OutputChars'] ?? 0));
    $model = strtolower(trim((string)($entry['Model'] ?? 'sonnet')));
    $tool  = strtolower(trim((string)($entry['Tool'] ?? 'claude')));

    $inTokens = isset($entry['InputTokens']) && (int)$entry['InputTokens'] > 0
        ? (int)$entry['InputTokens']
        : max(1, (int)ceil(($promptChars > 0 ? $promptChars : 600) / 3.8));
    $outTokens = isset($entry['OutputTokens']) && (int)$entry['OutputTokens'] > 0
        ? (int)$entry['OutputTokens']
        : max(1, (int)ceil(($outputChars > 0 ? $outputChars : 1600) / 3.8));

    if (isset($entry['CostUsd']) && is_numeric($entry['CostUsd']) && (float)$entry['CostUsd'] > 0) {
        $costUsd = (float)$entry['CostUsd'];
    } else {
        if (str_contains($model, 'opus')) {
            $inRate = 15.0; $outRate = 75.0;
        } elseif (str_contains($model, 'haiku')) {
            $inRate = 0.8;  $outRate = 4.0;
        } elseif (str_contains($model, 'fable')) {
            $inRate = 6.0;  $outRate = 30.0;
        } elseif ($tool === 'codex' || str_contains($model, 'gpt')) {
            $inRate = 2.5;  $outRate = 10.0;
        } elseif ($tool === 'antigravity' || str_contains($model, 'gemini')) {
            $inRate = 1.25; $outRate = 5.0;
        } else {
            $inRate = 3.0;  $outRate = 15.0;
        }
        $costUsd = round(($inTokens * $inRate + $outTokens * $outRate) / 1000000.0, 5);
    }

    return [
        'in_tokens'  => $inTokens,
        'out_tokens' => $outTokens,
        'cost_usd'   => $costUsd,
    ];
}

function getAuditStats(string $auditFile): array {
    $defaultStats = [
        'total_calls' => 0,
        'total_prompt_chars' => 0,
        'total_input_tokens' => 0,
        'total_output_tokens' => 0,
        'total_cost_usd' => 0.0,
        'avg_cost_per_call_usd' => 0.0,
        'by_tool' => ['claude' => 0, 'codex' => 0, 'antigravity' => 0],
        'cost_by_tool' => ['claude' => 0.0, 'codex' => 0.0, 'antigravity' => 0.0],
        'cost_by_model' => [],
        'by_role' => [
            'architect' => 0,
            'leader' => 0,
            'backend' => 0,
            'frontend' => 0,
            'reviewer' => 0,
            'tester' => 0,
            'ui-tweak' => 0,
            'review-diff' => 0,
            'critic' => 0,
            'coder' => 0,
            'send-latest' => 0,
        ],
        'verdicts' => ['APPROVED' => 0, 'CHANGES_REQUESTED' => 0, 'COMPLETED' => 0],
        'recent_logs' => [],
    ];

    if (!is_file($auditFile)) {
        return $defaultStats;
    }

    $mtime = (int)@filemtime($auditFile);
    $size  = (int)@filesize($auditFile);
    $cacheFile = sys_get_temp_dir() . '\\agy_dashboard_auditcache_v21.json';
    if (is_file($cacheFile)) {
        $cached = json_decode((string)@file_get_contents($cacheFile), true);
        if (is_array($cached) && ($cached['_sig'] ?? '') === ($mtime . '|' . $size) && isset($cached['data'])) {
            return $cached['data'];
        }
    }

    $fp = @fopen($auditFile, 'rb');
    if (!is_resource($fp)) {
        return $defaultStats;
    }

    $stats = $defaultStats;
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

        $modelName = (string)($entry['Model'] ?? 'default');
        $tel = estimateEntryTelemetry($entry);
        $stats['total_input_tokens'] += $tel['in_tokens'];
        $stats['total_output_tokens'] += $tel['out_tokens'];
        $stats['total_cost_usd'] = round($stats['total_cost_usd'] + $tel['cost_usd'], 4);
        $stats['cost_by_tool'][$tool] = round(($stats['cost_by_tool'][$tool] ?? 0.0) + $tel['cost_usd'], 4);
        $stats['cost_by_model'][$modelName] = round(($stats['cost_by_model'][$modelName] ?? 0.0) + $tel['cost_usd'], 4);

        $recentRing[] = [
            'Timestamp' => $entry['Timestamp'] ?? '',
            'Tool' => $tool,
            'Role' => $role,
            'Model' => $modelName,
            'WorkDir' => $entry['WorkDir'] ?? '',
            'PromptChars' => $chars,
            'InputTokens' => $tel['in_tokens'],
            'OutputTokens' => $tel['out_tokens'],
            'CostUsd' => $tel['cost_usd'],
            'Score' => $entry['Score'] ?? '',
            'Verdict' => $verdict,
        ];
        if (count($recentRing) > 20) {
            array_shift($recentRing);
        }
    }
    fclose($fp);

    $stats['avg_cost_per_call_usd'] = $stats['total_calls'] > 0
        ? round($stats['total_cost_usd'] / $stats['total_calls'], 5)
        : 0.0;
    $stats['recent_logs'] = array_reverse($recentRing);

    $tmpCache = $cacheFile . '.' . bin2hex(random_bytes(3)) . '.tmp';
    if (@file_put_contents($tmpCache, json_encode(['_sig' => $mtime . '|' . $size, 'data' => $stats], JSON_UNESCAPED_SLASHES)) !== false) {
        @rename($tmpCache, $cacheFile);
    } else {
        @unlink($tmpCache);
    }

    return $stats;
}

function appendAuditEntry(string $auditFile, array $entry): void {
    $dir = dirname($auditFile);
    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }
    @file_put_contents(
        $auditFile,
        json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n",
        FILE_APPEND | LOCK_EX
    );
}

function getCodexModels(string $userProfile): array {
    $cacheFile = $userProfile . '\\.codex\\models_cache.json';
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

function getProjectGitInfo(string $projectPath): array {
    if (!is_dir($projectPath . '\\.git') && !is_file($projectPath . '\\.git')) {
        return [
            'has_git' => false,
            'current_branch' => null,
            'modified_count' => 0,
            'ahead' => 0,
            'behind' => 0,
            'branches' => [],
            'worktrees' => [],
            'recent_commits' => [],
        ];
    }

    $qPath = escapeshellarg($projectPath);
    $curBranch = trim((string)@shell_exec("git -C $qPath rev-parse --abbrev-ref HEAD 2>NUL"));

    $statusRaw = (string)@shell_exec("git -C $qPath status --porcelain 2>NUL");
    $statusLines = array_values(array_filter(explode("\n", str_replace("\r\n", "\n", $statusRaw)), static fn(string $l): bool => trim($l) !== ''));

    $ahead = 0;
    $behind = 0;
    $abRaw = trim((string)@shell_exec("git -C $qPath rev-list --left-right --count HEAD...@{u} 2>NUL"));
    if ($abRaw !== '' && preg_match('/^(\d+)\s+(\d+)$/', $abRaw, $m)) {
        $ahead = (int)$m[1];
        $behind = (int)$m[2];
    }

    $branches = [];
    $brRaw = (string)@shell_exec("git -C $qPath branch --format=\"%(refname:short)|%(objectname:short)|%(HEAD)|%(committerdate:relative)\" 2>NUL");
    foreach (explode("\n", str_replace("\r\n", "\n", $brRaw)) as $line) {
        $line = trim($line, " \t\n\r\0\x0B\"");
        if ($line === '') continue;
        $parts = explode('|', $line);
        $branches[] = [
            'name' => $parts[0] ?? '',
            'sha' => $parts[1] ?? '',
            'is_current' => ($parts[2] ?? '') === '*',
            'updated' => $parts[3] ?? '',
        ];
    }

    $worktrees = [];
    $wtRaw = (string)@shell_exec("git -C $qPath worktree list --porcelain 2>NUL");
    $curWt = [];
    foreach (explode("\n", str_replace("\r\n", "\n", $wtRaw)) as $line) {
        $line = trim($line);
        if ($line === '') {
            if (!empty($curWt['path'])) {
                $worktrees[] = $curWt;
            }
            $curWt = [];
            continue;
        }
        if (str_starts_with($line, 'worktree ')) {
            $curWt['path'] = substr($line, 9);
        } elseif (str_starts_with($line, 'HEAD ')) {
            $curWt['head'] = substr($line, 5, 7);
        } elseif (str_starts_with($line, 'branch ')) {
            $curWt['branch'] = str_replace('refs/heads/', '', substr($line, 7));
        } elseif ($line === 'detached') {
            $curWt['branch'] = 'detached';
        }
    }
    if (!empty($curWt['path'])) {
        $worktrees[] = $curWt;
    }

    $commits = [];
    $logRaw = (string)@shell_exec("git -C $qPath log -n 5 --pretty=format:\"%h|%s|%cr|%an\" 2>NUL");
    foreach (explode("\n", str_replace("\r\n", "\n", $logRaw)) as $line) {
        $line = trim($line, " \t\n\r\0\x0B\"");
        if ($line === '') continue;
        $parts = explode('|', $line, 4);
        $commits[] = [
            'sha' => $parts[0] ?? '',
            'subject' => $parts[1] ?? '',
            'time' => $parts[2] ?? '',
            'author' => $parts[3] ?? '',
        ];
    }

    return [
        'has_git' => true,
        'current_branch' => $curBranch ?: 'HEAD',
        'modified_count' => count($statusLines),
        'ahead' => $ahead,
        'behind' => $behind,
        'branches' => $branches,
        'worktrees' => $worktrees,
        'recent_commits' => $commits,
    ];
}

function loadInternalNotifyConfig(string $notifyCfgFile): array {
    $cfg = [
        'desktop_toast' => true,
        'webhook_url' => '',
        'telegram_bot_token' => '',
        'telegram_chat_id' => '',
    ];
    if (is_file($notifyCfgFile)) {
        $raw = @file_get_contents($notifyCfgFile);
        $data = json_decode((string)$raw, true);
        if (is_array($data)) {
            $cfg['desktop_toast'] = isset($data['desktop_toast']) ? (bool)$data['desktop_toast'] : true;
            $cfg['webhook_url'] = (string)($data['webhook_url'] ?? '');
            $cfg['telegram_bot_token'] = (string)($data['telegram_bot_token'] ?? '');
            $cfg['telegram_chat_id'] = (string)($data['telegram_chat_id'] ?? '');
        }
    }
    return $cfg;
}

function getPublicNotifyConfig(string $notifyCfgFile): array {
    $cfg = loadInternalNotifyConfig($notifyCfgFile);
    $tok = $cfg['telegram_bot_token'];
    $masked = null;
    if ($tok !== '') {
        $masked = strlen($tok) > 10 ? (substr($tok, 0, 6) . '...' . substr($tok, -4)) : 'configured';
    }
    return [
        'desktop_toast' => (bool)$cfg['desktop_toast'],
        'webhook_url' => $cfg['webhook_url'],
        'telegram_chat_id' => $cfg['telegram_chat_id'],
        'telegram_bot_token_set' => ($tok !== ''),
        'telegram_bot_token_masked' => $masked,
    ];
}

function isProcessRunning(int $pid): bool {
    if ($pid <= 0) return false;
    $out = (string)@shell_exec("tasklist /FI \"PID eq $pid\" /NH 2>NUL");
    return str_contains($out, (string)$pid);
}

function refreshJobMetaStatus(array $meta, string $jobsDir): array {
    if (($meta['status'] ?? '') !== 'RUNNING') {
        if (!array_key_exists('exit_code', $meta)) {
            $meta['exit_code'] = null;
        }
        return $meta;
    }
    $jobId = (string)($meta['job_id'] ?? '');
    $logFile = $jobsDir . '\\' . $jobId . '.log';
    $metaFile = $jobsDir . '\\' . $jobId . '.json';
    $pid = (int)($meta['pid'] ?? 0);

    if (is_file($logFile)) {
        $size = (int)@filesize($logFile);
        if ($size > 0) {
            $fp = @fopen($logFile, 'rb');
            if (is_resource($fp)) {
                fseek($fp, -min($size, 512), SEEK_END);
                $tail = (string)fread($fp, 512);
                fclose($fp);
                if (preg_match('/===\s*\[JOB_FINISHED\s+exit_code=(-?\d+)\]\s*===/', $tail, $m)) {
                    $code = (int)$m[1];
                    $meta['status'] = ($code === 0) ? 'DONE' : 'FAILED';
                    $meta['exit_code'] = $code;
                    $meta['finished_at'] = date('c');
                    @file_put_contents($metaFile, json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
                    return $meta;
                }
                if (str_contains($tail, '=== [JOB_CANCELLED_BY_USER] ===')) {
                    $meta['status'] = 'CANCELLED';
                    $meta['exit_code'] = $meta['exit_code'] ?? null;
                    $meta['finished_at'] = date('c');
                    @file_put_contents($metaFile, json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
                    return $meta;
                }
            }
        }
    }

    // R5: If PID capture failed (pid <= 0), keep RUNNING while the log was modified in the last 60s
    if ($pid <= 0) {
        clearstatcache(true, $logFile);
        $lastMod = is_file($logFile) ? (int)@filemtime($logFile) : 0;
        if ($lastMod <= 0) {
            $lastMod = (int)($meta['started_ts'] ?? 0);
        }
        if ($lastMod > 0 && (time() - $lastMod) < 60) {
            $meta['exit_code'] = $meta['exit_code'] ?? null;
            return $meta;
        }
        $meta['status'] = 'FAILED';
        $meta['exit_code'] = null;
        $meta['finished_at'] = date('c');
        @file_put_contents($metaFile, json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        return $meta;
    }

    // A process that exits without writing the JOB_FINISHED marker => FAILED with exit_code: null (SPEC §3.7)
    if (!isProcessRunning($pid)) {
        $meta['status'] = 'FAILED';
        $meta['exit_code'] = null;
        $meta['finished_at'] = date('c');
        @file_put_contents($metaFile, json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        return $meta;
    }

    $meta['exit_code'] = $meta['exit_code'] ?? null;
    return $meta;
}

function getRecentJobs(string $jobsDir): array {
    if (!is_dir($jobsDir)) {
        return [];
    }
    $files = glob($jobsDir . '\\job_*.json') ?: [];
    usort($files, static fn(string $a, string $b): int => (filemtime($b) ?: 0) <=> (filemtime($a) ?: 0));
    $jobs = [];
    foreach (array_slice($files, 0, 8) as $f) {
        $meta = json_decode((string)@file_get_contents($f), true);
        if (!is_array($meta)) continue;
        $meta = refreshJobMetaStatus($meta, $jobsDir);
        $row = [
            'job_id' => $meta['job_id'] ?? '',
            'mode' => $meta['mode'] ?? '',
            'agent' => $meta['agent'] ?? ($meta['mode'] ?? ''),
            'role' => $meta['role'] ?? '',
            'project_name' => basename((string)($meta['project_path'] ?? '')),
            'status' => $meta['status'] ?? 'UNKNOWN',
            'exit_code' => $meta['exit_code'] ?? null,
            'started_at' => $meta['started_at'] ?? '',
            'pid' => $meta['pid'] ?? null,
        ];
        if (array_key_exists('team', $meta) && is_array($meta['team'])) {
            $row['team'] = $meta['team'];
        }
        $jobs[] = $row;
    }
    return $jobs;
}

/**
 * Ensures a raw byte chunk never ends in the middle of a multi-byte UTF-8 character (SPEC §3.7).
 */
function trimIncompleteUtf8Tail(string $bytes): string {
    $len = strlen($bytes);
    if ($len === 0) {
        return '';
    }
    // Fast path: last byte is ASCII (0xxxxxxx)
    if ((ord($bytes[$len - 1]) & 0x80) === 0) {
        return $bytes;
    }
    // Scan backwards up to 4 bytes to find the UTF-8 lead byte (11xxxxxx)
    for ($back = 1; $back <= 4 && $back <= $len; $back++) {
        $idx = $len - $back;
        $b = ord($bytes[$idx]);
        if (($b & 0xC0) === 0x80) {
            // Continuation byte (10xxxxxx), keep scanning back
            continue;
        }
        if (($b & 0xE0) === 0xC0) {
            $expected = 2;
        } elseif (($b & 0xF0) === 0xE0) {
            $expected = 3;
        } elseif (($b & 0xF8) === 0xF0) {
            $expected = 4;
        } else {
            return substr($bytes, 0, $idx);
        }
        return ($back < $expected) ? substr($bytes, 0, $idx) : $bytes;
    }
    return $bytes;
}

/**
 * Single unified builder for PowerShell script invocation (B10 & F4: used by both dispatch preview and run_job).
 */
function buildPowerShellCall(array $info, string $scriptsDir, ?string $promptFile = null): string {
    $mode           = $info['mode'];
    $agent          = $info['agent'] ?? '';
    $role           = $info['role'];
    $modelOverride  = $info['model'];
    $effortOverride = $info['effort'];
    $newSession     = (bool)($info['new_session'] ?? false);
    $teamSpec       = (string)($info['team_spec'] ?? '');
    $projectPath    = $info['project_path'];
    $prompt         = $info['prompt'];

    if ($mode === 'task' || $mode === 'team') {
        $extra = '';
        if ($mode === 'team' && $teamSpec !== '') {
            $extra .= ' -Team ' . psq($teamSpec);
        }
        if ($modelOverride !== '') {
            $extra .= ' -ModelOverride ' . psq($modelOverride);
        }
        if ($effortOverride !== '') {
            $extra .= ' -EffortOverride ' . psq($effortOverride);
        }
        if ($newSession) {
            $extra .= ' -NewSession';
        }
        $promptPart = ($promptFile !== null)
            ? (' -PromptFile ' . psq($promptFile))
            : (' -Prompt ' . psq($prompt));
        return sprintf(
            '& %s -Agent %s -Role %s -WorkDir %s%s%s',
            psq($scriptsDir . '\\invoke-agent.ps1'),
            psq($agent),
            psq($role),
            psq($projectPath),
            $extra,
            $promptPart
        );
    }

    if ($mode === 'claude') {
        $extra = ($role === 'reviewer') ? ' -IncludeGitDiff' : '';
        if ($modelOverride !== '') $extra .= ' -ModelOverride ' . psq($modelOverride);
        if ($effortOverride !== '') $extra .= ' -EffortOverride ' . psq($effortOverride);
        $promptPart = ($promptFile !== null)
            ? (' -PromptFile ' . psq($promptFile))
            : (' -Prompt ' . psq($prompt));
        return sprintf(
            '& %s -Role %s -WorkDir %s%s%s',
            psq($scriptsDir . '\\invoke-claude.ps1'),
            psq($role),
            psq($projectPath),
            $extra,
            $promptPart
        );
    }

    if ($mode === 'codex') {
        $extra = '';
        if ($modelOverride !== '') $extra .= ' -ModelOverride ' . psq($modelOverride);
        if ($effortOverride !== '') $extra .= ' -EffortOverride ' . psq($effortOverride);
        $promptPart = '';
        if ($prompt !== '') {
            $promptPart = ($promptFile !== null)
                ? (' -PromptFile ' . psq($promptFile))
                : (' -Prompt ' . psq($prompt));
        }
        return sprintf(
            '& %s -Role %s -WorkDir %s%s%s',
            psq($scriptsDir . '\\invoke-codex.ps1'),
            psq($role),
            psq($projectPath),
            $extra,
            $promptPart
        );
    }

    if ($mode === 'council') {
        if ($promptFile !== null && $prompt !== '') {
            return sprintf(
                '& %s -WorkDir %s -Prompt %s -PromptFile %s',
                psq($scriptsDir . '\\invoke-council-review.ps1'),
                psq($projectPath),
                psq(''),
                psq($promptFile)
            );
        }
        $effectivePrompt = $prompt !== '' ? $prompt : 'Review uncommitted changes against SPEC.md and score X/10.';
        return sprintf(
            '& %s -WorkDir %s -Prompt %s',
            psq($scriptsDir . '\\invoke-council-review.ps1'),
            psq($projectPath),
            psq($effectivePrompt)
        );
    }

    if ($mode === 'auto-gate') {
        $skipFlag = ($role === 'review-only') ? ' -SkipInitialImplement' : '';
        $promptPart = '';
        if ($prompt !== '') {
            $promptPart = ($promptFile !== null)
                ? (' -PromptFile ' . psq($promptFile))
                : (' -Prompt ' . psq($prompt));
        }
        return sprintf(
            '& %s -WorkDir %s -MaxRounds 2%s%s',
            psq($scriptsDir . '\\invoke-auto-gate.ps1'),
            psq($projectPath),
            $skipFlag,
            $promptPart
        );
    }

    if ($mode === 'spec-guard') {
        return sprintf(
            '& %s -WorkDir %s',
            psq($scriptsDir . '\\invoke-spec-guard.ps1'),
            psq($projectPath)
        );
    }

    // mode === 'antigravity'
    if (in_array($role, ['status', 'wait'], true)) {
        return sprintf(
            '& %s -Action %s -WorkDir %s',
            psq($scriptsDir . '\\invoke-antigravity.ps1'),
            psq($role),
            psq($projectPath)
        );
    }

    $modelArg = ($role === 'new' && $modelOverride !== '') ? (' -Model ' . psq($modelOverride)) : '';
    $promptPart = ($promptFile !== null)
        ? (' -PromptFile ' . psq($promptFile))
        : (' -Prompt ' . psq($prompt));
    return sprintf(
        '& %s -Action %s -WorkDir %s%s -Title %s%s',
        psq($scriptsDir . '\\invoke-antigravity.ps1'),
        psq($role),
        psq($projectPath),
        $modelArg,
        psq('Task from Mission Control'),
        $promptPart
    );
}

/**
 * Validates and builds PowerShell command + arguments for dispatch or run_job.
 */
function buildValidatedCommand(array $body, string $laragonWww, string $repoRoot, string $userProfile, string $scriptsDir): array {
    $mode = strtolower(trim((string)($body['mode'] ?? '')));
    $allowedModes = ['task', 'team', 'antigravity', 'claude', 'codex', 'council', 'auto-gate', 'spec-guard'];
    if (!in_array($mode, $allowedModes, true)) {
        respondJson([
            'ok' => false,
            'error' => 'Invalid mode. Must be one of: task, team, antigravity, claude, codex, council, auto-gate, spec-guard.',
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

    $allowedAgents = ['claude', 'antigravity', 'codex'];
    $agent = '';
    $role = strtolower(trim((string)($body['role'] ?? '')));
    $newSession = ($body['new_session'] ?? false) === true;
    $teamArray = null;
    $teamSpec = '';

    if ($mode === 'task') {
        $agent = strtolower(trim((string)($body['agent'] ?? '')));
        if (!in_array($agent, $allowedAgents, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid agent for task mode. Allowed: claude, antigravity, codex.'], 400);
        }
        $allowedTaskRoles = ['architect', 'backend', 'frontend', 'reviewer', 'tester'];
        if (!in_array($role, $allowedTaskRoles, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid role for task mode. Allowed: architect, backend, frontend, reviewer, tester.'], 400);
        }
    } elseif ($mode === 'team') {
        $agent = strtolower(trim((string)($body['agent'] ?? '')));
        if (!in_array($agent, $allowedAgents, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid leader agent for team mode. Allowed: claude, antigravity, codex.'], 400);
        }
        $role = 'leader';
        $rawTeam = $body['team'] ?? null;
        if (!is_array($rawTeam) || empty($rawTeam)) {
            respondJson(['ok' => false, 'error' => 'Team mode requires a non-empty team map (subset of backend, frontend, reviewer).'], 400);
        }
        $allowedTeamKeys = ['backend', 'frontend', 'reviewer'];
        $normalizedTeam = [];
        foreach ($rawTeam as $k => $v) {
            $kNorm = strtolower(trim((string)$k));
            $vNorm = is_string($v) ? strtolower(trim($v)) : '';
            if (!in_array($kNorm, $allowedTeamKeys, true)) {
                respondJson(['ok' => false, 'error' => "Invalid team slot '$kNorm'. Allowed keys: backend, frontend, reviewer."], 400);
            }
            if (!in_array($vNorm, $allowedAgents, true)) {
                respondJson(['ok' => false, 'error' => "Invalid agent '$vNorm' for team slot '$kNorm'. Allowed: claude, antigravity, codex."], 400);
            }
            $normalizedTeam[$kNorm] = $vNorm;
        }
        if (empty($normalizedTeam)) {
            respondJson(['ok' => false, 'error' => 'Team mode requires at least 1 valid team member.'], 400);
        }
        $teamArray = [];
        $teamParts = [];
        foreach ($allowedTeamKeys as $slotKey) {
            if (isset($normalizedTeam[$slotKey])) {
                $teamArray[$slotKey] = $normalizedTeam[$slotKey];
                $teamParts[] = $slotKey . '=' . $normalizedTeam[$slotKey];
            }
        }
        $teamSpec = implode(',', $teamParts);
    } else {
        $allowedRolesByMode = [
            'claude' => ['architect', 'leader', 'backend', 'frontend', 'reviewer', 'ui-tweak'],
            'codex' => ['review-diff', 'critic', 'coder'],
            'antigravity' => ['send-latest', 'new', 'status', 'wait'],
            'council' => ['parallel-review', 'reviewer', ''],
            'auto-gate' => ['auto-loop', 'review-only', ''],
            'spec-guard' => ['check', ''],
        ];

        if ($mode === 'claude') {
            $agent = 'claude';
            if (!in_array($role, $allowedRolesByMode['claude'], true)) {
                respondJson(['ok' => false, 'error' => 'Invalid role for claude. Allowed: architect, leader, backend, frontend, reviewer, ui-tweak.'], 400);
            }
        } elseif ($mode === 'codex') {
            $agent = 'codex';
            if ($role === '') $role = 'review-diff';
            if (!in_array($role, $allowedRolesByMode['codex'], true)) {
                respondJson(['ok' => false, 'error' => 'Invalid role for codex. Allowed: review-diff, critic, coder.'], 400);
            }
        } elseif ($mode === 'antigravity') {
            $agent = 'antigravity';
            if ($role === '') $role = 'send-latest';
            if (!in_array($role, $allowedRolesByMode['antigravity'], true)) {
                respondJson(['ok' => false, 'error' => 'Invalid role/action for antigravity. Allowed: send-latest, new, status, wait.'], 400);
            }
        } elseif ($mode === 'council') {
            $agent = 'council';
            if ($role === '' || $role === 'reviewer') $role = 'parallel-review';
            if (!in_array($role, $allowedRolesByMode['council'], true)) {
                respondJson(['ok' => false, 'error' => 'Invalid role for council. Allowed: parallel-review.'], 400);
            }
        } elseif ($mode === 'auto-gate') {
            $agent = 'auto-gate';
            if ($role === '') $role = 'auto-loop';
            if (!in_array($role, $allowedRolesByMode['auto-gate'], true)) {
                respondJson(['ok' => false, 'error' => 'Invalid role for auto-gate. Allowed: auto-loop, review-only.'], 400);
            }
        } elseif ($mode === 'spec-guard') {
            $agent = 'spec-guard';
            $role = 'check';
        }
    }

    $rawPrompt = $body['prompt'] ?? '';
    if (!is_string($rawPrompt)) {
        respondJson(['ok' => false, 'error' => 'Invalid prompt format: must be a string.'], 400);
    }
    $prompt = trim($rawPrompt);
    // SPEC §3.0 & B10: Prompt limit 20000 characters
    if (mb_strlen($prompt, 'UTF-8') > 20000) {
        respondJson(['ok' => false, 'error' => 'Prompt exceeds maximum length (20000 characters).'], 400);
    }

    $requiresPrompt = (
        $mode === 'task' ||
        $mode === 'team' ||
        $mode === 'claude' ||
        ($mode === 'codex' && in_array($role, ['critic', 'coder'], true)) ||
        ($mode === 'antigravity' && in_array($role, ['send-latest', 'new'], true)) ||
        ($mode === 'auto-gate' && $role === 'auto-loop')
    );
    if ($requiresPrompt && $prompt === '') {
        respondJson(['ok' => false, 'error' => 'Prompt is required for ' . $mode . ' (' . $role . ').'], 400);
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

    $execAgent = in_array($mode, ['task', 'team'], true) ? $agent : $mode;
    if ($execAgent === 'claude') {
        if (!in_array($modelOverride, $allowedClaudeModels, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid Claude model override.'], 400);
        }
        if (!in_array($effortOverride, $allowedClaudeEfforts, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid Claude effort override.'], 400);
        }
    } elseif ($execAgent === 'codex') {
        if (!in_array($modelOverride, $allowedCodexModels, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid Codex model override.'], 400);
        }
        if (!in_array($effortOverride, $allowedCodexEfforts, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid Codex effort override.'], 400);
        }
    } elseif ($execAgent === 'antigravity') {
        if (!in_array($modelOverride, $allowedAgyModels, true)) {
            respondJson(['ok' => false, 'error' => 'Invalid Antigravity model tier (allowed: pro, flash, flash_lite).'], 400);
        }
        if (in_array($mode, ['task', 'team'], true) && $modelOverride !== '' && !$newSession) {
            respondJson(['ok' => false, 'error' => 'Antigravity model tier override is only supported when new_session is true.'], 400);
        }
        if ($effortOverride !== '') {
            respondJson(['ok' => false, 'error' => 'Antigravity does not accept an effort override.'], 400);
        }
    }

    $info = [
        'mode' => $mode,
        'agent' => $agent,
        'role' => $role,
        'model' => $modelOverride,
        'effort' => $effortOverride,
        'new_session' => $newSession,
        'team' => $teamArray,
        'team_spec' => $teamSpec,
        'project_path' => $validatedProjectPath,
        'prompt' => $prompt,
    ];
    $info['command'] = buildPowerShellCall($info, $scriptsDir, null);
    return $info;
}

// ============================================================================
// ENDPOINT 1: GET ?action=status
// ============================================================================
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
    $projects = getLocalProjects($laragonWww);
    $defaultProjectPath = $projects[0]['path'] ?? $repoRoot;
    $detectedVersions = getDetectedToolVersions($userProfile);

    respondJson([
        'ok' => true,
        'api_version' => '2.2',
        'features' => ['agents'],
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
                'command' => '/multi-ai (alias: /claude-leader)',
                'role_summary' => 'Backend/Core Dev, Multi-Subagent Branch Coordinator & Context Filter',
            ],
            'claude' => [
                'installed' => $claudeInstalled,
                'version' => $detectedVersions['claude'],
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
                'command' => '/multi-ai (alias: /antigravity)',
                'role_summary' => 'Tech Lead, 100% Frontend UI Specialist & Code Grader',
            ],
            'codex' => [
                'installed' => $codexInstalled,
                'version' => $detectedVersions['codex'],
                'model' => 'gpt-6-sol (high)',
                'models' => $codexModels,
                'cli_models' => $codexModels,
                'efforts' => ['low', 'medium', 'high', 'xhigh'],
                'command' => '$multi-ai (alias: $multi-ai-leader)',
                'role_summary' => 'Security/Logic Critic, Native Diff Reviewer & Algorithm Coder',
            ],
        ],
        'conversations' => $conversations,
        'projects' => $projects,
        'git_info' => getProjectGitInfo($defaultProjectPath),
        'notify_config' => getPublicNotifyConfig($notifyCfgFile),
        'jobs' => getRecentJobs($jobsDir),
        'audit' => getAuditStats($auditFile),
    ]);
}

// ============================================================================
// ENDPOINT 2: GET ?action=git_info&project_path=...
// ============================================================================
if ($action === 'git_info') {
    if ($method !== 'GET') {
        respondJson(['ok' => false, 'error' => 'Method Not Allowed: Use GET for git_info.'], 405);
    }
    $rawPath = trim((string)($_GET['project_path'] ?? $repoRoot));
    $validPath = resolveProjectPath($rawPath, $laragonWww);
    if ($validPath === null) {
        respondJson(['ok' => false, 'error' => 'Invalid project_path.'], 400);
    }
    respondJson([
        'ok' => true,
        'project_path' => $validPath,
        'git_info' => getProjectGitInfo($validPath),
    ]);
}

// ============================================================================
// ENDPOINT 3: POST ?action=spec_guard (SPEC §3.3 & B6)
// ============================================================================
if ($action === 'spec_guard') {
    if ($method !== 'POST') {
        respondJson(['ok' => false, 'error' => 'Method Not Allowed: Use POST for spec_guard.'], 405);
    }
    $body = getJsonBody();
    $rawPath = trim((string)($body['project_path'] ?? $repoRoot));
    $validPath = resolveProjectPath($rawPath, $laragonWww);
    if ($validPath === null) {
        respondJson(['ok' => false, 'error' => 'Invalid project_path.'], 400);
    }

    $owner = strtolower(trim((string)($body['owner'] ?? '')));
    if (!in_array($owner, ['', 'antigravity', 'claude', 'codex'], true)) {
        respondJson(['ok' => false, 'error' => 'Invalid owner. Allowed: antigravity, claude, codex, or empty.'], 400);
    }

    $guardScript = $scriptsDir . '\\invoke-spec-guard.ps1';
    if (!is_file($guardScript)) {
        respondJson(['ok' => false, 'error' => 'invoke-spec-guard.ps1 not found.'], 500);
    }

    $ownerArg = ($owner !== '') ? (' -Owner ' . escapeshellarg($owner)) : '';
    $cmd = sprintf(
        'powershell -NoProfile -ExecutionPolicy Bypass -File %s -WorkDir %s%s -Json 2>&1',
        escapeshellarg($guardScript),
        escapeshellarg($validPath),
        $ownerArg
    );
    $out = (string)@shell_exec($cmd);
    $parsed = json_decode(trim($out), true);
    if (!is_array($parsed)) {
        respondJson([
            'ok' => false,
            'error' => 'Failed to parse SPEC Guard output.',
            'raw' => $out,
        ], 500);
    }
    respondJson($parsed);
}

// ============================================================================
// ENDPOINT 4: POST ?action=init_spec
// ============================================================================
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

    $gitInitialized = false;
    if (!is_dir($realTarget . '\\.git')) {
        $gitOut = [];
        $gitRc = 0;
        @exec('git -C ' . escapeshellarg($realTarget) . ' init 2>&1', $gitOut, $gitRc);
        if ($gitRc === 0 && is_dir($realTarget . '\\.git')) {
            $gitInitialized = true;
        }
    }

    $specDest = $realTarget . '\\SPEC.md';
    if (is_file($specDest)) {
        respondJson([
            'ok' => true,
            'created' => false,
            'git_initialized' => $gitInitialized,
            'spec_path' => $specDest,
            'message' => ($gitInitialized ? 'Initialized Git repository; ' : '') . 'SPEC.md already exists in ' . $projectName,
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
                'git_initialized' => $gitInitialized,
                'spec_path' => $specDest,
                'message' => ($gitInitialized ? 'Initialized Git repository; ' : '') . 'SPEC.md already exists in ' . $projectName,
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
        'git_initialized' => $gitInitialized,
        'spec_path' => $specDest,
        'message' => 'Successfully initialized ' . ($gitInitialized ? 'Git & ' : '') . 'SPEC.md in ' . $projectName,
    ]);
}

// ============================================================================
// ENDPOINT 5: POST ?action=dispatch (Command Builder + Antigravity Quick Send)
// ============================================================================
if ($action === 'dispatch') {
    if ($method !== 'POST') {
        respondJson(['ok' => false, 'error' => 'Method Not Allowed: Use POST for dispatch.'], 405);
    }

    $body = getJsonBody();
    $info = buildValidatedCommand($body, $laragonWww, $repoRoot, $userProfile, $scriptsDir);
    $mode = $info['mode'];
    $role = $info['role'];
    $modelOverride = $info['model'];
    $validatedProjectPath = $info['project_path'];
    $prompt = $info['prompt'];
    $cmd = $info['command'];

    $executeAntigravity = ($body['execute_antigravity'] ?? false) === true;
    if ($executeAntigravity) {
        if ($mode !== 'antigravity' || !in_array($role, ['send-latest', 'new'], true)) {
            respondJson(['ok' => false, 'error' => 'Live quick-send (execute_antigravity) is only for antigravity mode with send-latest or new. Use action=run_job for background streaming execution of any mode.'], 400);
        }
        if ($prompt === '') {
            respondJson(['ok' => false, 'error' => 'Prompt is required when execute_antigravity is true.'], 400);
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
        if (file_put_contents($tempPromptFile, "\xEF\xBB\xBF" . $prompt) === false) {
            respondJson(['ok' => false, 'error' => 'Failed to create temporary prompt file.'], 500);
        }

        $modelExecArg = ($role === 'new' && $modelOverride !== '') ? (' -Model ' . escapeshellarg($modelOverride)) : '';
        $execCmd = sprintf(
            'powershell -NoProfile -ExecutionPolicy Bypass -File %s -Action %s -WorkDir %s%s -NoWait -Title %s -PromptFile %s 2>&1',
            escapeshellarg($scriptsDir . '\\invoke-antigravity.ps1'),
            escapeshellarg($role),
            escapeshellarg($validatedProjectPath),
            $modelExecArg,
            escapeshellarg('Task from Mission Control'),
            escapeshellarg($tempPromptFile)
        );

        $outLines = [];
        $exitCode = 1;
        exec($execCmd, $outLines, $exitCode);
        @unlink($tempPromptFile);

        $dispatchOutput = trim(implode("\n", $outLines));
        $dispatched = ($exitCode === 0);

        if ($dispatched) {
            $inTokens = max(1, (int)ceil(strlen($prompt) / 3.8));
            appendAuditEntry($auditFile, [
                'Timestamp' => date('c'),
                'Tool' => 'antigravity',
                'Role' => $role,
                'Model' => $modelOverride ?: 'gemini-4-argon',
                'WorkDir' => $validatedProjectPath,
                'PromptChars' => strlen($prompt),
                'OutputChars' => strlen($dispatchOutput),
                'InputTokens' => $inTokens,
                'OutputTokens' => 120,
                'CostUsd' => round(($inTokens * 1.25 + 120 * 5.0) / 1000000.0, 5),
                'Score' => '',
                'Verdict' => 'COMPLETED',
            ]);
        } else {
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

// ============================================================================
// ENDPOINT 6: POST ?action=run_job (Live Web Job Runner for ALL Modes)
// ============================================================================
if ($action === 'run_job') {
    if ($method !== 'POST') {
        respondJson(['ok' => false, 'error' => 'Method Not Allowed: Use POST for run_job.'], 405);
    }

    $body = getJsonBody();
    $info = buildValidatedCommand($body, $laragonWww, $repoRoot, $userProfile, $scriptsDir);
    $mode = $info['mode'];
    $agent = $info['agent'] ?? ($mode ?: '');
    $role = $info['role'];
    $modelOverride = $info['model'];
    $effortOverride = $info['effort'];
    $newSession = (bool)($info['new_session'] ?? false);
    $teamArray = $info['team'] ?? null;
    $validatedProjectPath = $info['project_path'];
    $prompt = $info['prompt'];
    $cmd = $info['command'];

    if (!is_dir($jobsDir)) {
        @mkdir($jobsDir, 0777, true);
    }

    // B7 Cleanup: never delete files of a job whose meta says RUNNING and whose process is alive; age = newest mtime of its files
    $now = time();
    foreach (glob($jobsDir . '\\job_*.json') ?: [] as $metaPath) {
        $jid = pathinfo($metaPath, PATHINFO_FILENAME);
        $metaData = json_decode((string)@file_get_contents($metaPath), true);
        if (is_array($metaData) && ($metaData['status'] ?? '') === 'RUNNING') {
            $mPid = (int)($metaData['pid'] ?? 0);
            if ($mPid > 0 && isProcessRunning($mPid)) {
                continue;
            }
            if ($mPid <= 0 && ($now - (int)($metaData['started_ts'] ?? 0)) < 60) {
                continue;
            }
        }
        $relatedFiles = glob($jobsDir . '\\' . $jid . '.*') ?: [$metaPath];
        $newestMtime = 0;
        foreach ($relatedFiles as $rf) {
            $mt = (int)@filemtime($rf);
            if ($mt > $newestMtime) {
                $newestMtime = $mt;
            }
        }
        if ($newestMtime > 0 && ($now - $newestMtime) > 7200) {
            foreach ($relatedFiles as $rf) {
                @unlink($rf);
            }
        }
    }

    $jobId = 'job_' . date('Ymd_His') . '_' . bin2hex(random_bytes(3));
    $promptFile = $jobsDir . '\\' . $jobId . '.prompt.txt';
    $logFile    = $jobsDir . '\\' . $jobId . '.log';
    $runnerFile = $jobsDir . '\\' . $jobId . '.runner.ps1';
    $metaFile   = $jobsDir . '\\' . $jobId . '.json';

    file_put_contents($promptFile, "\xEF\xBB\xBF" . $prompt);
    $headerLine = sprintf(
        "=== [MISSION CONTROL JOB %s] ===\nMode: %s | Agent: %s | Role: %s | Project: %s\nStarted: %s\n------------------------------------------------------------\n",
        $jobId,
        strtoupper($mode),
        $agent,
        $role,
        $validatedProjectPath,
        date('Y-m-d H:i:s')
    );
    file_put_contents($logFile, "\xEF\xBB\xBF" . $headerLine);

    $innerCall = buildPowerShellCall($info, $scriptsDir, $promptFile);

    $notifyScript = $scriptsDir . '\\send-notification.ps1';
    $projShort = basename($validatedProjectPath);
    $runnerCode = sprintf(
        "\$ErrorActionPreference = 'Continue'\n" .
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" .
        "\$OutputEncoding = [System.Text.Encoding]::UTF8\n" .
        "\$logPath = %s\n" .
        "try {\n" .
        "    %s *>&1 | ForEach-Object {\n" .
        "        \$line = \$_.ToString()\n" .
        "        [System.IO.File]::AppendAllText(\$logPath, \$line + \"`r`n\", [System.Text.Encoding]::UTF8)\n" .
        "    }\n" .
        "    \$code = if (\$null -ne \$LASTEXITCODE) { [int]\$LASTEXITCODE } else { 0 }\n" .
        "} catch {\n" .
        "    [System.IO.File]::AppendAllText(\$logPath, \"[ERROR] \" + \$_.Exception.Message + \"`r`n\", [System.Text.Encoding]::UTF8)\n" .
        "    \$code = 1\n" .
        "}\n" .
        "[System.IO.File]::AppendAllText(\$logPath, \"`r`n=== [JOB_FINISHED exit_code=\$code] ===`r`n\", [System.Text.Encoding]::UTF8)\n" .
        "if (Test-Path -LiteralPath %s) {\n" .
        "    \$st = if (\$code -eq 0) { 'success' } else { 'warn' }\n" .
        "    & powershell -NoProfile -ExecutionPolicy Bypass -File %s -Title %s -Message \"Job %s (%s) finished with exit code \$code.\" -Status \$st | Out-Null\n" .
        "}\n" .
        "exit \$code\n",
        psq($logFile),
        $innerCall,
        psq($notifyScript),
        psq($notifyScript),
        psq("Mission Control: $projShort"),
        $mode,
        $role
    );
    file_put_contents($runnerFile, "\xEF\xBB\xBF" . $runnerCode);

    // R1: Launch outer PowerShell via -EncodedCommand (UTF-16LE base64) and pass -ArgumentList as ONE string so paths with spaces never split
    $outerPs = "\$argStr = '-NoProfile -ExecutionPolicy Bypass -File \"' + " . psq($runnerFile) . " + '\"'; "
             . "\$p = Start-Process -FilePath 'powershell.exe' -ArgumentList \$argStr -WindowStyle Hidden -PassThru; "
             . "Write-Output \$p.Id";
    $utf16Script = function_exists('mb_convert_encoding')
        ? mb_convert_encoding($outerPs, 'UTF-16LE', 'UTF-8')
        : (string)@iconv('UTF-8', 'UTF-16LE', $outerPs);
    $encodedCmd = base64_encode($utf16Script);
    $launchCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' . escapeshellarg($encodedCmd) . ' 2>&1';
    $pidOut = trim((string)@shell_exec($launchCmd));
    $pid = preg_match('/(\d+)/', $pidOut, $m) ? (int)$m[1] : 0;

    $meta = [
        'job_id' => $jobId,
        'pid' => $pid,
        'mode' => $mode,
        'agent' => $agent,
        'role' => $role,
        'model' => $modelOverride,
        'effort' => $effortOverride,
        'new_session' => $newSession,
        'project_path' => $validatedProjectPath,
        'command' => $cmd,
        'status' => 'RUNNING',
        'exit_code' => null,
        'started_at' => date('c'),
        'started_ts' => time(),
    ];
    if (is_array($teamArray)) {
        $meta['team'] = $teamArray;
    }
    file_put_contents($metaFile, json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

    $runResp = [
        'ok' => true,
        'job_id' => $jobId,
        'pid' => $pid,
        'mode' => $mode,
        'agent' => $agent,
        'role' => $role,
        'status' => 'RUNNING',
        'command' => $cmd,
    ];
    if (is_array($teamArray)) {
        $runResp['team'] = $teamArray;
    }
    respondJson($runResp);
}

// ============================================================================
// ENDPOINT 7: GET ?action=job_status&job_id=...&offset=0 (SPEC §3.7 & B7)
// ============================================================================
if ($action === 'job_status') {
    if ($method !== 'GET') {
        respondJson(['ok' => false, 'error' => 'Method Not Allowed: Use GET for job_status.'], 405);
    }

    $jobId = preg_replace('/[^a-zA-Z0-9_]/', '', (string)($_GET['job_id'] ?? ''));
    $offset = max(0, (int)($_GET['offset'] ?? 0));
    if ($jobId === '' || !str_starts_with($jobId, 'job_')) {
        respondJson(['ok' => false, 'error' => 'Invalid job_id.'], 400);
    }

    $metaFile = $jobsDir . '\\' . $jobId . '.json';
    $logFile  = $jobsDir . '\\' . $jobId . '.log';
    if (!is_file($metaFile)) {
        respondJson(['ok' => false, 'error' => 'Job not found: ' . $jobId], 404);
    }

    $meta = json_decode((string)@file_get_contents($metaFile), true) ?: [];
    $meta = refreshJobMetaStatus($meta, $jobsDir);

    $chunk = '';
    $nextOffset = $offset;
    $fullSize = 0;
    if (is_file($logFile)) {
        clearstatcache(true, $logFile);
        $fullSize = (int)@filesize($logFile);
        if ($fullSize > $offset) {
            $fp = @fopen($logFile, 'rb');
            if (is_resource($fp)) {
                fseek($fp, $offset);
                $readBytes = min($fullSize - $offset, 131072);
                $rawChunk = (string)fread($fp, $readBytes);
                fclose($fp);

                // Back off to the last complete UTF-8 character boundary (SPEC §3.7)
                $safeChunk = trimIncompleteUtf8Tail($rawChunk);
                $nextOffset = $offset + strlen($safeChunk);

                if ($offset === 0) {
                    $safeChunk = (string)preg_replace('/^\xEF\xBB\xBF/', '', $safeChunk);
                }
                $chunk = $safeChunk;
            }
        }
    }

    $elapsed = max(0, time() - (int)($meta['started_ts'] ?? time()));
    $statusResp = [
        'ok' => true,
        'job_id' => $jobId,
        'status' => $meta['status'] ?? 'UNKNOWN',
        'exit_code' => $meta['exit_code'] ?? null,
        'pid' => $meta['pid'] ?? 0,
        'mode' => $meta['mode'] ?? '',
        'agent' => $meta['agent'] ?? ($meta['mode'] ?? ''),
        'role' => $meta['role'] ?? '',
        'elapsed_sec' => $elapsed,
        'log_chunk' => $chunk,
        'next_offset' => $nextOffset,
        'full_log_size' => $fullSize,
    ];
    if (array_key_exists('team', $meta) && is_array($meta['team'])) {
        $statusResp['team'] = $meta['team'];
    }
    respondJson($statusResp);
}

// ============================================================================
// ENDPOINT 8: POST ?action=cancel_job (SPEC §3.8 & B7)
// ============================================================================
if ($action === 'cancel_job') {
    if ($method !== 'POST') {
        respondJson(['ok' => false, 'error' => 'Method Not Allowed: Use POST for cancel_job.'], 405);
    }
    $body = getJsonBody();
    $jobId = preg_replace('/[^a-zA-Z0-9_]/', '', (string)($body['job_id'] ?? ''));
    if ($jobId === '' || !str_starts_with($jobId, 'job_')) {
        respondJson(['ok' => false, 'error' => 'Invalid job_id.'], 400);
    }

    $metaFile = $jobsDir . '\\' . $jobId . '.json';
    $logFile  = $jobsDir . '\\' . $jobId . '.log';
    if (!is_file($metaFile)) {
        respondJson(['ok' => false, 'error' => 'Job not found.'], 404);
    }

    $meta = json_decode((string)@file_get_contents($metaFile), true) ?: [];
    $meta = refreshJobMetaStatus($meta, $jobsDir);
    if (($meta['status'] ?? '') !== 'RUNNING') {
        respondJson([
            'ok' => false,
            'error' => 'Job is not running.',
            'status' => $meta['status'] ?? 'UNKNOWN',
        ], 409);
    }

    $pid = (int)($meta['pid'] ?? 0);
    if ($pid > 0) {
        @shell_exec("taskkill /PID $pid /T /F 2>&1");
    }

    if (is_file($logFile)) {
        @file_put_contents($logFile, "\r\n=== [JOB_CANCELLED_BY_USER] ===\r\n", FILE_APPEND);
    }
    $meta['status'] = 'CANCELLED';
    $meta['exit_code'] = null;
    $meta['finished_at'] = date('c');
    @file_put_contents($metaFile, json_encode($meta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

    respondJson([
        'ok' => true,
        'job_id' => $jobId,
        'status' => 'CANCELLED',
    ]);
}

// ============================================================================
// ENDPOINT 9: POST ?action=save_notify & POST ?action=test_notify (SPEC §3.9, §3.10 & B8)
// ============================================================================
if ($action === 'save_notify') {
    if ($method !== 'POST') {
        respondJson(['ok' => false, 'error' => 'Method Not Allowed: Use POST for save_notify.'], 405);
    }
    $body = getJsonBody();
    $existing = loadInternalNotifyConfig($notifyCfgFile);

    $tokenToSave = $existing['telegram_bot_token'];
    if (array_key_exists('telegram_bot_token', $body) && $body['telegram_bot_token'] !== null) {
        if (!is_string($body['telegram_bot_token'])) {
            respondJson(['ok' => false, 'error' => 'Invalid telegram_bot_token: must be a string or null.'], 400);
        }
        $tokenToSave = trim($body['telegram_bot_token']);
    }

    $cfg = [
        'desktop_toast' => array_key_exists('desktop_toast', $body) ? (bool)$body['desktop_toast'] : $existing['desktop_toast'],
        'webhook_url' => array_key_exists('webhook_url', $body) ? trim((string)$body['webhook_url']) : $existing['webhook_url'],
        'telegram_bot_token' => $tokenToSave,
        'telegram_chat_id' => array_key_exists('telegram_chat_id', $body) ? trim((string)$body['telegram_chat_id']) : $existing['telegram_chat_id'],
    ];
    if ($cfg['webhook_url'] !== '' && !preg_match('#^https?://#i', $cfg['webhook_url'])) {
        respondJson(['ok' => false, 'error' => 'Webhook URL must start with http:// or https://'], 400);
    }
    $dir = dirname($notifyCfgFile);
    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }
    file_put_contents($notifyCfgFile, json_encode($cfg, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    respondJson(['ok' => true, 'notify_config' => getPublicNotifyConfig($notifyCfgFile)]);
}

if ($action === 'test_notify') {
    if ($method !== 'POST') {
        respondJson(['ok' => false, 'error' => 'Method Not Allowed: Use POST for test_notify.'], 405);
    }
    $notifyScript = $scriptsDir . '\\send-notification.ps1';
    if (!is_file($notifyScript)) {
        respondJson(['ok' => false, 'error' => 'send-notification.ps1 not found.'], 500);
    }
    $cmd = sprintf(
        'powershell -NoProfile -ExecutionPolicy Bypass -File %s -Title %s -Message %s -Status "success" -TestOnly 2>&1',
        escapeshellarg($notifyScript),
        escapeshellarg('Multi-AI Mission Control'),
        escapeshellarg('Test notification from Mission Control Dashboard succeeded!')
    );
    $out = trim((string)@shell_exec($cmd));
    $res = json_decode($out, true);
    respondJson([
        'ok' => true,
        'result' => is_array($res) ? $res : [
            'desktop_sent' => false,
            'webhook_configured' => false,
            'webhook_sent' => false,
            'telegram_configured' => false,
            'telegram_sent' => false,
            'errors' => ['raw' => $out],
        ],
    ]);
}

respondJson(['ok' => false, 'error' => 'Unsupported action: ' . $action], 400);
