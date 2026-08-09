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

async function runLayer1SecuritySuite() {
  console.log('================================================================');
  console.log('  LAYER 1 MULTI-TENANT CROSS-ORGANIZATION SECURITY TEST SUITE');
  console.log('================================================================\n');

  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  const dbUrl = process.env.DATABASE_URL;

  const pgClient = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  // Create two distinct UUIDs for User A and User B
  const userA_id = '11111111-1111-4111-a111-111111111111';
  const userB_id = '22222222-2222-4222-b222-222222222222';

  console.log('✓ User A ID (Org A Owner):', userA_id);
  console.log('✓ User B ID (Org B Owner):', userB_id);

  // Setup Org A & Org B in database
  console.log('\nSetting up isolated Org A & Org B in database...');
  await pgClient.query('BEGIN');

  // Clean up any existing test records
  await pgClient.query("DELETE FROM public.organizations WHERE name LIKE 'Org A Isolation Target%' OR name LIKE 'Org B Security Tester%';");

  // Org A & Member A
  const orgARes = await pgClient.query("INSERT INTO public.organizations (name) VALUES ('Org A Isolation Target') RETURNING id;");
  const orgA_id = orgARes.rows[0].id;
  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner');", [orgA_id, userA_id]);

  // Org B & Member B
  const orgBRes = await pgClient.query("INSERT INTO public.organizations (name) VALUES ('Org B Security Tester') RETURNING id;");
  const orgB_id = orgBRes.rows[0].id;
  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner');", [orgB_id, userB_id]);

  // Org A Workflow, Step, Trigger, Run, Step Run
  const wfARes = await pgClient.query(
    "INSERT INTO public.workflows (org_id, name, description, created_by) VALUES ($1, 'Org A Confidential Workflow', 'Secret Org A Process', $2) RETURNING id;",
    [orgA_id, userA_id]
  );
  const orgA_wf_id = wfARes.rows[0].id;

  const stepARes = await pgClient.query(
    "INSERT INTO public.workflow_steps (workflow_id, position, type, name) VALUES ($1, 1, 'llm_call', 'Org A Secret Step') RETURNING id;",
    [orgA_wf_id]
  );
  const orgA_step_id = stepARes.rows[0].id;

  const trigARes = await pgClient.query(
    "INSERT INTO public.workflow_triggers (workflow_id, type) VALUES ($1, 'manual') RETURNING id;",
    [orgA_wf_id]
  );
  const orgA_trig_id = trigARes.rows[0].id;

  const runARes = await pgClient.query(
    "INSERT INTO public.workflow_runs (workflow_id, trigger_type, status, created_by) VALUES ($1, 'manual', 'running', $2) RETURNING id;",
    [orgA_wf_id, userA_id]
  );
  const orgA_run_id = runARes.rows[0].id;

  const stepRunARes = await pgClient.query(
    "INSERT INTO public.step_runs (workflow_run_id, workflow_step_id, status) VALUES ($1, $2, 'running') RETURNING id;",
    [orgA_run_id, orgA_step_id]
  );
  const orgA_step_run_id = stepRunARes.rows[0].id;

  await pgClient.query('COMMIT');

  console.log('✓ Created Org A Workflow UUID:', orgA_wf_id);
  console.log('✓ Created Org A Step UUID:', orgA_step_id);
  console.log('✓ Created Org A Trigger UUID:', orgA_trig_id);
  console.log('✓ Created Org A Run UUID:', orgA_run_id);
  console.log('✓ Created Org A Step Run UUID:', orgA_step_run_id);

  // Helper for GraphQL fetch evaluating Hasura role "user" and session variable x-hasura-user-id
  async function executeUserGql(userId, query, variables = {}) {
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

  const resultsTable = [];

  // =================================================================
  // TEST 1 — Direct workflow UUID guessing
  // =================================================================
  console.log('\n--- Test 1: Direct workflow UUID guessing ---');
  const t1Query = `
    query GuessWorkflow($id: uuid!) {
      workflows_by_pk(id: $id) {
        id
        name
        org_id
      }
    }
  `;
  const t1Res = await executeUserGql(userB_id, t1Query, { id: orgA_wf_id });
  const t1Actual = JSON.stringify(t1Res.data?.workflows_by_pk || null);
  const t1Pass = t1Res.data?.workflows_by_pk === null && !t1Res.errors;
  console.log(`Result: ${t1Pass ? 'PASS' : 'FAIL'} (Actual: ${t1Actual})`);
  resultsTable.push({
    test: 'Test 1 — Direct workflow UUID guessing',
    user: 'User B (Org B Owner)',
    op: 'workflows_by_pk(id: Org A UUID)',
    target: 'Org A Workflow',
    expected: 'null (0 rows)',
    actual: t1Actual,
    result: t1Pass ? 'PASS' : 'FAIL',
  });

  // =================================================================
  // TEST 2 — Workflow list isolation
  // =================================================================
  console.log('\n--- Test 2: Workflow list isolation ---');
  const t2Query = `
    query ListWorkflows {
      workflows {
        id
        name
        org_id
      }
    }
  `;
  const t2Res = await executeUserGql(userB_id, t2Query);
  const t2OrgAWorkflows = (t2Res.data?.workflows || []).filter((w) => w.id === orgA_wf_id);
  const t2Actual = `Returned ${t2Res.data?.workflows?.length || 0} total workflows, ${t2OrgAWorkflows.length} from Org A`;
  const t2Pass = t2OrgAWorkflows.length === 0;
  console.log(`Result: ${t2Pass ? 'PASS' : 'FAIL'} (${t2Actual})`);
  resultsTable.push({
    test: 'Test 2 — Workflow list isolation',
    user: 'User B (Org B Owner)',
    op: 'query workflows',
    target: 'Org A Workflows',
    expected: '0 Org A workflows',
    actual: t2Actual,
    result: t2Pass ? 'PASS' : 'FAIL',
  });

  // =================================================================
  // TEST 3 — Child resource guessing
  // =================================================================
  console.log('\n--- Test 3: Child resource guessing ---');
  const t3Query = `
    query GuessChildResources($stepId: uuid!, $trigId: uuid!, $runId: uuid!, $stepRunId: uuid!) {
      workflow_steps_by_pk(id: $stepId) { id name }
      workflow_triggers_by_pk(id: $trigId) { id type }
      workflow_runs_by_pk(id: $runId) { id status }
      step_runs_by_pk(id: $stepRunId) { id status }
    }
  `;
  const t3Res = await executeUserGql(userB_id, t3Query, {
    stepId: orgA_step_id,
    trigId: orgA_trig_id,
    runId: orgA_run_id,
    stepRunId: orgA_step_run_id,
  });
  const t3AllNull =
    t3Res.data?.workflow_steps_by_pk === null &&
    t3Res.data?.workflow_triggers_by_pk === null &&
    t3Res.data?.workflow_runs_by_pk === null &&
    t3Res.data?.step_runs_by_pk === null;
  const t3Actual = JSON.stringify(t3Res.data || {});
  console.log(`Result: ${t3AllNull ? 'PASS' : 'FAIL'} (Actual: ${t3Actual})`);
  resultsTable.push({
    test: 'Test 3 — Child resource guessing',
    user: 'User B (Org B Owner)',
    op: 'by_pk query on steps, triggers, runs, step_runs',
    target: 'Org A Child Resources',
    expected: 'null for all child resources',
    actual: t3AllNull ? 'all null' : t3Actual,
    result: t3AllNull ? 'PASS' : 'FAIL',
  });

  // =================================================================
  // TEST 4 — UPDATE attack
  // =================================================================
  console.log('\n--- Test 4: UPDATE attack ---');
  const t4Mutation = `
    mutation AttackUpdateWorkflow($id: uuid!, $name: String!) {
      update_workflows_by_pk(pk_columns: { id: $id }, _set: { name: $name }) {
        id
        name
      }
    }
  `;
  const t4Res = await executeUserGql(userB_id, t4Mutation, { id: orgA_wf_id, name: 'HACKED BY USER B' });
  const t4Actual = JSON.stringify(t4Res.data?.update_workflows_by_pk || null);
  const t4Pass = t4Res.data?.update_workflows_by_pk === null || !!t4Res.errors;
  console.log(`Result: ${t4Pass ? 'PASS' : 'FAIL'} (Actual: ${t4Actual})`);
  resultsTable.push({
    test: 'Test 4 — UPDATE attack',
    user: 'User B (Org B Owner)',
    op: 'update_workflows_by_pk',
    target: 'Org A Workflow',
    expected: 'null / 0 affected rows',
    actual: t4Actual,
    result: t4Pass ? 'PASS' : 'FAIL',
  });

  // =================================================================
  // TEST 5 — DELETE attack
  // =================================================================
  console.log('\n--- Test 5: DELETE attack ---');
  const t5Mutation = `
    mutation AttackDeleteWorkflow($id: uuid!) {
      delete_workflows_by_pk(id: $id) {
        id
      }
    }
  `;
  const t5Res = await executeUserGql(userB_id, t5Mutation, { id: orgA_wf_id });
  const t5Actual = JSON.stringify(t5Res.data?.delete_workflows_by_pk || null);
  const t5Pass = t5Res.data?.delete_workflows_by_pk === null || !!t5Res.errors;
  console.log(`Result: ${t5Pass ? 'PASS' : 'FAIL'} (Actual: ${t5Actual})`);
  resultsTable.push({
    test: 'Test 5 — DELETE attack',
    user: 'User B (Org B Owner)',
    op: 'delete_workflows_by_pk',
    target: 'Org A Workflow',
    expected: 'null / 0 affected rows',
    actual: t5Actual,
    result: t5Pass ? 'PASS' : 'FAIL',
  });

  // =================================================================
  // TEST 6 — INSERT attack
  // =================================================================
  console.log('\n--- Test 6: INSERT attack ---');
  const t6Mutation = `
    mutation AttackInsertIntoOrgA($orgId: uuid!, $wfId: uuid!, $userIdB: uuid!) {
      insert_workflows_one(object: { org_id: $orgId, name: "Malicious Workflow", created_by: $userIdB }) {
        id
      }
    }
  `;
  const t6Res = await executeUserGql(userB_id, t6Mutation, { orgId: orgA_id, wfId: orgA_wf_id, userIdB: userB_id });
  const t6Pass = !!t6Res.errors;
  const t6Actual = t6Res.errors ? `DENIED: ${t6Res.errors[0].message}` : JSON.stringify(t6Res.data);
  console.log(`Result: ${t6Pass ? 'PASS' : 'FAIL'} (Actual: ${t6Actual})`);
  resultsTable.push({
    test: 'Test 6 — INSERT attack',
    user: 'User B (Org B Owner)',
    op: 'insert workflow into Org A',
    target: 'Org A Resources',
    expected: 'ALL DENIED',
    actual: t6Actual,
    result: t6Pass ? 'PASS' : 'FAIL',
  });

  // =================================================================
  // TEST 7 — org_members privilege escalation
  // =================================================================
  console.log('\n--- Test 7: org_members privilege escalation ---');
  const t7Mutation = `
    mutation AttackOrgMembers($orgId: uuid!, $userIdB: uuid!) {
      insert_org_members_one(object: { org_id: $orgId, user_id: $userIdB, role: "owner" }) {
        id
      }
    }
  `;
  const t7Res = await executeUserGql(userB_id, t7Mutation, { orgId: orgA_id, userIdB: userB_id });
  const t7Pass = !!t7Res.errors;
  const t7Actual = t7Res.errors ? `DENIED: ${t7Res.errors[0].message}` : JSON.stringify(t7Res.data);
  console.log(`Result: ${t7Pass ? 'PASS' : 'FAIL'} (Actual: ${t7Actual})`);
  resultsTable.push({
    test: 'Test 7 — org_members escalation',
    user: 'User B (Org B Owner)',
    op: 'insert into org_members (Org A)',
    target: 'Org A Membership',
    expected: 'ALL DENIED',
    actual: t7Actual,
    result: t7Pass ? 'PASS' : 'FAIL',
  });

  // =================================================================
  // TEST 8 — Legitimate Org A access
  // =================================================================
  console.log('\n--- Test 8: Legitimate Org A access ---');
  const t8Query = `
    query LegitimateOrgARead($id: uuid!) {
      workflows_by_pk(id: $id) {
        id
        name
        org_id
      }
    }
  `;
  const t8Res = await executeUserGql(userA_id, t8Query, { id: orgA_wf_id });
  const t8Pass = t8Res.data?.workflows_by_pk?.id === orgA_wf_id;
  const t8Actual = JSON.stringify(t8Res.data?.workflows_by_pk || null);
  console.log(`Result: ${t8Pass ? 'PASS' : 'FAIL'} (Actual: ${t8Actual})`);
  resultsTable.push({
    test: 'Test 8 — Legitimate Org A access',
    user: 'User A (Org A Owner)',
    op: 'workflows_by_pk(id: Org A UUID)',
    target: 'Org A Workflow',
    expected: 'Returned Org A workflow',
    actual: t8Actual,
    result: t8Pass ? 'PASS' : 'FAIL',
  });

  await pgClient.end();

  // Print Summary Table
  console.log('\n================================================================');
  console.table(resultsTable);
  console.log('================================================================\n');

  // Create docs/layer1-security-verification.md
  const docPath = path.join(__dirname, '..', 'docs', 'layer1-security-verification.md');
  const docDir = path.dirname(docPath);
  if (!fs.existsSync(docDir)) {
    fs.mkdirSync(docDir, { recursive: true });
  }

  const docContent = `# Layer 1 Security Verification Report

This document records the empirical verification results for Hasura row-level permission rules and multi-tenant organization isolation.

## Security Verification Matrix

| Test | JWT User | Operation | Target Org | Expected | Actual | Result |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
${resultsTable.map((r) => `| **${r.test}** | ${r.user} | \`${r.op}\` | ${r.target} | ${r.expected} | \`${r.actual.replace(/\|/g, '\\|')}\` | **${r.result}** |`).join('\n')}

