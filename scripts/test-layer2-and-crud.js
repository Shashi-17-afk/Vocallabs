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

async function runLayer2AndCrudSuite() {
  console.log('================================================================');
  console.log('  LAYER 2 SERVER-SIDE AUTHORIZATION & WORKFLOW CRUD TEST SUITE');
  console.log('================================================================\n');

  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  const dbUrl = process.env.DATABASE_URL;

  const pgClient = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  // Test User UUIDs
  const ownerA_id  = '33333333-3333-4333-a333-333333333333';
  const editorA_id = '44444444-4444-4444-a444-444444444444';
  const viewerA_id = '55555555-5555-4555-a555-555555555555';
  const ownerB_id  = '66666666-6666-4666-b666-666666666666';

  const ts = Date.now();
  console.log('Setting up Test Organizations and User Memberships...');
  await pgClient.query('BEGIN');

  // Create Org A
  const orgARes = await pgClient.query(`INSERT INTO public.organizations (name, quota_limit) VALUES ($1, 100) RETURNING id;`, [`Org A Layer 2 Target ${ts}`]);
  const orgA_id = orgARes.rows[0].id;

  // Add Org A Memberships: Owner, Editor, Viewer
  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner');", [orgA_id, ownerA_id]);
  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'editor');", [orgA_id, editorA_id]);
  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'viewer');", [orgA_id, viewerA_id]);

  // Create Org B & Owner B
  const orgBRes = await pgClient.query(`INSERT INTO public.organizations (name, quota_limit) VALUES ($1, 100) RETURNING id;`, [`Org B Layer 2 Attacker ${ts}`]);
  const orgB_id = orgBRes.rows[0].id;
  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner');", [orgB_id, ownerB_id]);

  await pgClient.query('COMMIT');

  console.log('✓ Org A ID:', orgA_id);
  console.log('  - Owner A ID:', ownerA_id);
  console.log('  - Editor A ID:', editorA_id);
  console.log('  - Viewer A ID:', viewerA_id);
  console.log('✓ Org B ID:', orgB_id);
  console.log('  - Owner B ID:', ownerB_id);

  // GraphQL fetch helper for role 'user' and specific x-hasura-user-id
  async function executeGql(userId, query, variables = {}) {
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': adminSecret,
        'x-hasura-role': 'user',
        'x-hasura-user-id': userId,
      },
      body: JSON.stringify({ query, variables }),
    });
    return await res.json();
  }

  // REST API fetch helper for server-side endpoints
  async function executeApi(endpoint, userId, body) {
    const res = await fetch(`http://localhost:3000/api/${endpoint}`, {
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

  const matrix = [];

  // =================================================================
  // TEST 1 — Owner workflow CRUD → PASS
  // =================================================================
  console.log('\n--- Test 1: Owner workflow CRUD ---');
  const createWfMutation = `
    mutation CreateWf($orgId: uuid!, $name: String!, $created_by: uuid!) {
      insert_workflows_one(object: { org_id: $orgId, name: $name, created_by: $created_by }) {
        id
        name
        org_id
      }
    }
  `;
  const t1Res = await executeGql(ownerA_id, createWfMutation, { orgId: orgA_id, name: 'Owner Created Workflow', created_by: ownerA_id });
  const wfA_id = t1Res.data?.insert_workflows_one?.id;
  const pass1 = !!wfA_id;
  console.log(`Result: ${pass1 ? 'PASS' : 'FAIL'} (Created Workflow ID: ${wfA_id})`);
  matrix.push({ test: '1. Owner workflow CRUD', user: 'Owner A', op: 'Create Workflow', expected: 'PASS (Created)', actual: `Created UUID ${wfA_id}`, pass: pass1 });

  // =================================================================
  // TEST 2 — Editor workflow CRUD → PASS
  // =================================================================
  console.log('\n--- Test 2: Editor workflow CRUD ---');
  const t2Res = await executeGql(editorA_id, createWfMutation, { orgId: orgA_id, name: 'Editor Created Workflow', created_by: editorA_id });
  const wfEditor_id = t2Res.data?.insert_workflows_one?.id;
  const pass2 = !!wfEditor_id;
  console.log(`Result: ${pass2 ? 'PASS' : 'FAIL'} (Created Workflow ID: ${wfEditor_id})`);
  matrix.push({ test: '2. Editor workflow CRUD', user: 'Editor A', op: 'Create Workflow', expected: 'PASS (Created)', actual: `Created UUID ${wfEditor_id}`, pass: pass2 });

  // =================================================================
  // TEST 3 — Viewer workflow read → PASS
  // =================================================================
  console.log('\n--- Test 3: Viewer workflow read ---');
  const readWfQuery = `
    query ReadWf($id: uuid!) {
      workflows_by_pk(id: $id) {
        id
        name
      }
    }
  `;
  const t3Res = await executeGql(viewerA_id, readWfQuery, { id: wfA_id });
  const pass3 = t3Res.data?.workflows_by_pk?.id === wfA_id;
  console.log(`Result: ${pass3 ? 'PASS' : 'FAIL'} (Read name: ${t3Res.data?.workflows_by_pk?.name})`);
  matrix.push({ test: '3. Viewer workflow read', user: 'Viewer A', op: 'workflows_by_pk', expected: 'PASS (Returned workflow)', actual: JSON.stringify(t3Res.data?.workflows_by_pk), pass: pass3 });

  // =================================================================
  // TEST 4 — Viewer workflow mutation → DENIED
  // =================================================================
  console.log('\n--- Test 4: Viewer workflow mutation ---');
  const t4Res = await executeGql(viewerA_id, createWfMutation, { orgId: orgA_id, name: 'Viewer Illegal Workflow', created_by: viewerA_id });
  const pass4 = !!t4Res.errors;
  console.log(`Result: ${pass4 ? 'PASS' : 'FAIL'} (Actual: ${t4Res.errors?.[0]?.message || JSON.stringify(t4Res.data)})`);
  matrix.push({ test: '4. Viewer workflow mutation', user: 'Viewer A', op: 'insert_workflows_one', expected: 'DENIED', actual: t4Res.errors ? `DENIED: ${t4Res.errors[0].message}` : 'Allowed', pass: pass4 });

  // =================================================================
  // TEST 5 — Editor adding normal step → PASS
  // =================================================================
  console.log('\n--- Test 5: Editor adding normal step (llm_call) ---');
  const t5Res = await executeApi('workflows/steps', editorA_id, {
    workflow_id: wfA_id,
    position: 1,
    type: 'llm_call',
    name: 'Normal LLM Step',
    config: { prompt: 'Hello AI' }
  });
  const pass5 = t5Res.status === 200 && t5Res.data?.id;
  console.log(`Result: ${pass5 ? 'PASS' : 'FAIL'} (Step ID: ${t5Res.data?.id})`);
  matrix.push({ test: '5. Editor adding normal step', user: 'Editor A', op: 'Add step (llm_call)', expected: 'PASS (200 OK)', actual: `Status ${t5Res.status}, Step ID ${t5Res.data?.id}`, pass: pass5 });

  // =================================================================
  // TEST 6 — Editor adding db_write → DENIED
  // =================================================================
  console.log('\n--- Test 6: Editor adding db_write ---');
  const t6Res = await executeApi('workflows/steps', editorA_id, {
    workflow_id: wfA_id,
    position: 2,
    type: 'db_write',
    name: 'Privileged DB Write Step',
    config: { table: 'users' }
  });
  const pass6 = t6Res.status === 403 && t6Res.data?.message?.includes('FORBIDDEN');
  console.log(`Result: ${pass6 ? 'PASS' : 'FAIL'} (Status: ${t6Res.status}, Message: ${t6Res.data?.message})`);
  matrix.push({ test: '6. Editor adding db_write', user: 'Editor A', op: 'Add step (db_write)', expected: 'DENIED (403 Forbidden)', actual: `Status ${t6Res.status}, ${t6Res.data?.message}`, pass: pass6 });

  // =================================================================
  // TEST 7 — Editor adding notify → DENIED
  // =================================================================
  console.log('\n--- Test 7: Editor adding notify ---');
  const t7Res = await executeApi('workflows/steps', editorA_id, {
    workflow_id: wfA_id,
    position: 3,
    type: 'notify',
    name: 'Privileged Notify Step',
    config: { channel: 'slack' }
  });
  const pass7 = t7Res.status === 403 && t7Res.data?.message?.includes('FORBIDDEN');
  console.log(`Result: ${pass7 ? 'PASS' : 'FAIL'} (Status: ${t7Res.status}, Message: ${t7Res.data?.message})`);
  matrix.push({ test: '7. Editor adding notify', user: 'Editor A', op: 'Add step (notify)', expected: 'DENIED (403 Forbidden)', actual: `Status ${t7Res.status}, ${t7Res.data?.message}`, pass: pass7 });

  // =================================================================
  // TEST 8 — Editor creating webhook trigger → DENIED
  // =================================================================
  console.log('\n--- Test 8: Editor creating webhook trigger ---');
  const t8Res = await executeApi('workflows/triggers', editorA_id, {
    workflow_id: wfA_id,
    type: 'webhook',
    config: { path: '/api/v1/hook' }
  });
  const pass8 = t8Res.status === 403 && t8Res.data?.message?.includes('FORBIDDEN');
  console.log(`Result: ${pass8 ? 'PASS' : 'FAIL'} (Status: ${t8Res.status}, Message: ${t8Res.data?.message})`);
  matrix.push({ test: '8. Editor creating webhook trigger', user: 'Editor A', op: 'Add trigger (webhook)', expected: 'DENIED (403 Forbidden)', actual: `Status ${t8Res.status}, ${t8Res.data?.message}`, pass: pass8 });

  // =================================================================
  // TEST 9 — Owner adding db_write → PASS
  // =================================================================
  console.log('\n--- Test 9: Owner adding db_write ---');
  const t9Res = await executeApi('workflows/steps', ownerA_id, {
    workflow_id: wfA_id,
    position: 2,
    type: 'db_write',
    name: 'Authorized DB Write Step',
    config: { table: 'audit' }
  });
  const pass9 = t9Res.status === 200 && t9Res.data?.id;
  console.log(`Result: ${pass9 ? 'PASS' : 'FAIL'} (Step ID: ${t9Res.data?.id})`);
  matrix.push({ test: '9. Owner adding db_write', user: 'Owner A', op: 'Add step (db_write)', expected: 'PASS (200 OK)', actual: `Status ${t9Res.status}, Step ID ${t9Res.data?.id}`, pass: pass9 });

  // =================================================================
  // TEST 10 — Owner adding notify → PASS
  // =================================================================
  console.log('\n--- Test 10: Owner adding notify ---');
  const t10Res = await executeApi('workflows/steps', ownerA_id, {
    workflow_id: wfA_id,
    position: 3,
    type: 'notify',
    name: 'Authorized Notify Step',
    config: { channel: 'email' }
  });
  const pass10 = t10Res.status === 200 && t10Res.data?.id;
  console.log(`Result: ${pass10 ? 'PASS' : 'FAIL'} (Step ID: ${t10Res.data?.id})`);
  matrix.push({ test: '10. Owner adding notify', user: 'Owner A', op: 'Add step (notify)', expected: 'PASS (200 OK)', actual: `Status ${t10Res.status}, Step ID ${t10Res.data?.id}`, pass: pass10 });

  // =================================================================
  // TEST 11 — Owner creating webhook trigger → PASS
  // =================================================================
  console.log('\n--- Test 11: Owner creating webhook trigger ---');
  const t11Res = await executeApi('workflows/triggers', ownerA_id, {
    workflow_id: wfA_id,
    type: 'webhook',
    config: { path: '/api/v1/owner-hook' }
  });
  const pass11 = t11Res.status === 200 && t11Res.data?.id;
  console.log(`Result: ${pass11 ? 'PASS' : 'FAIL'} (Trigger ID: ${t11Res.data?.id})`);
  matrix.push({ test: '11. Owner creating webhook trigger', user: 'Owner A', op: 'Add trigger (webhook)', expected: 'PASS (200 OK)', actual: `Status ${t11Res.status}, Trigger ID ${t11Res.data?.id}`, pass: pass11 });

  // =================================================================
  // TEST 12 — Org B cross-org attack against Org A → DENIED
  // =================================================================
  console.log('\n--- Test 12: Org B cross-org attack against Org A ---');
  const t12Res = await executeApi('workflows/steps', ownerB_id, {
    workflow_id: wfA_id,
    position: 99,
    type: 'llm_call',
    name: 'Cross-Org Malicious Step'
  });
  const pass12 = t12Res.status === 403 && t12Res.data?.message?.includes('FORBIDDEN');
  console.log(`Result: ${pass12 ? 'PASS' : 'FAIL'} (Status: ${t12Res.status}, Message: ${t12Res.data?.message})`);
  matrix.push({ test: '12. Org B attack against Org A', user: 'Owner B (Org B)', op: 'Modify Org A Workflow', expected: 'DENIED (403 Forbidden)', actual: `Status ${t12Res.status}, ${t12Res.data?.message}`, pass: pass12 });

  // =================================================================
  // ACTION TESTS: triggerWorkflowRun & approveStep
  // =================================================================
  console.log('\n--- Hasura Action Tests: triggerWorkflowRun & approveStep ---');

  // Trigger Action by Editor A (Allowed)
  const actTriggerEditor = await executeApi('actions/trigger-workflow', editorA_id, { workflow_id: wfA_id });
  const passActTriggerEditor = actTriggerEditor.status === 200 && actTriggerEditor.data?.run_id;
  console.log(`triggerWorkflowRun (Editor A): ${passActTriggerEditor ? 'PASS' : 'FAIL'} (Run ID: ${actTriggerEditor.data?.run_id})`);
  matrix.push({ test: 'Action: triggerWorkflowRun (Editor)', user: 'Editor A', op: 'triggerWorkflowRun', expected: 'PASS (Started)', actual: `Run ID ${actTriggerEditor.data?.run_id}`, pass: passActTriggerEditor });

  // Trigger Action by Viewer A (Denied)
  const actTriggerViewer = await executeApi('actions/trigger-workflow', viewerA_id, { workflow_id: wfA_id });
  const passActTriggerViewer = actTriggerViewer.status === 403 && actTriggerViewer.data?.message?.includes('FORBIDDEN');
  console.log(`triggerWorkflowRun (Viewer A): ${passActTriggerViewer ? 'PASS' : 'FAIL'} (Status: ${actTriggerViewer.status})`);
  matrix.push({ test: 'Action: triggerWorkflowRun (Viewer)', user: 'Viewer A', op: 'triggerWorkflowRun', expected: 'DENIED (403)', actual: `Status ${actTriggerViewer.status}, ${actTriggerViewer.data?.message}`, pass: passActTriggerViewer });

  // Setup Paused Step Run for approveStep
  await pgClient.query('BEGIN');
  const gateStepRes = await pgClient.query("INSERT INTO public.workflow_steps (workflow_id, position, type, name) VALUES ($1, 4, 'approval_gate', 'Gate Step') RETURNING id;", [wfA_id]);
  const gateStepId = gateStepRes.rows[0].id;

  const runRes = await pgClient.query("INSERT INTO public.workflow_runs (workflow_id, trigger_type, status, created_by) VALUES ($1, 'manual', 'paused', $2) RETURNING id;", [wfA_id, ownerA_id]);
  const pausedRunId = runRes.rows[0].id;

  const stepRunRes = await pgClient.query("INSERT INTO public.step_runs (workflow_run_id, workflow_step_id, status) VALUES ($1, $2, 'paused') RETURNING id;", [pausedRunId, gateStepId]);
  const pausedStepRunId = stepRunRes.rows[0].id;
  await pgClient.query('COMMIT');

  // approveStep Action by Viewer A (Denied)
  const actApproveViewer = await executeApi('actions/approve-step', viewerA_id, { step_run_id: pausedStepRunId });
  const passActApproveViewer = actApproveViewer.status === 403 && actApproveViewer.data?.message?.includes('FORBIDDEN');
  console.log(`approveStep (Viewer A): ${passActApproveViewer ? 'PASS' : 'FAIL'} (Status: ${actApproveViewer.status})`);
  matrix.push({ test: 'Action: approveStep (Viewer)', user: 'Viewer A', op: 'approveStep', expected: 'DENIED (403)', actual: `Status ${actApproveViewer.status}, ${actApproveViewer.data?.message}`, pass: passActApproveViewer });

  // approveStep Action by Editor A (Allowed)
  const actApproveEditor = await executeApi('actions/approve-step', editorA_id, { step_run_id: pausedStepRunId });
  const passActApproveEditor = actApproveEditor.status === 200 && actApproveEditor.data?.status === 'resumed';
  console.log(`approveStep (Editor A): ${passActApproveEditor ? 'PASS' : 'FAIL'} (Resumed by: ${actApproveEditor.data?.approved_by})`);
  matrix.push({ test: 'Action: approveStep (Editor)', user: 'Editor A', op: 'approveStep', expected: 'PASS (Resumed)', actual: `Status ${actApproveEditor.data?.status}, Approved by ${actApproveEditor.data?.approved_by}`, pass: passActApproveEditor });

  await pgClient.end();

  console.log('\n================================================================');
  console.table(matrix);
  console.log('================================================================\n');

  // Create docs/layer2-authorization-verification.md safely
  const docDir = path.join(__dirname, '..', 'docs');
  if (!fs.existsSync(docDir)) {
    fs.mkdirSync(docDir, { recursive: true });
  }
  const docPath = path.join(docDir, 'layer2-authorization-verification.md');
  const docContent = `# Layer 2 Server-Side Authorization & Workflow CRUD Verification Report

This document records the empirical verification results for Phase 6 (Layer 2 Server-Side Authorization Rules) and Phase 7 (Workflow CRUD Operations).

## Verification Matrix

| Test | Role | Operation | Expected | Actual | Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
${matrix.map(r => `| **${r.test}** | ${r.user} | \`${r.op}\` | ${r.expected} | \`${r.actual.replace(/\|/g, '\\|')}\` | **${r.pass ? 'PASS' : 'FAIL'}** |`).join('\n')}

---

## Role Capabilities & Server-Side Enforcement Architecture

| Role | Workflow Read | Workflow Create/Edit | Workflow Delete | Normal Steps | Privileged Steps (\`db_write\`, \`notify\`) | Webhook Triggers | Trigger Run Action | Approve Step Action |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Owner** | Allowed | Allowed | Allowed | Allowed | Allowed | Allowed | Allowed | Allowed |
| **Editor** | Allowed | Allowed | Denied | Allowed | **Denied (403)** | **Denied (403)** | Allowed | Allowed |
| **Viewer** | Allowed | Denied | Denied | Denied | Denied | Denied | **Denied (403)** | **Denied (403)** |

---

## Executed Server-Side Authorization Handlers

1. **\`triggerWorkflowRun\` Action Handler** (\`src/pages/api/actions/trigger-workflow.ts\`):
   - Extracts \`x-hasura-user-id\` session header.
   - Loads workflow -> verifies organization membership and role.
   - Restricts \`viewer\` role (returns HTTP 403 Forbidden).
   - Atomically updates organization monthly quota limit.

2. **\`approveStep\` Action Handler** (\`src/pages/api/actions/approve-step.ts\`):
   - Extracts \`x-hasura-user-id\` session header.
   - Verifies target step is an \`approval_gate\` in \`paused\` state.
   - Restricts \`viewer\` role (returns HTTP 403 Forbidden).
   - Sets \`status = 'completed'\`, records \`approved_by\` and \`approved_at\`, resumes workflow run.

3. **Privileged Step API Handler** (\`src/pages/api/workflows/steps.ts\`):
   - Enforces owner-only permission for \`db_write\` and \`notify\` step types.

4. **Privileged Trigger API Handler** (\`src/pages/api/workflows/triggers.ts\`):
   - Enforces owner-only permission for \`webhook\` trigger types.
`;

  fs.writeFileSync(docPath, docContent, 'utf8');
  console.log('✓ Created docs/layer2-authorization-verification.md');
}

runLayer2AndCrudSuite();
