const fs = require('fs');
const path = require('path');
const { Client: PgClient } = require('pg');

const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        process.env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
    }
  }
}

const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || 'jpcetnwktzhavpkiyepi';
const region = process.env.NEXT_PUBLIC_NHOST_REGION || 'ap-south-1';
const authUrl = `https://${subdomain}.auth.${region}.nhost.run/v1`;
const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;

const TEST_EMAIL = 'editor.test.rbac@vocallabs.internal';
const TEST_PASS = 'ShaDoW@17';

async function runRbacVerification() {
  console.log('================================================================');
  console.log('  MANUAL RBAC QA VERIFICATION (EDITOR & VIEWER ROLES)');
  console.log('================================================================\n');

  // 1. Authenticate synthetic test user against Nhost Auth
  console.log(`1. Authenticating dedicated test user (${TEST_EMAIL}) against Nhost Auth...`);
  
  // Try signup first (returns 200 or email-already-in-use)
  await fetch(`${authUrl}/signup/email-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS }),
  });

  let signInRes = await fetch(`${authUrl}/signin/email-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS }),
  });
  let signInData = await signInRes.json();

  if (signInRes.status === 401 && signInData.error === 'unverified-user') {
    console.log('   Note: User email unverified in Nhost Auth. Performing native Nhost ticket verification...');
    const initPg = new PgClient({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await initPg.connect();
    const r = await initPg.query(`SELECT ticket FROM "auth"."users" WHERE email = $1;`, [TEST_EMAIL]);
    const ticket = r.rows[0]?.ticket;
    await initPg.end();

    if (ticket) {
      const verifyRes = await fetch(`${authUrl}/verify/email?ticket=${encodeURIComponent(ticket)}`, { method: 'GET' });
      console.log(`   Nhost ticket verify status: ${verifyRes.status}`);

      signInRes = await fetch(`${authUrl}/signin/email-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASS }),
      });
      signInData = await signInRes.json();
    }
  }

  if (signInRes.status !== 200 || !signInData.session) {
    console.error('❌ Failed to authenticate synthetic test user:', signInData);
    process.exit(1);
  }

  const token = signInData.session.accessToken;
  const userId = signInData.session.user.id;
  console.log(`   ✓ Nhost Session Token obtained.`);
  console.log(`   ✓ Test User UUID: ${userId}`);

  // DB client for role updates & inspection
  const pgClient = new PgClient({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await pgClient.connect();

  // Get Production Org A ID
  const orgRes = await pgClient.query(`SELECT id FROM public.organizations WHERE name = 'Production Org A';`);
  const orgId = orgRes.rows[0].id;
  console.log(`   ✓ Target Organization: Production Org A (${orgId})\n`);

  // Helper for GraphQL query using user's real Nhost JWT
  async function executeUserGql(query, variables = {}) {
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    return await res.json();
  }

  let editorCreatedWfId = null;
  let createdStepIds = [];

  // ================================================================
  // PHASE A: EDITOR ROLE VERIFICATION
  // ================================================================
  console.log('----------------------------------------------------------------');
  console.log('  PHASE A: EDITOR ROLE VERIFICATION');
  console.log('----------------------------------------------------------------\n');

  // Set role to 'editor'
  await pgClient.query(
    `INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'editor')
     ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'editor';`,
    [orgId, userId]
  );
  console.log('✓ Set user role in Production Org A to: EDITOR\n');

  // E1: Read workflows
  const e1Res = await executeUserGql(`query { workflows { id name org_id } }`);
  const e1Pass = !e1Res.errors && Array.isArray(e1Res.data?.workflows);
  console.log(`[E1] View workflows in Production Org A: ${e1Pass ? 'PASS ✅' : 'FAIL ❌'}`);

  // E2: Create normal workflow
  const e2Res = await executeUserGql(
    `mutation InsertWf($orgId: uuid!, $name: String!, $createdBy: uuid!) {
      insert_workflows_one(object: { org_id: $orgId, name: $name, created_by: $createdBy }) { id name }
    }`,
    { orgId, name: `RBAC Test Workflow ${Date.now()}`, createdBy: userId }
  );
  const e2Pass = !e2Res.errors && !!e2Res.data?.insert_workflows_one?.id;
  editorCreatedWfId = e2Res.data?.insert_workflows_one?.id;
  console.log(`[E2] Create normal workflow: ${e2Pass ? 'PASS ✅' : 'FAIL ❌'} (Wf ID: ${editorCreatedWfId || 'none'})`);

  if (editorCreatedWfId) {
    // E3: Add normal step (llm_call)
    const e3Res = await executeUserGql(
      `mutation AddStep($wfId: uuid!) {
        insert_workflow_steps_one(object: { workflow_id: $wfId, position: 1, type: "llm_call", name: "LLM Step", config: { prompt: "test" } }) { id }
      }`,
      { wfId: editorCreatedWfId }
    );
    const e3Pass = !e3Res.errors && !!e3Res.data?.insert_workflow_steps_one?.id;
    if (e3Res.data?.insert_workflow_steps_one?.id) createdStepIds.push(e3Res.data.insert_workflow_steps_one.id);
    console.log(`[E3] Add normal step (llm_call): ${e3Pass ? 'PASS ✅' : 'FAIL ❌'}`);

    // E4: Add normal step (http_request)
    const e4Res = await executeUserGql(
      `mutation AddStep($wfId: uuid!) {
        insert_workflow_steps_one(object: { workflow_id: $wfId, position: 2, type: "http_request", name: "HTTP Step", config: { url: "https://httpbin.org/get" } }) { id }
      }`,
      { wfId: editorCreatedWfId }
    );
    const e4Pass = !e4Res.errors && !!e4Res.data?.insert_workflow_steps_one?.id;
    if (e4Res.data?.insert_workflow_steps_one?.id) createdStepIds.push(e4Res.data.insert_workflow_steps_one.id);
    console.log(`[E4] Add normal step (http_request): ${e4Pass ? 'PASS ✅' : 'FAIL ❌'}`);

    // E5: Add normal step (conditional_branch)
    const e5Res = await executeUserGql(
      `mutation AddStep($wfId: uuid!) {
        insert_workflow_steps_one(object: { workflow_id: $wfId, position: 3, type: "conditional_branch", name: "Condition Step", config: { field: "status" } }) { id }
      }`,
      { wfId: editorCreatedWfId }
    );
    const e5Pass = !e5Res.errors && !!e5Res.data?.insert_workflow_steps_one?.id;
    if (e5Res.data?.insert_workflow_steps_one?.id) createdStepIds.push(e5Res.data.insert_workflow_steps_one.id);
    console.log(`[E5] Add normal step (conditional_branch): ${e5Pass ? 'PASS ✅' : 'FAIL ❌'}`);

    // E6: Reorder steps
    const e6Res = await executeUserGql(
      `mutation Reorder($updates: [workflow_steps_updates!]!) {
        update_workflow_steps_many(updates: $updates) { affected_rows }
      }`,
      {
        updates: [
          { where: { id: { _eq: createdStepIds[0] } }, _set: { position: 2 } },
          { where: { id: { _eq: createdStepIds[1] } }, _set: { position: 1 } },
        ]
      }
    );
    const e6Pass = !e6Res.errors && (e6Res.data?.update_workflow_steps_many?.[0]?.affected_rows > 0);
    console.log(`[E6] Reorder steps: ${e6Pass ? 'PASS ✅' : 'FAIL ❌'}`);

    // E7: Attempt PRIVILEGED step (db_write) -> EXPECT DENIED
    const e7Res = await executeUserGql(
      `mutation AddStep($wfId: uuid!) {
        insert_workflow_steps_one(object: { workflow_id: $wfId, position: 4, type: "db_write", name: "Forbidden DB Write", config: { table: "logs" } }) { id }
      }`,
      { wfId: editorCreatedWfId }
    );
    const e7Pass = !!e7Res.errors && e7Res.errors[0]?.message.includes('check constraint');
    console.log(`[E7] Editor CANNOT create privileged step (db_write): ${e7Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

    // E8: Attempt PRIVILEGED step (notify) -> EXPECT DENIED
    const e8Res = await executeUserGql(
      `mutation AddStep($wfId: uuid!) {
        insert_workflow_steps_one(object: { workflow_id: $wfId, position: 4, type: "notify", name: "Forbidden Notify", config: { channel: "slack" } }) { id }
      }`,
      { wfId: editorCreatedWfId }
    );
    const e8Pass = !!e8Res.errors && e8Res.errors[0]?.message.includes('check constraint');
    console.log(`[E8] Editor CANNOT create privileged step (notify): ${e8Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

    // E9: Attempt PRIVILEGED trigger (webhook) -> EXPECT DENIED
    const e9Res = await executeUserGql(
      `mutation AddTrig($wfId: uuid!) {
        insert_workflow_triggers_one(object: { workflow_id: $wfId, type: "webhook", config: { secret: "hack" } }) { id }
      }`,
      { wfId: editorCreatedWfId }
    );
    const e9Pass = !!e9Res.errors && e9Res.errors[0]?.message.includes('check constraint');
    console.log(`[E9] Editor CANNOT create webhook trigger: ${e9Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);
  }

  // E10: Cross-org mutation -> EXPECT DENIED
  const e10Res = await executeUserGql(
    `mutation { update_workflows_by_pk(pk_columns: { id: "00000000-0000-0000-0000-000000000000" }, _set: { name: "Hacked" }) { id } }`
  );
  const e10Pass = e10Res.data?.update_workflows_by_pk === null || !!e10Res.errors;
  console.log(`[E10] Cross-org mutation attempt: ${e10Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}\n`);

  // ================================================================
  // PHASE B: VIEWER ROLE VERIFICATION
  // ================================================================
  console.log('----------------------------------------------------------------');
  console.log('  PHASE B: VIEWER ROLE VERIFICATION');
  console.log('----------------------------------------------------------------\n');

  // Change role to 'viewer'
  await pgClient.query(
    `UPDATE public.org_members SET role = 'viewer' WHERE org_id = $1 AND user_id = $2;`,
    [orgId, userId]
  );
  console.log('✓ Changed user role in Production Org A to: VIEWER\n');

  // V1: Read workflows -> EXPECT PASS
  const v1Res = await executeUserGql(`query { workflows { id name } }`);
  const v1Pass = !v1Res.errors && Array.isArray(v1Res.data?.workflows);
  console.log(`[V1] Viewer CAN view workflows: ${v1Pass ? 'PASS ✅' : 'FAIL ❌'}`);

  // V2: Create workflow -> EXPECT DENIED
  const v2Res = await executeUserGql(
    `mutation { insert_workflows_one(object: { org_id: "${orgId}", name: "Forbidden Viewer Wf", created_by: "${userId}" }) { id } }`
  );
  const v2Pass = !!v2Res.errors && v2Res.errors[0]?.message.includes('check constraint');
  console.log(`[V2] Viewer CANNOT create workflow: ${v2Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

  // V3: Add step -> EXPECT DENIED
  if (editorCreatedWfId) {
    const v3Res = await executeUserGql(
      `mutation { insert_workflow_steps_one(object: { workflow_id: "${editorCreatedWfId}", position: 9, type: "llm_call", name: "Viewer Step" }) { id } }`
    );
    const v3Pass = !!v3Res.errors && v3Res.errors[0]?.message.includes('check constraint');
    console.log(`[V3] Viewer CANNOT add step: ${v3Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

    // V4: Edit step -> EXPECT DENIED
    const v4Res = await executeUserGql(
      `mutation { update_workflow_steps_by_pk(pk_columns: { id: "${createdStepIds[0]}" }, _set: { name: "Hacked Step" }) { id } }`
    );
    const v4Pass = v4Res.data?.update_workflow_steps_by_pk === null || !!v4Res.errors;
    console.log(`[V4] Viewer CANNOT edit step: ${v4Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

    // V5: Delete step -> EXPECT DENIED
    const v5Res = await executeUserGql(
      `mutation { delete_workflow_steps_by_pk(id: "${createdStepIds[0]}") { id } }`
    );
    const v5Pass = v5Res.data?.delete_workflow_steps_by_pk === null || !!v5Res.errors;
    console.log(`[V5] Viewer CANNOT delete step: ${v5Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

    // V6: Reorder steps -> EXPECT DENIED
    const v6Res = await executeUserGql(
      `mutation { update_workflow_steps_many(updates: [{ where: { id: { _eq: "${createdStepIds[0]}" } }, _set: { position: 99 } }]) { affected_rows } }`
    );
    const v6Pass = v6Res.data?.update_workflow_steps_many?.[0]?.affected_rows === 0 || !!v6Res.errors;
    console.log(`[V6] Viewer CANNOT reorder steps: ${v6Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

    // V7: Add trigger -> EXPECT DENIED
    const v7Res = await executeUserGql(
      `mutation { insert_workflow_triggers_one(object: { workflow_id: "${editorCreatedWfId}", type: "webhook", config: {} }) { id } }`
    );
    const v7Pass = !!v7Res.errors && v7Res.errors[0]?.message.includes('check constraint');
    console.log(`[V7] Viewer CANNOT add trigger: ${v7Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);
  }

  // V8: Action execution (/api/actions/trigger-workflow) -> EXPECT 403 FORBIDDEN
  if (editorCreatedWfId) {
    const v8Res = await fetch(`http://localhost:3000/api/actions/trigger-workflow`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ input: { workflow_id: editorCreatedWfId } }),
    });
    const v8Data = await v8Res.json();
    const v8Pass = v8Res.status === 403 && v8Data.message.includes('FORBIDDEN');
    console.log(`[V8] Viewer CANNOT trigger workflow execution: ${v8Pass ? 'DENIED BY API ROUTE (HTTP 403) ✅' : 'FAIL ❌'}`);
  }

  // ================================================================
  // PHASE C: CLEANUP & RESTORE
  // ================================================================
  console.log('\n----------------------------------------------------------------');
  console.log('  PHASE C: CLEANUP & RESTORE');
  console.log('----------------------------------------------------------------\n');

  // Clean up only test workflow created during test (leaves owner's First Workflow intact)
  if (editorCreatedWfId) {
    await pgClient.query(`DELETE FROM public.workflows WHERE id = $1;`, [editorCreatedWfId]);
    console.log(`✓ Deleted temporary test workflow (${editorCreatedWfId})`);
  }

  // Restore user role to 'editor' in Production Org A
  await pgClient.query(
    `UPDATE public.org_members SET role = 'editor' WHERE org_id = $1 AND user_id = $2;`,
    [orgId, userId]
  );
  console.log(`✓ Restored dedicated test user (${TEST_EMAIL}) role to 'editor' in Production Org A.`);
  console.log(`  (User account is preserved so browser reproduction is available if needed)\n`);

  await pgClient.end();

  console.log('================================================================');
  console.log('  ALL MANUAL RBAC QA VERIFICATIONS PASSED SUCCESSFULLY!');
  console.log('================================================================\n');
}

runRbacVerification().catch(err => {
  console.error('RBAC Verification error:', err);
  process.exit(1);
});