---

## Executed GraphQL Operations

### Test 1 — Direct Workflow UUID Guessing
\`\`\`graphql
query GuessWorkflow($id: uuid!) {
  workflows_by_pk(id: $id) {
    id
    name
    org_id
  }
}
\`\`\`

### Test 2 — Workflow List Isolation
\`\`\`graphql
query ListWorkflows {
  workflows {
    id
    name
    org_id
  }
}
\`\`\`

### Test 3 — Child Resource Guessing
\`\`\`graphql
query GuessChildResources($stepId: uuid!, $trigId: uuid!, $runId: uuid!, $stepRunId: uuid!) {
  workflow_steps_by_pk(id: $stepId) { id name }
  workflow_triggers_by_pk(id: $trigId) { id type }
  workflow_runs_by_pk(id: $runId) { id status }
  step_runs_by_pk(id: $stepRunId) { id status }
}
\`\`\`

### Test 4 — UPDATE Attack
\`\`\`graphql
mutation AttackUpdateWorkflow($id: uuid!, $name: String!) {
  update_workflows_by_pk(pk_columns: { id: $id }, _set: { name: $name }) {
    id
    name
  }
}
\`\`\`

### Test 5 — DELETE Attack
\`\`\`graphql
mutation AttackDeleteWorkflow($id: uuid!) {
  delete_workflows_by_pk(id: $id) {
    id
  }
}
\`\`\`

### Test 6 — INSERT Attack
\`\`\`graphql
mutation AttackInsertIntoOrgA($orgId: uuid!, $wfId: uuid!, $userIdB: uuid!) {
  insert_workflows_one(object: { org_id: $orgId, name: "Malicious Workflow", created_by: $userIdB }) { id }
}
\`\`\`

### Test 7 — org_members Escalation
\`\`\`graphql
mutation AttackOrgMembers($orgId: uuid!, $userIdB: uuid!) {
  insert_org_members_one(object: { org_id: $orgId, user_id: $userIdB, role: "owner" }) { id }
}
\`\`\`

### Test 8 — Legitimate Org A Access
\`\`\`graphql
query LegitimateOrgARead($id: uuid!) {
  workflows_by_pk(id: $id) {
    id
    name
    org_id
  }
}
\`\`\`
`;

  fs.writeFileSync(docPath, docContent, 'utf8');
  console.log(`✓ Generated documentation at docs/layer1-security-verification.md`);
}

runLayer1SecuritySuite();
