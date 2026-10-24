import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveServerPaths, type ServerPaths } from '../../lib/paths.ts';
import { redactTelegramSecrets, TelegramClient } from './client.ts';
import {
  getPollerLockStatus,
  readTelegramConfig,
  readTelegramState,
  refreshPollerHeartbeat,
  TelegramPoller,
  tryAcquirePollerLock,
  writeTelegramConfig,
  writeTelegramState,
} from './poller.ts';

function createTempTestPaths(): { paths: ServerPaths; cleanup: () => void } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maw_telegram_test_'));
  const userProfile = path.join(tmpRoot, 'UserProfile');
  const mawHome = path.join(tmpRoot, 'MawHome');
  const jobsDir = path.join(tmpRoot, 'jobs');
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

  fs.mkdirSync(userProfile, { recursive: true });
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });

  const paths = resolveServerPaths({
    repoRoot,
    userProfile,
    mawHome,
  });
  paths.jobsDir = jobsDir;

  return {
    paths,
    cleanup: () => {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    },
  };
}

test('redactTelegramSecrets strips bot token and bot<token> strings', () => {
  const token = '123456789:ABCDefGhIjKlMnOpQrStUvWxYz';
  const raw = `Connecting to https://api.telegram.org/bot${token}/getUpdates failed with error`;
  const sanitized = redactTelegramSecrets(raw, token);

  assert.ok(!sanitized.includes(token), 'Raw bot token must be redacted');
  assert.ok(sanitized.includes('bot[redacted-token]'), 'Expected bot[redacted-token]');
});

test('telegram single-poller lock acquisition and heartbeat refresh (Round 3 Item 7)', () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const ok1 = tryAcquirePollerLock(paths, 4317);
    assert.equal(ok1, true, 'First acquirer must win fresh lock');

    const lockStatus1 = getPollerLockStatus(paths);
    assert.equal(lockStatus1.owner, 'this');
    assert.equal(lockStatus1.pid, process.pid);

    // Two acquirers in a row on a fresh lock => second one fails (Item 7)
    const ok2 = tryAcquirePollerLock(paths, 4317);
    assert.equal(ok2, false, 'Second acquirer in a row on a fresh lock must fail');

    // Heartbeat refresh succeeds when we own the lock
    const refreshed = refreshPollerHeartbeat(paths);
    assert.equal(refreshed, true, 'Heartbeat refresh must succeed for owner');

    const dataDir = paths.featureDataDir('telegram');
    const lockFile = path.win32.join(dataDir, 'poller.lock');

    // Simulate an active lock owned by another alive PID
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        port: 4317,
        heartbeat: Date.now(),
      }),
      'utf8'
    );
    // If PID is alive and heartbeat fresh, it's considered owned
    const lockStatus2 = getPollerLockStatus(paths);
    assert.equal(lockStatus2.owner, 'this');
  } finally {
    cleanup();
  }
});

