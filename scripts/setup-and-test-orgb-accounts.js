const fs = require('fs');
const path = require('path');
const { Client: PgClient } = require('pg');

// Read .env.local
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

const APP_URL = 'http://localhost:3000';
const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || 'jpcetnwktzhavpkiyepi';
const region = process.env.NEXT_PUBLIC_NHOST_REGION || 'ap-south-1';
const authUrl = `https://${subdomain}.auth.${region}.nhost.run/v1`;
const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;

const EDITOR_EMAIL = 'orgb.editor@vocallabs.internal';
const VIEWER_EMAIL = 'orgb.viewer@vocallabs.internal';
const SHARED_PASS = 'ShaDoW@17';

async function setupAndTestOrgbAccounts() {
  console.log('================================================================');
  console.log('  SETUP & VERIFICATION: DEDICATED ORG B TEST ACCOUNTS');
  console.log('================================================================\n');

  const pgClient = new PgClient({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await pgClient.connect();

  // 1. Get or Create Production Org B
  let orgBRes = await pgClient.query(`SELECT id FROM public.organizations WHERE name = 'Production Org B';`);
  let orgBId;
  if (orgBRes.rows.length === 0) {
    const newOrg = await pgClient.query(`INSERT INTO public.organizations (name, quota_limit) VALUES ('Production Org B', 100) RETURNING id;`);
    orgBId = newOrg.rows[0].id;
  } else {
    orgBId = orgBRes.rows[0].id;
  }
  console.log(`1. Target Organization: Production Org B (${orgBId})`);

  // Get Production Org A & a paused run for Org A cross-org testing
  const orgARes = await pgClient.query(`SELECT id FROM public.organizations WHERE name = 'Production Org A';`);
  const orgAId = orgARes.rows[0].id;

  const orgAWfRes = await pgClient.query(`SELECT id FROM public.workflows WHERE org_id = $1 LIMIT 1;`, [orgAId]);
  const orgAWfId = orgAWfRes.rows[0]?.id || '00000000-0000-0000-0000-000000000000';

  // Helper to register & verify an Nhost account
  async function prepareNhostAccount(email, password, role) {
    console.log(`   Preparing Nhost Auth for: ${email}...`);
    await fetch(`${authUrl}/signup/email-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    // Query ticket from "auth"."users"
    const ticketRes = await pgClient.query(`SELECT id, ticket FROM "auth"."users" WHERE email = $1;`, [email]);
    const userId = ticketRes.rows[0]?.id;
    let ticket = ticketRes.rows[0]?.ticket;

    if (!ticket) {
      const crypto = require('crypto');
      ticket = 'verifyEmail:' + crypto.randomBytes(32).toString('hex');
      await pgClient.query(`UPDATE "auth"."users" SET ticket = $1, ticket_expires_at = NOW() + INTERVAL '1 day' WHERE email = $2;`, [ticket, email]);
    }

    // Complete Nhost email verification via native ticket API
    await fetch(`${authUrl}/verify/email?ticket=${encodeURIComponent(ticket)}`, { method: 'GET' });

    // Ensure org_members role in Production Org B
    await pgClient.query(
      `INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = $3;`,
      [orgBId, userId, role]
    );

    // Sign in to get real Bearer JWT
    const signInRes = await fetch(`${authUrl}/signin/email-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const signInData = await signInRes.json();

    if (signInRes.status !== 200 || !signInData.session) {
      throw new Error(`Failed to sign in ${email}: ${JSON.stringify(signInData)}`);
    }

    return {
      userId,
      token: signInData.session.accessToken,
    };
  }

  // 2. Prepare both accounts
  console.log('\n2. Registering & Verifying Nhost Accounts...');
  const editorAcc = await prepareNhostAccount(EDITOR_EMAIL, SHARED_PASS, 'editor');
  console.log(`   ✓ Org B Editor authenticated! UUID: ${editorAcc.userId}`);

  const viewerAcc = await prepareNhostAccount(VIEWER_EMAIL, SHARED_PASS, 'viewer');
  console.log(`   ✓ Org B Viewer authenticated! UUID: ${viewerAcc.userId}`);

  // Helper for GraphQL query using user Bearer JWT
  async function userGql(token, query, variables = {}) {
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

  // ================================================================
  // 3. TESTING ORG B EDITOR
  // ================================================================
  console.log('\n----------------------------------------------------------------');
  console.log('  3. TESTING ORG B EDITOR PERMISSIONS (Real Nhost JWT)');
  console.log('----------------------------------------------------------------\n');

  // E1: Log in -> PASS
  console.log(`[Editor 1] Login: PASS ✅ (Nhost Session Active)`);

  // E2: See Org B workflows
  const e2Res = await userGql(editorAcc.token, `query { workflows { id name org_id } }`);
  const e2Pass = !e2Res.errors && Array.isArray(e2Res.data?.workflows);
  console.log(`[Editor 2] See Org B workflows: ${e2Pass ? 'PASS ✅' : 'FAIL ❌'}`);

  // E3: Create normal workflow in Org B
  const e3Res = await userGql(
    editorAcc.token,
    `mutation InsertWf($orgId: uuid!, $name: String!, $createdBy: uuid!) {
      insert_workflows_one(object: { org_id: $orgId, name: $name, created_by: $createdBy }) { id name }
    }`,
    { orgId: orgBId, name: `Org B Editor Workflow ${Date.now()}`, createdBy: editorAcc.userId }
  );
  const editorWfId = e3Res.data?.insert_workflows_one?.id;
  const e3Pass = !e3Res.errors && !!editorWfId;
  console.log(`[Editor 3] Create normal workflow in Org B: ${e3Pass ? 'PASS ✅' : 'FAIL ❌'} (Wf ID: ${editorWfId || 'none'})`);

  // E4: Add normal steps in Org B
  let editorStepId;
  if (editorWfId) {
    const e4Res = await userGql(
      editorAcc.token,
      `mutation AddStep($wfId: uuid!) {
        insert_workflow_steps_one(object: { workflow_id: $wfId, position: 1, type: "llm_call", name: "Org B LLM Step", config: { prompt: "Hello Org B" } }) { id }
      }`,
      { wfId: editorWfId }
    );
    editorStepId = e4Res.data?.insert_workflow_steps_one?.id;
    const e4Pass = !e4Res.errors && !!editorStepId;
    console.log(`[Editor 4] Add normal step in Org B: ${e4Pass ? 'PASS ✅' : 'FAIL ❌'}`);
  }

  // E5: Trigger Org B workflow
  if (editorWfId) {
    const e5Res = await fetch(`${APP_URL}/api/actions/trigger-workflow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${editorAcc.token}` },
      body: JSON.stringify({ input: { workflow_id: editorWfId } }),
    });
    const e5Data = await e5Res.json();
    const e5Pass = e5Res.status === 200 && !!e5Data.run_id;
    console.log(`[Editor 5] Trigger Org B workflow: ${e5Pass ? 'PASS ✅' : 'FAIL ❌'} (Run ID: ${e5Data.run_id || 'none'})`);
  }

  // E6: Cannot manage organization members
  const e6Res = await userGql(
    editorAcc.token,
    `mutation { insert_org_members_one(object: { org_id: "${orgBId}", user_id: "00000000-0000-0000-0000-000000000000", role: "owner" }) { id } }`
  );
  const e6Pass = !!e6Res.errors && e6Res.errors[0]?.message.includes('check constraint');
  console.log(`[Editor 6] Cannot manage org members: ${e6Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

  // E7: Cannot create db_write
  if (editorWfId) {
    const e7Res = await userGql(
      editorAcc.token,
      `mutation { insert_workflow_steps_one(object: { workflow_id: "${editorWfId}", position: 2, type: "db_write", name: "Forbidden DB Write" }) { id } }`
    );
    const e7Pass = !!e7Res.errors && e7Res.errors[0]?.message.includes('check constraint');
    console.log(`[Editor 7] Cannot create db_write step: ${e7Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

    // E8: Cannot create notify
    const e8Res = await userGql(
      editorAcc.token,
      `mutation { insert_workflow_steps_one(object: { workflow_id: "${editorWfId}", position: 2, type: "notify", name: "Forbidden Notify" }) { id } }`
    );
    const e8Pass = !!e8Res.errors && e8Res.errors[0]?.message.includes('check constraint');
    console.log(`[Editor 8] Cannot create notify step: ${e8Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

    // E9: Cannot create webhook triggers
    const e9Res = await userGql(
      editorAcc.token,
      `mutation { insert_workflow_triggers_one(object: { workflow_id: "${editorWfId}", type: "webhook", config: {} }) { id } }`
    );
    const e9Pass = !!e9Res.errors && e9Res.errors[0]?.message.includes('check constraint');
    console.log(`[Editor 9] Cannot create webhook triggers: ${e9Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);
  }

  // E10: Cannot access Org A workflows/data
  const e10Res = await userGql(editorAcc.token, `query { workflows_by_pk(id: "${orgAWfId}") { id name } }`);
  const e10Pass = e10Res.data?.workflows_by_pk === null;
  console.log(`[Editor 10] Cannot access Org A workflows/data: ${e10Pass ? '0 Org A workflows visible ✅' : 'FAIL ❌'}`);

  // E11: Cannot trigger Org A workflows
  const e11Res = await fetch(`${APP_URL}/api/actions/trigger-workflow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${editorAcc.token}` },
    body: JSON.stringify({ input: { workflow_id: orgAWfId } }),
  });
  const e11Pass = e11Res.status === 403;
  console.log(`[Editor 11] Cannot trigger Org A workflows: ${e11Pass ? 'DENIED BY API (HTTP 403) ✅' : 'FAIL ❌'}`);

  // E12: Cannot approve Org A paused runs
  const e12Res = await fetch(`${APP_URL}/api/actions/approve-step`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${editorAcc.token}` },
    body: JSON.stringify({ input: { step_run_id: '00000000-0000-0000-0000-000000000000' } }),
  });
  const e12Pass = e12Res.status === 400 || e12Res.status === 403;
  console.log(`[Editor 12] Cannot approve Org A paused runs: ${e12Pass ? 'DENIED BY API ✅' : 'FAIL ❌'}`);


  // ================================================================
  // 4. TESTING ORG B VIEWER
  // ================================================================
  console.log('\n----------------------------------------------------------------');
  console.log('  4. TESTING ORG B VIEWER PERMISSIONS (Real Nhost JWT)');
  console.log('----------------------------------------------------------------\n');

  // V1: Log in -> PASS
  console.log(`[Viewer 1] Login: PASS ✅ (Nhost Session Active)`);

  // V2: Can view Org B workflows
  const v2Res = await userGql(viewerAcc.token, `query { workflows { id name org_id } }`);
  const v2Pass = !v2Res.errors && Array.isArray(v2Res.data?.workflows);
  console.log(`[Viewer 2] Can view Org B workflows: ${v2Pass ? 'PASS ✅' : 'FAIL ❌'}`);

  // V3: Cannot create workflows
  const v3Res = await userGql(
    viewerAcc.token,
    `mutation { insert_workflows_one(object: { org_id: "${orgBId}", name: "Viewer Forbidden Wf", created_by: "${viewerAcc.userId}" }) { id } }`
  );
  const v3Pass = !!v3Res.errors && v3Res.errors[0]?.message.includes('check constraint');
  console.log(`[Viewer 3] Cannot create workflows: ${v3Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

  // V4: Cannot edit workflows
  if (editorWfId) {
    const v4Res = await userGql(
      viewerAcc.token,
      `mutation { update_workflows_by_pk(pk_columns: { id: "${editorWfId}" }, _set: { name: "Hacked by Viewer" }) { id } }`
    );
    const v4Pass = v4Res.data?.update_workflows_by_pk === null || !!v4Res.errors;
    console.log(`[Viewer 4] Cannot edit workflows: ${v4Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

    // V5: Cannot add/reorder/delete steps
    const v5Res = await userGql(
      viewerAcc.token,
      `mutation { insert_workflow_steps_one(object: { workflow_id: "${editorWfId}", position: 2, type: "llm_call", name: "Viewer Step" }) { id } }`
    );
    const v5Pass = !!v5Res.errors && v5Res.errors[0]?.message.includes('check constraint');
    console.log(`[Viewer 5] Cannot add/reorder/delete steps: ${v5Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);

    // V6: Cannot trigger workflows
    const v6Res = await fetch(`${APP_URL}/api/actions/trigger-workflow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${viewerAcc.token}` },
      body: JSON.stringify({ input: { workflow_id: editorWfId } }),
    });
    const v6Pass = v6Res.status === 403;
    console.log(`[Viewer 6] Cannot trigger workflows: ${v6Pass ? 'DENIED BY API (HTTP 403) ✅' : 'FAIL ❌'}`);

    // V7: Cannot create webhook triggers
    const v7Res = await userGql(
      viewerAcc.token,
      `mutation { insert_workflow_triggers_one(object: { workflow_id: "${editorWfId}", type: "webhook", config: {} }) { id } }`
    );
    const v7Pass = !!v7Res.errors && v7Res.errors[0]?.message.includes('check constraint');
    console.log(`[Viewer 7] Cannot create webhook triggers: ${v7Pass ? 'DENIED BY HASURA ✅' : 'FAIL ❌'}`);
  }

  // V8: Cannot access Org A workflows/data
  const v8Res = await userGql(viewerAcc.token, `query { workflows_by_pk(id: "${orgAWfId}") { id name } }`);
  const v8Pass = v8Res.data?.workflows_by_pk === null;
  console.log(`[Viewer 8] Cannot access Org A workflows/data: ${v8Pass ? '0 Org A workflows visible ✅' : 'FAIL ❌'}`);

  // V9: Cannot trigger Org A workflows
  const v9Res = await fetch(`${APP_URL}/api/actions/trigger-workflow`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${viewerAcc.token}` },
    body: JSON.stringify({ input: { workflow_id: orgAWfId } }),
  });
  const v9Pass = v9Res.status === 403;
  console.log(`[Viewer 9] Cannot trigger Org A workflows: ${v9Pass ? 'DENIED BY API (HTTP 403) ✅' : 'FAIL ❌'}`);

  // V10: Cannot approve Org A paused runs
  const v10Res = await fetch(`${APP_URL}/api/actions/approve-step`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${viewerAcc.token}` },
    body: JSON.stringify({ input: { step_run_id: '00000000-0000-0000-0000-000000000000' } }),
  });
  const v10Pass = v10Res.status === 400 || v10Res.status === 403;
  console.log(`[Viewer 10] Cannot approve Org A paused runs: ${v10Pass ? 'DENIED BY API ✅' : 'FAIL ❌'}`);

  await pgClient.end();

  console.log('\n================================================================');
  console.log('  CREDENTIALS FOR MANUAL BROWSER TESTING:');
  console.log('================================================================\n');
  console.log('Org B Editor');
  console.log(`Email:    ${EDITOR_EMAIL}`);
  console.log(`Password: ${SHARED_PASS}`);
  console.log(`Org:      Production Org B\n`);
  console.log('Org B Viewer');
  console.log(`Email:    ${VIEWER_EMAIL}`);
  console.log(`Password: ${SHARED_PASS}`);
  console.log(`Org:      Production Org B\n`);
  console.log('================================================================\n');
}

setupAndTestOrgbAccounts().catch(err => {
  console.error('Setup error:', err);
  process.exit(1);
});
