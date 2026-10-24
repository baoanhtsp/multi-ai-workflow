import assert from 'node:assert/strict';
import child_process from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveServerPaths } from '../../../lib/paths.ts';
import { loadAgentRegistry } from '../../../lib/registry.ts';
import {
  collectAttentionItems,
  feature as policyFeature,
  generatePolicyBrief,
  type PolicyApproval,
  type PolicyViolation,
} from '../index.ts';
import {
  cleanPromptText,
  createDefaultPolicyConfig,
  redactSecrets,
  writeJsonAtomic,
} from '../lib/s4-core.ts';

function createTempPolicyEnv() {
  const tmp = path.win32.join(
    os.tmpdir(),
    `maw_test_pol_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  );
  fs.mkdirSync(tmp, { recursive: true });
  const mawHome = path.join(tmp, '.maw');
  const userProfile = path.join(tmp, 'user');
  const jobsDir = path.join(tmp, 'maw_jobs');
  const tempDir = path.join(tmp, 'temp');
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(userProfile, { recursive: true });
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const oldTemp = process.env.TEMP;
  const oldTmp = process.env.TMP;
  process.env.TEMP = tempDir;
  process.env.TMP = tempDir;

  const paths = resolveServerPaths({
    repoRoot: path.resolve(import.meta.dirname, '..', '..', '..', '..'),
    userProfile,
    mawHome,
  });
  paths.jobsDir = jobsDir;
  paths.tempDir = tempDir;

  const registry = loadAgentRegistry(paths);
  const startedJobs: Array<Record<string, unknown>> = [];
  const ctx = {
    paths,
    registry,
    readJobs: async () => [
      {
        job_id: 'job_src_1',
        agent: 'claude',
        role: 'backend',
        mode: 'task',
        project_path: tmp,
      },
    ],
    startJob: async (body: Record<string, unknown>) => {
      startedJobs.push(body);
      return { job_id: `job_rerun_${startedJobs.length}` };
    },
  };

  const cleanup = () => {
    process.env.TEMP = oldTemp;
    process.env.TMP = oldTmp;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  };

  return { tmp, paths, ctx, startedJobs, cleanup };
}

test('policy brief: idempotency, replaces existing block, and cleans cleanly', () => {
  const cfg = createDefaultPolicyConfig();
  cfg.global.deny_commands = ['git push --force'];
  cfg.global.approve_commands = ['rm -rf'];
  cfg.roles.reviewer = { read_only: true, deny_commands: ['git commit'] };

  // 1. Generate brief for reviewer
  const brief1 = generatePolicyBrief('reviewer', cfg, false);
  assert.ok(brief1.includes('<!-- MAW-S4-POLICY:BEGIN -->'));
  assert.ok(brief1.includes('## Policy for role reviewer'));
  assert.ok(brief1.includes('Never run: git push --force, git commit'));
  assert.ok(brief1.includes('Read-only role: do not write files.'));
  assert.ok(brief1.includes('<!-- MAW-S4-POLICY:END -->'));

  // 2. Prepended to user prompt
  const userPrompt = 'Please optimize database queries in server/db.ts';
  const fullPrompt = `${brief1}\n\n${userPrompt}`;

  // 3. cleanPromptText strips the policy block completely
  const cleaned = cleanPromptText(fullPrompt);
  assert.equal(cleaned, userPrompt);

  // 4. Regenerating brief and prepending again is idempotent
  const brief2 = generatePolicyBrief('reviewer', cfg, false);
  const fullPrompt2 = `${brief2}\n\n${cleanPromptText(fullPrompt)}`;
  assert.equal(cleanPromptText(fullPrompt2), userPrompt);

  // 5. Short form (prompt > 20000 chars)
  const shortBrief = generatePolicyBrief('reviewer', cfg, true);
  assert.ok(shortBrief.includes('Never modify:'));
  assert.ok(shortBrief.includes('Never run:'));
  assert.ok(!shortBrief.includes('Ask for approval before running:'));
  assert.ok(!shortBrief.includes('Read-only role:'));
});

test('approval flow: pending -> approve -> single-use consumption and rerun trigger', async () => {
  const { paths, ctx, startedJobs, cleanup } = createTempPolicyEnv();
  try {
    const policyDir = paths.featureDataDir('policy');
    const approvalsFile = path.join(policyDir, 'approvals.json');

    const cleanPrompt = 'Please drop old staging table';
    const role = 'backend';
    const promptSha256 = crypto
      .createHash('sha256')
      .update(`${cleanPrompt}:${role}`, 'utf8')
      .digest('hex');

    // 1. Create a pending approval
    const aprId = 'apr_test123';
    const initialApproval: PolicyApproval = {
      id: aprId,
      job_id: 'job_src_1',
      role,
      agent: 'claude',
      project: paths.projectsRoot,
      command: 'DROP TABLE',
      prompt_sha256: promptSha256,
      created_at: new Date().toISOString(),
      status: 'pending',
    };
    writeJsonAtomic(approvalsFile, [initialApproval]);

    // 2. Call policy_approve route with rerun = true
    const reqMock = {
      body: { id: aprId, rerun: true },
      url: new URL('http://localhost/api?action=policy_approve'),
      query: new URLSearchParams(),
      req: {} as any,
      res: {} as any,
      ctx,
    };
    const approveHandler = policyFeature.routes['policy_approve']!.handler;
    const res = (await approveHandler(ctx as any, reqMock as any)) as Record<string, unknown>;

    assert.equal(res.ok, true);
    assert.equal(res.job_id, 'job_rerun_1');
    assert.equal(startedJobs.length, 1);

    // Verify approval file updated to 'approved'
    const updatedApprovals = JSON.parse(fs.readFileSync(approvalsFile, 'utf8')) as PolicyApproval[];
    assert.equal(updatedApprovals[0]!.status, 'approved');

    // Item 4: Verify recovery item created in recovery.json
    const fallbackDir = paths.featureDataDir('fallback');
    const recFile = path.join(fallbackDir, 'recovery.json');
    const recData = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    assert.equal(recData.items.length, 1);
    const recItem = recData.items[0];
    assert.equal(recItem.kind, 'approval');
    assert.equal(recItem.status, 'started');
    assert.equal(recItem.source_job_id, 'job_src_1');
    assert.equal(recItem.root_job_id, 'job_src_1');
    assert.equal(recItem.new_job_id, 'job_rerun_1');

    // Item 4: Calling policy_approve again on non-pending returns 409
    await assert.rejects(
      async () => {
        await approveHandler(ctx as any, reqMock as any);
      },
      (err: any) => {
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes('cannot be approved'));
        return true;
      }
    );

    // Item 4: Calling policy_reject on non-pending returns 409
    const rejectHandler = policyFeature.routes['policy_reject']!.handler;
    const rejectReqMock = {
      body: { id: aprId },
      url: new URL('http://localhost/api?action=policy_reject'),
      query: new URLSearchParams(),
      req: {} as any,
      res: {} as any,
      ctx,
    };
    await assert.rejects(
      async () => {
        await rejectHandler(ctx as any, rejectReqMock as any);
      },
      (err: any) => {
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes('cannot be rejected'));
        return true;
      }
    );

    // Rejecting a pending item works, then rejecting again returns 409
    const aprId2 = 'apr_test_reject';
    const pendingApproval: PolicyApproval = {
      id: aprId2,
      job_id: 'job_src_2',
      role,
      agent: 'claude',
      project: paths.projectsRoot,
      command: 'DROP DATABASE',
      prompt_sha256: promptSha256,
      created_at: new Date().toISOString(),
      status: 'pending',
    };
    writeJsonAtomic(approvalsFile, [...updatedApprovals, pendingApproval]);

    const rejectRes = (await rejectHandler(
      ctx as any,
      { ...rejectReqMock, body: { id: aprId2 } } as any
    )) as Record<string, unknown>;
    assert.equal(rejectRes.ok, true);

    await assert.rejects(
      async () => {
        await rejectHandler(
          ctx as any,
          { ...rejectReqMock, body: { id: aprId2 } } as any
        );
      },
      (err: any) => {
        assert.equal(err.statusCode, 409);
        assert.ok(err.message.includes('cannot be rejected'));
        return true;
      }
    );
  } finally {
    cleanup();
  }
});

test('s4_attention: aggregates items from budget, fallback, approvals, violations, and gates, respecting dismissals and 7-day cutoff', () => {
  const { paths, ctx, cleanup } = createTempPolicyEnv();
  try {
    const policyDir = paths.featureDataDir('policy');
    const budgetDir = paths.featureDataDir('budget');
    const fallbackDir = paths.featureDataDir('fallback');
    const checksDir = paths.featureDataDir('checks');

    const now = new Date();

    // 1. Budget block
    const blocksFile = path.join(budgetDir, 'blocks.jsonl');
    const blockEntry = {
      ts: now.toISOString(),
      kind: 'budget_block',
      scope: 'day',
      agent: 'claude',
      job_id: 'job_b1',
      reason: 'Budget day exceeded',
    };
    fs.mkdirSync(budgetDir, { recursive: true });
    fs.writeFileSync(blocksFile, JSON.stringify(blockEntry) + '\n', 'utf8');

    // 2. Fallback suggested item
    const recFile = path.join(fallbackDir, 'recovery.json');
    const recData = {
      processed_jobs: [],
      items: [
        {
          id: 'rec_f1',
          created_at: now.toISOString(),
          kind: 'fallback_suggest',
          status: 'suggested',
          source_job_id: 'job_f1',
          agent: 'codex',
          fallback_agent: 'claude',
          reason: 'Rate limit',
        },
      ],
    };
    fs.mkdirSync(fallbackDir, { recursive: true });
    writeJsonAtomic(recFile, recData);

    // 3. Pending approval
    const aprFile = path.join(policyDir, 'approvals.json');
    const aprData: PolicyApproval[] = [
      {
        id: 'apr_p1',
        job_id: 'job_p1',
        role: 'backend',
        agent: 'claude',
        project: paths.projectsRoot,
        command: 'rm -rf /data',
        prompt_sha256: 'abcdef',
        created_at: now.toISOString(),
        status: 'pending',
      },
    ];
    fs.mkdirSync(policyDir, { recursive: true });
    writeJsonAtomic(aprFile, aprData);

    // 4. Open high violation
    const violFile = path.join(policyDir, 'violations.jsonl');
    const violData: PolicyViolation = {
      id: 'viol_v1',
      ts: now.toISOString(),
      job_id: 'job_v1',
      project: paths.projectsRoot,
      agent: 'claude',
      role: 'reviewer',
      kind: 'read_only_write',
      severity: 'high',
      detail: 'Read-only role modified file',
      resolved: false,
    };
    fs.writeFileSync(violFile, JSON.stringify(violData) + '\n', 'utf8');

    // 5. Red quality gate
    const summaryFile = path.join(checksDir, 'summary.json');
    fs.mkdirSync(checksDir, { recursive: true });
    writeJsonAtomic(summaryFile, {
      'C:\\my_project': { green: false, at: now.toISOString() },
    });

    // Collect all attention items
    const items = collectAttentionItems(ctx as any);

    assert.ok(items.length >= 5);
    assert.ok(items.some((it) => it.source === 'budget' && it.severity === 'error'));
    assert.ok(items.some((it) => it.source === 'fallback' && it.kind === 'fallback_suggest'));
    assert.ok(items.some((it) => it.source === 'policy' && it.kind === 'approval_pending'));
    assert.ok(items.some((it) => it.source === 'policy' && it.kind === 'policy_violation'));
    assert.ok(items.some((it) => it.source === 'checks' && it.kind === 'gate_red'));

    // Every item must have dismiss action
    for (const it of items) {
      assert.ok(it.actions && it.actions.some((a) => a.action === 's4_attention_dismiss'));
    }

    // Dismiss one item and verify it is excluded
    const dismissId = items[0]!.id;
    const dismissedFile = path.join(policyDir, 'attention-dismissed.json');
    writeJsonAtomic(dismissedFile, [dismissId]);

    const itemsAfterDismiss = collectAttentionItems(ctx as any);
    assert.ok(!itemsAfterDismiss.some((it) => it.id === dismissId));
    assert.equal(itemsAfterDismiss.length, items.length - 1);
  } finally {
    cleanup();
  }
});

test('HTTP status codes regression (Item 1): real HTTP server returns 400 on invalid budget_save and 404 on unknown recovery_cancel', async () => {
  const tmp = path.win32.join(
    os.tmpdir(),
    `maw_test_http_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  );
  fs.mkdirSync(tmp, { recursive: true });
  const mawHome = path.join(tmp, '.maw');
  const userProfile = path.join(tmp, 'user');
  const tempDir = path.join(tmp, 'temp');
  fs.mkdirSync(mawHome, { recursive: true });
  fs.mkdirSync(userProfile, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const oldTemp = process.env.TEMP;
  const oldTmp = process.env.TMP;
  process.env.TEMP = tempDir;
  process.env.TMP = tempDir;

  const { createMawHttpServer } = await import('../../../http.ts');
  const { server } = createMawHttpServer({
    repoRoot: path.resolve(import.meta.dirname, '..', '..', '..', '..'),
    userProfile,
    mawHome,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  const requestJson = async (
    action: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>
  ): Promise<{ statusCode: number; data: Record<string, unknown> }> => {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const req = http.request(
        `http://127.0.0.1:${port}/api?action=${action}`,
        {
          method,
          headers: {
            Host: `127.0.0.1:${port}`,
            'X-MAW-Request': '1',
            ...(method === 'POST'
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf8');
              const json = text ? JSON.parse(text) : {};
              resolve({ statusCode: res.statusCode || 200, data: json });
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };

  try {
    // 1. Invalid budget_save (warn > block) -> must return HTTP 400
    const badBudgetRes = await requestJson('budget_save', 'POST', {
      config: {
        version: 1,
        enabled: true,
        caps: {
          day: {
            usd: { warn: 50, block: 10 },
          },
        },
      },
    });
    assert.equal(badBudgetRes.statusCode, 400);
    assert.equal(badBudgetRes.data.ok, false);
    assert.ok(String(badBudgetRes.data.error).includes('caps.day.usd.warn'));

    // 2. Unknown recovery_cancel ID -> must return HTTP 404
    const notFoundRes = await requestJson('recovery_cancel', 'POST', {
      id: 'rec_nonexistent_xyz999',
    });
    assert.equal(notFoundRes.statusCode, 404);
    assert.equal(notFoundRes.data.ok, false);
    assert.ok(String(notFoundRes.data.error).includes('not found'));

    // 3. policy_approve and policy_reject on non-pending item -> must return HTTP 409
    const policyDir = path.join(mawHome, 'data', 'policy');
    fs.mkdirSync(policyDir, { recursive: true });
    const approvalsFile = path.join(policyDir, 'approvals.json');
    writeJsonAtomic(approvalsFile, [
      {
        id: 'apr_http_test',
        job_id: 'job_http_1',
        role: 'backend',
        agent: 'claude',
        project: tmp,
        command: 'DROP TABLE',
        prompt_sha256: 'abc',
        created_at: new Date().toISOString(),
        status: 'approved',
      },
    ]);

    const badApproveRes = await requestJson('policy_approve', 'POST', {
      id: 'apr_http_test',
    });
    assert.equal(badApproveRes.statusCode, 409);
    assert.equal(badApproveRes.data.ok, false);

    const badRejectRes = await requestJson('policy_reject', 'POST', {
      id: 'apr_http_test',
    });
    assert.equal(badRejectRes.statusCode, 409);
    assert.equal(badRejectRes.data.ok, false);
  } finally {
    process.env.TEMP = oldTemp;
    process.env.TMP = oldTmp;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  }
});

test('regression Item 5: policy_preview redacts project .env secrets and custom secret_patterns', async () => {
  const { tmp, ctx, cleanup } = createTempPolicyEnv();
  try {
    const projectDir = path.win32.join(tmp, 'my_proj');
    fs.mkdirSync(projectDir, { recursive: true });

    // 1. Create project .env file with a secret
    fs.writeFileSync(
      path.win32.join(projectDir, '.env'),
      'DATABASE_PASSWORD=SuperSecretPassw0rd!\nSTRIPE_KEY=sk_live_9999988888\n',
      'utf8'
    );

    // 2. Configure secret_patterns in policy config
    const policyDir = ctx.paths.featureDataDir('policy');
    fs.mkdirSync(policyDir, { recursive: true });
    const policyConfig = createDefaultPolicyConfig();
    policyConfig.global.secret_patterns = ['CUSTOM_API_TOKEN_[A-Za-z0-9]+'];
    writeJsonAtomic(path.win32.join(policyDir, 'policies.json'), policyConfig);

    // 3. Call policy_preview action handler
    const previewRoute = policyFeature.routes?.policy_preview;
    assert.ok(previewRoute);

    const inputPrompt =
      'Connect with SuperSecretPassw0rd! and custom token CUSTOM_API_TOKEN_xyz123 to proceed';
    const mockReq = {
      ...ctx,
      body: {
        role: 'backend',
        project_path: projectDir,
        text: inputPrompt,
      },
    } as any;
    const res = (await previewRoute.handler(mockReq, mockReq)) as any;

    assert.ok(res);
    assert.equal(res.ok, true);
    assert.ok(res.redacted, 'redacted text must be returned');

    // Verify .env secret was redacted
    assert.ok(
      !res.redacted.includes('SuperSecretPassw0rd!'),
      'SuperSecretPassw0rd! must be redacted'
    );
    assert.ok(
      res.redacted.includes('[REDACTED:ENV]') || res.redacted.includes('[REDACTED'),
      'must include redacted tag'
    );

    // Verify custom secret pattern was redacted
    assert.ok(
      !res.redacted.includes('CUSTOM_API_TOKEN_xyz123'),
      'CUSTOM_API_TOKEN_xyz123 must be redacted'
    );
  } finally {
    cleanup();
  }
});

