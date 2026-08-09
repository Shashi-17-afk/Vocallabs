const { Client: PgClient } = require('pg');
const fs = require('fs');
const path = require('path');

// Read .env.local
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        process.env[key] = val;
      }
    }
  }
}

async function runPhase8Suite() {
  console.log('================================================================');
  console.log('  PHASE 8 WORKFLOW EXECUTION ENGINE & RETRY TEST SUITE');
  console.log('================================================================\n');

  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  const dbUrl = process.env.DATABASE_URL;

  const pgClient = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const owner_id = '11111111-2222-3333-4444-555555555555';
  const editor_id = '66666666-7777-8888-9999-000000000000';
  const ts = Date.now();

  console.log('Setting up Test Organization and Workflow in Database...');
  await pgClient.query('BEGIN');

  const orgRes = await pgClient.query(`INSERT INTO public.organizations (name, quota_limit) VALUES ($1, 100) RETURNING id;`, [`Phase 8 Org Engine ${ts}`]);
  const org_id = orgRes.rows[0].id;

  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner');", [org_id, owner_id]);
  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'editor');", [org_id, editor_id]);

  await pgClient.query('COMMIT');

  async function executeApi(endpoint, userId, body, queryParams = '') {
    const res = await fetch(`http://localhost:3000/api/${endpoint}${queryParams}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-user-id': userId,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
  }

  const results = [];

  // =================================================================
  // 1. Full Multi-Step Execution Loop (llm_call, http_request, db_write, notify, conditional_branch)
  // =================================================================
  console.log('--- Test 1: Full Multi-Step Execution Loop ---');
  await pgClient.query('BEGIN');
  const wf1Res = await pgClient.query(`INSERT INTO public.workflows (org_id, name, created_by) VALUES ($1, 'Full Multi-Step Workflow', $2) RETURNING id;`, [org_id, owner_id]);
  const wf1_id = wf1Res.rows[0].id;

  await pgClient.query(`INSERT INTO public.workflow_steps (workflow_id, position, type, name, config) VALUES ($1, 1, 'llm_call', 'Step 1 LLM', '{"prompt": "Generate summary"}'::jsonb);`, [wf1_id]);
  await pgClient.query(`INSERT INTO public.workflow_steps (workflow_id, position, type, name, config) VALUES ($1, 2, 'http_request', 'Step 2 HTTP', '{"url": "https://httpbin.org/get", "method": "GET"}'::jsonb);`, [wf1_id]);
  await pgClient.query(`INSERT INTO public.workflow_steps (workflow_id, position, type, name, config) VALUES ($1, 3, 'db_write', 'Step 3 DB', '{"table": "audit_logs", "payload": {"action": "summary_generated"}}'::jsonb);`, [wf1_id]);
  await pgClient.query(`INSERT INTO public.workflow_steps (workflow_id, position, type, name, config) VALUES ($1, 4, 'notify', 'Step 4 Notify', '{"channel": "slack", "message": "Summary ready: {{Step 1 LLM.completion}}"}'::jsonb);`, [wf1_id]);
  await pgClient.query(`INSERT INTO public.workflow_steps (workflow_id, position, type, name, config) VALUES ($1, 5, 'conditional_branch', 'Step 5 Branch', '{"condition": "{{Step 1 LLM.tokens_used}} > 0"}'::jsonb);`, [wf1_id]);
  await pgClient.query('COMMIT');

  const triggerRes1 = await executeApi('actions/trigger-workflow', owner_id, { workflow_id: wf1_id });
  const run1_id = triggerRes1.data?.run_id;
  console.log('Triggered Run ID:', run1_id);

  const run1Query = await pgClient.query(`SELECT status FROM public.workflow_runs WHERE id = $1;`, [run1_id]);
  const run1Status = run1Query.rows[0]?.status;

  const stepRuns1Query = await pgClient.query(`SELECT status FROM public.step_runs WHERE workflow_run_id = $1;`, [run1_id]);
  const completedStepsCount = stepRuns1Query.rows.filter((r) => r.status === 'completed').length;

  const auditQuery = await pgClient.query(`SELECT id FROM public.db_write_audit_logs WHERE workflow_run_id = $1;`, [run1_id]);
  const auditRecorded = auditQuery.rows.length > 0;

  const pass1 = run1Status === 'completed' && completedStepsCount === 5 && auditRecorded;
  console.log(`Result: ${pass1 ? 'PASS' : 'FAIL'} (Run Status: ${run1Status}, Completed Steps: ${completedStepsCount}/5, Audit Log: ${auditRecorded})`);
  results.push({
    test: '1. Full Multi-Step Execution Loop',
    expected: 'Status completed, 5 steps completed, DB audit written',
    actual: `Run Status: ${run1Status}, Steps: ${completedStepsCount}/5, Audit: ${auditRecorded}`,
    pass: pass1,
  });

  // =================================================================
  // 2. Approval Gate Pause & Resume Transition
  // =================================================================
  console.log('\n--- Test 2: Approval Gate Pause & Resume Transition ---');
  await pgClient.query('BEGIN');
  const wf2Res = await pgClient.query(`INSERT INTO public.workflows (org_id, name, created_by) VALUES ($1, 'Approval Gate Workflow', $2) RETURNING id;`, [org_id, owner_id]);
  const wf2_id = wf2Res.rows[0].id;

  await pgClient.query(`INSERT INTO public.workflow_steps (workflow_id, position, type, name, config) VALUES ($1, 1, 'llm_call', 'Step 1 LLM', '{"prompt": "Draft email"}'::jsonb);`, [wf2_id]);
  await pgClient.query(`INSERT INTO public.workflow_steps (workflow_id, position, type, name, config) VALUES ($1, 2, 'approval_gate', 'Gate Step', '{}'::jsonb);`, [wf2_id]);
  await pgClient.query(`INSERT INTO public.workflow_steps (workflow_id, position, type, name, config) VALUES ($1, 3, 'notify', 'Step 3 Send', '{"channel": "email"}'::jsonb);`, [wf2_id]);
  await pgClient.query('COMMIT');

  const triggerRes2 = await executeApi('actions/trigger-workflow', owner_id, { workflow_id: wf2_id });
  const run2_id = triggerRes2.data?.run_id;

  const run2PauseQuery = await pgClient.query(`SELECT status FROM public.workflow_runs WHERE id = $1;`, [run2_id]);
  const run2PauseStatus = run2PauseQuery.rows[0]?.status;

  const gateSrQuery = await pgClient.query(`SELECT sr.id, sr.status FROM public.step_runs sr JOIN public.workflow_steps ws ON sr.workflow_step_id = ws.id WHERE sr.workflow_run_id = $1 AND ws.type = 'approval_gate';`, [run2_id]);
  const gateSrId = gateSrQuery.rows[0]?.id;
  const gateSrStatus = gateSrQuery.rows[0]?.status;

  console.log(`Pause Check -> Workflow Run Status: ${run2PauseStatus}, Gate Step Run Status: ${gateSrStatus}`);

  // Invoke approveStep Hasura Action
  const approveRes = await executeApi('actions/approve-step', editor_id, { step_run_id: gateSrId });
  console.log('Approve Action Status:', approveRes.status, 'Response:', approveRes.data);

  const run2ResumeQuery = await pgClient.query(`SELECT status FROM public.workflow_runs WHERE id = $1;`, [run2_id]);
  const run2ResumeStatus = run2ResumeQuery.rows[0]?.status;

  const pass2 = run2PauseStatus === 'paused' && gateSrStatus === 'paused' && approveRes.status === 200 && run2ResumeStatus === 'completed';
  console.log(`Result: ${pass2 ? 'PASS' : 'FAIL'} (Paused -> Resumed -> Completed)`);
  results.push({
    test: '2. Approval Gate Pause & Resume Transition',
    expected: 'Run pauses at gate, resumes on approval, completes',
    actual: `Paused: ${run2PauseStatus === 'paused'}, Resumed: ${approveRes.data?.status}, Final Status: ${run2ResumeStatus}`,
    pass: pass2,
  });

  // =================================================================
  // 3. Step-Level Retry Handling on Failure
  // =================================================================
  console.log('\n--- Test 3: Step-Level Retry Handling on Failure ---');
  await pgClient.query('BEGIN');
  const wf3Res = await pgClient.query(`INSERT INTO public.workflows (org_id, name, created_by) VALUES ($1, 'Retry Test Workflow', $2) RETURNING id;`, [org_id, owner_id]);
  const wf3_id = wf3Res.rows[0].id;

  await pgClient.query(`INSERT INTO public.workflow_steps (workflow_id, position, type, name, config) VALUES ($1, 1, 'http_request', 'Failing HTTP Step', '{"url": "https://httpbin.org/fail-test", "max_retries": 3}'::jsonb);`, [wf3_id]);
  await pgClient.query('COMMIT');

  const triggerRes3 = await executeApi('actions/trigger-workflow', owner_id, { workflow_id: wf3_id });
  const run3_id = triggerRes3.data?.run_id;

  const run3Query = await pgClient.query(`SELECT status, error FROM public.workflow_runs WHERE id = $1;`, [run3_id]);
  const run3Status = run3Query.rows[0]?.status;

  const stepRun3Query = await pgClient.query(`SELECT status, attempt_count, error FROM public.step_runs WHERE workflow_run_id = $1;`, [run3_id]);
  const attempts = stepRun3Query.rows[0]?.attempt_count;
  const step3Status = stepRun3Query.rows[0]?.status;

  const pass3 = run3Status === 'failed' && step3Status === 'failed' && attempts === 3;
  console.log(`Result: ${pass3 ? 'PASS' : 'FAIL'} (Attempts: ${attempts}/3, Run Status: ${run3Status}, Step Status: ${step3Status})`);
  results.push({
    test: '3. Step-Level Retry Handling on Failure',
    expected: 'Retries 3 times on error, then marks step and run failed',
    actual: `Attempts: ${attempts}/3, Step Status: ${step3Status}, Run Status: ${run3Status}`,
    pass: pass3,
  });

  // =================================================================
  // 4. Inbound Webhook Trigger Execution
  // =================================================================
  console.log('\n--- Test 4: Inbound Webhook Trigger Execution ---');
  await pgClient.query('BEGIN');
  const wf4Res = await pgClient.query(`INSERT INTO public.workflows (org_id, name, created_by) VALUES ($1, 'Webhook Triggered Workflow', $2) RETURNING id;`, [org_id, owner_id]);
  const wf4_id = wf4Res.rows[0].id;

  await pgClient.query(`INSERT INTO public.workflow_triggers (workflow_id, type, config, enabled) VALUES ($1, 'webhook', '{"secret": "webhook_secret_key_888"}'::jsonb, true);`, [wf4_id]);
  await pgClient.query(`INSERT INTO public.workflow_steps (workflow_id, position, type, name, config) VALUES ($1, 1, 'notify', 'Webhook Notify', '{"channel": "webhook_log"}'::jsonb);`, [wf4_id]);
  await pgClient.query('COMMIT');

  const webhookRes = await executeApi('triggers/webhook', owner_id, {}, `?workflow_id=${wf4_id}&secret=webhook_secret_key_888`);
  console.log('Webhook API Status:', webhookRes.status, 'Data:', webhookRes.data);

  const run4Query = await pgClient.query(`SELECT trigger_type, status FROM public.workflow_runs WHERE id = $1;`, [webhookRes.data?.run_id]);
  const run4TriggerType = run4Query.rows[0]?.trigger_type;
  const run4Status = run4Query.rows[0]?.status;

  const pass4 = webhookRes.status === 200 && run4TriggerType === 'webhook' && run4Status === 'completed';
  console.log(`Result: ${pass4 ? 'PASS' : 'FAIL'} (Trigger Type: ${run4TriggerType}, Status: ${run4Status})`);
  results.push({
    test: '4. Inbound Webhook Trigger Execution',
    expected: 'Inbound POST creates webhook run and completes workflow',
    actual: `HTTP ${webhookRes.status}, Trigger Type: ${run4TriggerType}, Status: ${run4Status}`,
    pass: pass4,
  });

  // =================================================================
  // 5. Quota Usage Persistence Audit
  // =================================================================
  console.log('\n--- Test 5: Quota Usage Persistence Audit ---');
  const usageQuery = await pgClient.query(`SELECT quota_used, total_runs_this_month FROM public.org_monthly_usage WHERE org_id = $1;`, [org_id]);
  const quotaUsed = usageQuery.rows[0]?.quota_used;
  const totalRuns = usageQuery.rows[0]?.total_runs_this_month;

  const pass5 = Number(quotaUsed) >= 4 && Number(totalRuns) >= 4;
  console.log(`Result: ${pass5 ? 'PASS' : 'FAIL'} (Quota Used: ${quotaUsed}, Total Runs Recorded in View: ${totalRuns})`);
  results.push({
    test: '5. Quota Usage Persistence Audit',
    expected: 'Quota limit incremented and org_monthly_usage view updated',
    actual: `Quota Used: ${quotaUsed}, Monthly View Runs: ${totalRuns}`,
    pass: pass5,
  });

  await pgClient.end();

  console.log('\n================================================================');
  console.table(results);
  console.log('================================================================\n');

  // Create docs/phase8-execution-engine-verification.md
  const docDir = path.join(__dirname, '..', 'docs');
  if (!fs.existsSync(docDir)) {
    fs.mkdirSync(docDir, { recursive: true });
  }
  const docPath = path.join(docDir, 'phase8-execution-engine-verification.md');

  const docContent = `# Phase 8 — Workflow Execution Engine & Retry Verification Report

This document records the empirical verification results for Phase 8 (Workflow Execution Engine, Approval Gate Pause/Resume, Retry Handling, Webhook Inbound Triggering, and Quota Audit).

## Execution Engine Verification Matrix

| Test | Expected | Actual Result | Status |
| :--- | :--- | :--- | :--- |
${results.map((r) => `| **${r.test}** | ${r.expected} | \`${r.actual.replace(/\|/g, '\\|')}\` | **${r.pass ? 'PASS' : 'FAIL'}** |`).join('\n')}

---

## Supported Step Execution Handlers

1. **\`llm_call\`**: Evaluates AI prompt with variable interpolation (\`{{step1.output.text}}\`), simulates token generation, and records completion.
2. **\`http_request\`**: Executes HTTP GET/POST requests with variable interpolation, returning response status and body.
3. **\`db_write\`**: Writes audit records directly to \`db_write_audit_logs\` in PostgreSQL.
4. **\`notify\`**: Delivers notification event payload to target channels (Slack, Email, Log).
5. **\`conditional_branch\`**: Evaluates dynamic conditions (\`{{step1.tokens_used}} > 0\`) and determines true/false branch execution path.
6. **\`approval_gate\`**: Pauses execution loop cleanly (\`status = 'paused'\`), waiting for \`approveStep\` Action invocation before resuming remaining steps.

---

## Retry Mechanism & Backoff
* Each step tracks \`attempt_count\`.
* On execution failure (e.g. HTTP 5xx or network timeout), the engine retries up to \`config.max_retries\` (default: 3) with exponential backoff delay (\`2^attempt * 100ms\`).
* If retries are exhausted, the \`step_run\` and \`workflow_run\` are marked as \`failed\` with error trace recorded in PostgreSQL.

---

## Non-Manual Inbound Webhook Trigger (\`/api/triggers/webhook\`)
* External POST endpoint: \`/api/triggers/webhook?workflow_id=UUID&secret=KEY\`
* Validates webhook trigger secret configured on the workflow.
* Enforces organization monthly quota limit.
* Launches workflow run with \`trigger_type = 'webhook'\`.
`;

  fs.writeFileSync(docPath, docContent, 'utf8');
  console.log('✓ Created docs/phase8-execution-engine-verification.md');
}

runPhase8Suite();