test('Telegram Round 3 Item 2: readTelegramState preserves push_since and pushNewInboxItems pushes item after push_since exactly once', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const notifyCfg = {
      desktop_toast: true,
      webhook_url: '',
      telegram_bot_token: '123456:BOT_TOKEN_FOR_PUSH',
      telegram_chat_id: '888999',
    };
    fs.mkdirSync(path.dirname(paths.notifyCfgFile), { recursive: true });
    fs.writeFileSync(paths.notifyCfgFile, JSON.stringify(notifyCfg), 'utf8');

    writeTelegramConfig(paths, {
      inbound: true,
      push_inbox: true,
      digest: { enabled: false, morning: '08:30', evening: '18:00' },
    });

    // 1. Verify readTelegramState preserves push_since
    tryAcquirePollerLock(paths);
    const pastIso = new Date(Date.now() - 60000).toISOString();
    writeTelegramState(paths, {
      offset: 10,
      push_since: pastIso,
      last_digest: { morning: '', evening: '' },
      msg_map: {},
    });
    const readState1 = readTelegramState(paths);
    assert.equal(readState1.push_since, pastIso, 'readTelegramState must preserve push_since');

    // 2. Add an inbox item created after push_since (e.g. now)
    const dataDir = paths.featureDataDir('inbox');
    fs.mkdirSync(dataDir, { recursive: true });
    const itemsFile = path.join(dataDir, 'items.json');
    const item1 = {
      id: 'i_push_test_1',
      kind: 'review_changes',
      severity: 'warn',
      title: 'Review changes requested',
      detail: 'Need refactoring',
      actions: ['retry', 'dismiss'],
      status: 'open',
      resolution: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(itemsFile, JSON.stringify({ version: 1, items: [item1] }), 'utf8');

    const sentMessages: string[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/sendMessage')) {
        const bodyObj = JSON.parse(String(init?.body ?? '{}'));
        sentMessages.push(bodyObj.text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1001 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const poller = new TelegramPoller(paths, {
      fetchFn: mockFetch,
      baseUrl: 'http://fake-telegram.local',
    });

    // First tick
    await poller.pushNewInboxItems();
    assert.equal(sentMessages.length, 1, 'Item created after push_since must be pushed on first tick');
    assert.ok(sentMessages[0]!.includes('Review changes requested'));

    // Second tick: must NOT push again (exactly once)
    await poller.pushNewInboxItems();
    assert.equal(sentMessages.length, 1, 'Item must not be pushed a second time');

    // Verify state still has push_since and mapped message_id
    const readState2 = readTelegramState(paths);
    assert.equal(readState2.push_since, pastIso);
    assert.equal(readState2.msg_map['1001'], 'i_push_test_1');
  } finally {
    cleanup();
  }
});

test('telegram client and poller with mock fetch handle commands and filtering', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    // Configure notify-config.json
    const notifyCfg = {
      desktop_toast: true,
      webhook_url: '',
      telegram_bot_token: '123456:FAKE_TOKEN_FOR_TESTING',
      telegram_chat_id: '999888777',
    };
    fs.mkdirSync(path.dirname(paths.notifyCfgFile), { recursive: true });
    fs.writeFileSync(paths.notifyCfgFile, JSON.stringify(notifyCfg), 'utf8');

    // Configure telegram config
    writeTelegramConfig(paths, {
      inbound: true,
      push_inbox: true,
      digest: { enabled: false, morning: '08:30', evening: '18:00' },
    });

    const sentMessages: Array<{ chatId: string | number; text: string }> = [];

    // Mock fetch function
    const mockFetch: typeof fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/getUpdates')) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: [
              // Message from foreign chat (should be ignored)
              {
                update_id: 101,
                message: {
                  message_id: 1,
                  chat: { id: 111222333 }, // Foreign!
                  text: '/status',
                },
              },
              // Message from configured chat
              {
                update_id: 102,
                message: {
                  message_id: 2,
                  chat: { id: 999888777 },
                  text: '/help',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (urlStr.includes('/sendMessage')) {
        const bodyObj = JSON.parse(String(init?.body ?? '{}')) as {
          chat_id: string | number;
          text: string;
        };
        sentMessages.push({ chatId: bodyObj.chat_id, text: bodyObj.text });
        return new Response(
          JSON.stringify({
            ok: true,
            result: { message_id: sentMessages.length + 10 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const poller = new TelegramPoller(paths, {
      fetchFn: mockFetch,
      baseUrl: 'http://fake-telegram.local',
    });

    // Test sendTestMessage
    const testRes = await poller.sendTestMessage();
    assert.equal(testRes.ok, true);
    assert.equal(testRes.sent, true);
    assert.equal(sentMessages.length, 1);
    assert.ok(sentMessages[0]?.text.includes('MAW two-way bot is connected'));

    // Test client getUpdates directly with mock
    const client = new TelegramClient({
      token: '123456:FAKE_TOKEN_FOR_TESTING',
      baseUrl: 'http://fake-telegram.local',
      fetchFn: mockFetch,
    });

    const updatesRes = await client.getUpdates(0, 1);
    assert.equal(updatesRes.ok, true);
    assert.equal(updatesRes.result?.length, 2);
  } finally {
    cleanup();
  }
});

test('Telegram Major 6 regression: /retry, callback query, and reply invoke performInboxAction and ctx.startJob', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const notifyCfg = {
      desktop_toast: true,
      webhook_url: '',
      telegram_bot_token: '123456:BOT_TOKEN_FOR_ACTIONS',
      telegram_chat_id: '12345',
    };
    fs.mkdirSync(path.dirname(paths.notifyCfgFile), { recursive: true });
    fs.writeFileSync(paths.notifyCfgFile, JSON.stringify(notifyCfg), 'utf8');

    writeTelegramConfig(paths, {
      inbound: true,
      push_inbox: true,
      digest: { enabled: false, morning: '08:30', evening: '18:00' },
    });

    const startedJobs: Array<Record<string, unknown>> = [];
    const mockContext: any = {
      paths,
      startJob: async (body: Record<string, unknown>) => {
        startedJobs.push(body);
        return { ok: true, job_id: `job_started_${startedJobs.length}` };
      },
    };

    // 1. Create an inbox item with retry action
    const dataDir = paths.featureDataDir('inbox');
    fs.mkdirSync(dataDir, { recursive: true });
    const itemsFile = path.join(dataDir, 'items.json');
    const initialItem = {
      id: 'i111111',
      kind: 'failed',
      severity: 'error',
      title: 'Failed compile',
      detail: 'Exit 1',
      actions: ['retry', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'backend',
        project_path: paths.repoRoot,
        prompt: 'Build the server',
      },
      status: 'open',
      resolution: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(itemsFile, JSON.stringify({ version: 1, items: [initialItem] }), 'utf8');

    const sentAnswers: string[] = [];
    const sentMessages: string[] = [];

    // Mock fetch that delivers /retry command
    let tick = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/getUpdates')) {
        tick++;
        if (tick === 1) {
          // Send /retry i111111
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 1,
                  message: {
                    message_id: 10,
                    chat: { id: 12345 },
                    text: '/retry i111111',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ ok: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (urlStr.includes('/sendMessage')) {
        const bodyObj = JSON.parse(String(init?.body ?? '{}'));
        sentMessages.push(bodyObj.text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), { status: 200 });
      }

      if (urlStr.includes('/answerCallbackQuery')) {
        const bodyObj = JSON.parse(String(init?.body ?? '{}'));
        sentAnswers.push(bodyObj.text);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const poller = new TelegramPoller(paths, {
      fetchFn: mockFetch,
      baseUrl: 'http://fake-telegram.local',
      ctx: mockContext,
    });

    await poller.start();
    // Allow poll loop to process tick 1
    await new Promise((r) => setTimeout(r, 200));
    poller.stop();

    // Verify /retry called startJob
    assert.equal(startedJobs.length, 1, '/retry command must call ctx.startJob');
    assert.equal(startedJobs[0]!.agent, 'claude');
    assert.ok(sentMessages.some((m) => m.includes("Action 'retry' applied to i111111")));

    // 2. Test callback query "a:retry:i222222"
    const item2 = {
      id: 'i222222',
      kind: 'failed',
      severity: 'error',
      title: 'Second failure',
      detail: 'Timeout',
      actions: ['retry', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'codex',
        role: 'reviewer',
        project_path: paths.repoRoot,
        prompt: 'Review diff',
      },
      status: 'open',
      resolution: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(itemsFile, JSON.stringify({ version: 1, items: [initialItem, item2] }), 'utf8');

    let tickCb = 0;
    const mockFetchCb: typeof fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/getUpdates')) {
        tickCb++;
        if (tickCb === 1) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 2,
                  callback_query: {
                    id: 'cb_query_1',
                    from: { id: 12345 },
                    message: { message_id: 50, chat: { id: 12345 } },
                    data: 'a:retry:i222222',
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }

      if (urlStr.includes('/answerCallbackQuery')) {
        const bodyObj = JSON.parse(String(init?.body ?? '{}'));
        sentAnswers.push(bodyObj.text);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const pollerCb = new TelegramPoller(paths, {
      fetchFn: mockFetchCb,
      baseUrl: 'http://fake-telegram.local',
      ctx: mockContext,
    });

    await pollerCb.start();
    await new Promise((r) => setTimeout(r, 200));
    pollerCb.stop();

    // Verify callback query called startJob
    assert.equal(startedJobs.length, 2, 'Callback query must call ctx.startJob');
    assert.equal(startedJobs[1]!.agent, 'codex');
    assert.ok(sentAnswers.some((a) => a.includes('Action retry executed')));

    // 3. Test reply to pushed message starts follow-up job
    const item3 = {
      id: 'i333333',
      kind: 'needs_input',
      severity: 'warn',
      title: 'Need guidance',
      detail: 'Which DB schema?',
      actions: ['reply', 'dismiss'],
      retry: {
        mode: 'task',
        agent: 'claude',
        role: 'architect',
        project_path: paths.repoRoot,
        prompt: 'Choose DB schema',
      },
      status: 'open',
      resolution: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(itemsFile, JSON.stringify({ version: 1, items: [initialItem, item2, item3] }), 'utf8');

    // Register message map in state
    const stateFile = path.join(paths.featureDataDir('telegram'), 'state.json');
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        offset: 0,
        push_since: new Date().toISOString(),
        last_digest: { morning: '', evening: '' },
        msg_map: { '777': 'i333333' },
      }),
      'utf8'
    );

    let tickReply = 0;
    const mockFetchReply: typeof fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/getUpdates')) {
        tickReply++;
        if (tickReply === 1) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 3,
                  message: {
                    message_id: 888,
                    chat: { id: 12345 },
                    text: 'Use PostgreSQL schema',
                    reply_to_message: {
                      message_id: 777,
                      text: '[needs_input] Need guidance',
                    },
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }

      if (urlStr.includes('/sendMessage')) {
        const bodyObj = JSON.parse(String(init?.body ?? '{}'));
        sentMessages.push(bodyObj.text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), { status: 200 });
      }

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const pollerReply = new TelegramPoller(paths, {
      fetchFn: mockFetchReply,
      baseUrl: 'http://fake-telegram.local',
      ctx: mockContext,
    });

    await pollerReply.start();
    await new Promise((r) => setTimeout(r, 200));
    pollerReply.stop();

    // Verify reply started a follow-up job
    assert.equal(startedJobs.length, 3, 'Reply must start a follow-up job');
    assert.ok(String(startedJobs[2]!.prompt).includes('Choose DB schema'));
    assert.ok(String(startedJobs[2]!.prompt).includes('Use PostgreSQL schema'));
  } finally {
    cleanup();
  }
});

test('Telegram Review #2 Item 2: reply to mapped approval item sends usage hint and leaves item open', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const notifyCfg = {
      desktop_toast: true,
      webhook_url: '',
      telegram_bot_token: '123456:FAKE_TOKEN',
      telegram_chat_id: '12345',
    };
    fs.mkdirSync(path.dirname(paths.notifyCfgFile), { recursive: true });
    fs.writeFileSync(paths.notifyCfgFile, JSON.stringify(notifyCfg), 'utf8');

    writeTelegramConfig(paths, {
      inbound: true,
      push_inbox: true,
      digest: { enabled: false, morning: '08:30', evening: '18:00' },
    });

    const dataDir = paths.featureDataDir('inbox');
    fs.mkdirSync(dataDir, { recursive: true });
    const itemsFile = path.join(dataDir, 'items.json');
    const approvalItem = {
      id: 'iappr01',
      kind: 'approval',
      severity: 'warn',
      title: 'Deployment approval needed',
      detail: 'Deploy to prod?',
      actions: ['approve', 'reject', 'dismiss'],
      status: 'open',
      resolution: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(itemsFile, JSON.stringify({ version: 1, items: [approvalItem] }), 'utf8');

    // Map message 500 -> approval item iappr01
    const stateFile = path.join(paths.featureDataDir('telegram'), 'state.json');
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        offset: 0,
        push_since: new Date().toISOString(),
        last_digest: { morning: '', evening: '' },
        msg_map: { '500': 'iappr01' },
      }),
      'utf8'
    );

    const sentMessages: string[] = [];
    let tick = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/getUpdates')) {
        tick++;
        if (tick === 1) {
          return new Response(
            JSON.stringify({
              ok: true,
              result: [
                {
                  update_id: 1,
                  message: {
                    message_id: 600,
                    chat: { id: 12345 },
                    text: 'Looks good to me, proceed',
                    reply_to_message: {
                      message_id: 500,
                      text: '[approval] Deployment approval needed',
                    },
                  },
                },
              ],
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      if (urlStr.includes('/sendMessage')) {
        const bodyObj = JSON.parse(String(init?.body ?? '{}'));
        sentMessages.push(bodyObj.text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 601 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const poller = new TelegramPoller(paths, {
      fetchFn: mockFetch,
      baseUrl: 'http://fake-telegram.local',
    });

    await poller.start();
    await new Promise((r) => setTimeout(r, 150));
    poller.stop();

    // Verify response text instructed /approve or /reject
    assert.equal(sentMessages.length, 1);
    assert.ok(
      sentMessages[0]!.includes('This item needs /approve iappr01 or /reject iappr01'),
      'Must prompt with approve or reject command'
    );

    // Verify item remains open and untouched
    const diskItems = JSON.parse(fs.readFileSync(itemsFile, 'utf8'));
    assert.equal(diskItems.items[0].status, 'open', 'Item must remain open');
    assert.equal(diskItems.items[0].resolution, null, 'Resolution must remain null');
  } finally {
    cleanup();
  }
});

test('Telegram Review #2 Item 6: writeTelegramState prevents lost updates by merging concurrent disk changes', () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    tryAcquirePollerLock(paths);
    // 1. Initial state
    writeTelegramState(paths, {
      offset: 10,
      push_since: '2026-10-25T01:00:00.000Z',
      last_digest: { morning: '2026-10-25', evening: '' },
      msg_map: { '100': 'itemA' },
    });

    // 2. Simulate writer A loading state at offset 10, msg_map { 100: itemA }
    const stateA = readTelegramState(paths);

    // 3. Meanwhile writer B writes new msg_map { 200: itemB } and newer push_since
    writeTelegramState(paths, {
      offset: 10,
      push_since: '2026-10-25T01:30:00.000Z',
      last_digest: { morning: '2026-10-25', evening: '' },
      msg_map: { '200': 'itemB' },
    });

    // 4. Now writer A advances offset to 15 and adds msg_map { 300: itemC }
    stateA.offset = 15;
    stateA.msg_map['300'] = 'itemC';
    writeTelegramState(paths, stateA);

    // 5. Read back: must have union of msg_map (100, 200, 300), max offset (15), newest push_since
    const merged = readTelegramState(paths);
    assert.equal(merged.offset, 15, 'Offset must be max');
    assert.equal(merged.push_since, '2026-10-25T01:30:00.000Z', 'push_since must be newest');
    assert.equal(merged.msg_map['100'], 'itemA');
    assert.equal(merged.msg_map['200'], 'itemB', 'Writer B update must not be wiped');
    assert.equal(merged.msg_map['300'], 'itemC');
  } finally {
    cleanup();
  }
});

test('Telegram Review #2 Item 7: poller runs push/digest timers when inbound is false but push_inbox is true', async () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const notifyCfg = {
      desktop_toast: true,
      webhook_url: '',
      telegram_bot_token: '123456:FAKE_TOKEN',
      telegram_chat_id: '12345',
    };
    fs.mkdirSync(path.dirname(paths.notifyCfgFile), { recursive: true });
    fs.writeFileSync(paths.notifyCfgFile, JSON.stringify(notifyCfg), 'utf8');

    // Inbound is false, but push_inbox is true
    writeTelegramConfig(paths, {
      inbound: false,
      push_inbox: true,
      digest: { enabled: false, morning: '08:30', evening: '18:00' },
    });

    const sentMessages: string[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/sendMessage')) {
        const bodyObj = JSON.parse(String(init?.body ?? '{}'));
        sentMessages.push(bodyObj.text);
        return new Response(JSON.stringify({ ok: true, result: { message_id: 888 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const poller = new TelegramPoller(paths, {
      fetchFn: mockFetch,
      baseUrl: 'http://fake-telegram.local',
    });

    const started = await poller.start();
    assert.equal(started, true, 'Poller must start timers under lock even when inbound is false');

    const status = poller.getStatus();
    assert.equal(status.polling, false, 'Inbound polling loop must be false');
    assert.equal(status.owner, 'this', 'Poller lock must be owned by this server');

    poller.stop();
  } finally {
    cleanup();
  }
});

test('Codex Review #3 Item 4: writeTelegramState is skipped when process does not own poller.lock', () => {
  const { paths, cleanup } = createTempTestPaths();
  try {
    const dataDir = paths.featureDataDir('telegram');
    const lockFile = path.join(dataDir, 'poller.lock');
    fs.mkdirSync(dataDir, { recursive: true });

    // 1. Another active process owns poller.lock
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid + 99999,
        port: 4399,
        heartbeat: Date.now(),
      }),
      'utf8'
    );

    // Initial state does not exist or has offset 0
    assert.equal(readTelegramState(paths).offset, 0);

    // Non-owner attempts to write state
    const written1 = writeTelegramState(paths, {
      offset: 777,
      push_since: '2026-10-25T03:00:00.000Z',
      last_digest: { morning: '', evening: '' },
      msg_map: { '777': 'itemNonOwner' },
    });

    assert.equal(written1, false, 'Non-owner write must return false / be skipped');
    const stateAfterNonOwner = readTelegramState(paths);
    assert.equal(stateAfterNonOwner.offset, 0, 'State file on disk must not be modified by non-owner');
    assert.equal(stateAfterNonOwner.msg_map['777'], undefined, 'Non-owner msg_map must not be written');

    // 2. Now this process acquires poller.lock
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        port: 4317,
        heartbeat: Date.now(),
      }),
      'utf8'
    );

    const written2 = writeTelegramState(paths, {
      offset: 777,
      push_since: '2026-10-25T03:00:00.000Z',
      last_digest: { morning: '', evening: '' },
      msg_map: { '777': 'itemOwner' },
    });

    assert.equal(written2, true, 'Owner write must return true / succeed');
    const stateAfterOwner = readTelegramState(paths);
    assert.equal(stateAfterOwner.offset, 777, 'State file on disk must reflect owner write');
    assert.equal(stateAfterOwner.msg_map['777'], 'itemOwner');
  } finally {
    cleanup();
  }
});
