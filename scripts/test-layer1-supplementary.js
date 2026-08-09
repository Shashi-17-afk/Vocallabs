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

async function runSupplementarySecuritySuite() {
  console.log('================================================================');
  console.log('  SUPPLEMENTARY LAYER 1 AUTHORIZATION TEST SUITE');
  console.log('================================================================\n');

  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  const dbUrl = process.env.DATABASE_URL;

  const pgClient = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const userA_id = '11111111-1111-4111-a111-111111111111';
  const userB_id = '22222222-2222-4222-b222-222222222222';

  // Setup Org A & Org B in DB
  await pgClient.query('BEGIN');
  await pgClient.query("DELETE FROM public.organizations WHERE name LIKE 'Org A Supplementary%' OR name LIKE 'Org B Supplementary%';");

  const orgARes = await pgClient.query("INSERT INTO public.organizations (name) VALUES ('Org A Supplementary Target') RETURNING id;");
  const orgA_id = orgARes.rows[0].id;
  const memARes = await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner') RETURNING id;", [orgA_id, userA_id]);
  const orgA_member_id = memARes.rows[0].id;

  const orgBRes = await pgClient.query("INSERT INTO public.organizations (name) VALUES ('Org B Supplementary Tester') RETURNING id;");
  const orgB_id = orgBRes.rows[0].id;
  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner');", [orgB_id, userB_id]);

  const wfARes = await pgClient.query("INSERT INTO public.workflows (org_id, name, description, created_by) VALUES ($1, 'Org A Workflow', 'Target', $2) RETURNING id;", [orgA_id, userA_id]);
  const orgA_wf_id = wfARes.rows[0].id;

  await pgClient.query('COMMIT');

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

  const results = [];

  // 1A. UPDATE Org A membership
  console.log('Testing 1A: UPDATE Org A membership...');
  const m1a = `mutation UpdateOrgAMember($id: uuid!) { update_org_members_by_pk(pk_columns: {id: $id}, _set: {role: "editor"}) { id role } }`;
  const r1a = await executeUserGql(userB_id, m1a, { id: orgA_member_id });
  const pass1a = r1a.data?.update_org_members_by_pk === null || !!r1a.errors;
  results.push({ test: '1A — UPDATE Org A membership', expected: 'DENIED / null', actual: String(r1a.data?.update_org_members_by_pk || r1a.errors?.[0]?.message || 'null'), pass: pass1a });

  // 1B. DELETE Org A membership
  console.log('Testing 1B: DELETE Org A membership...');
  const m1b = `mutation DeleteOrgAMember($id: uuid!) { delete_org_members_by_pk(id: $id) { id } }`;
  const r1b = await executeUserGql(userB_id, m1b, { id: orgA_member_id });
  const pass1b = r1b.data?.delete_org_members_by_pk === null || !!r1b.errors;
  results.push({ test: '1B — DELETE Org A membership', expected: 'DENIED / null', actual: String(r1b.data?.delete_org_members_by_pk || r1b.errors?.[0]?.message || 'null'), pass: pass1b });

  // 1C. Change Org A user role to owner/editor
  console.log('Testing 1C: Change Org A user role...');
  const m1c = `mutation BulkUpdateOrgARole($orgId: uuid!) { update_org_members(where: {org_id: {_eq: $orgId}}, _set: {role: "owner"}) { affected_rows } }`;
  const r1c = await executeUserGql(userB_id, m1c, { orgId: orgA_id });
  const pass1c = r1c.data?.update_org_members?.affected_rows === 0 || !!r1c.errors;
  results.push({ test: '1C — Change Org A user role', expected: 'DENIED / 0 affected rows', actual: JSON.stringify(r1c.data?.update_org_members || r1c.errors?.[0]?.message || {}), pass: pass1c });

  // 1D. Add/change Org B user membership into Org A
  console.log('Testing 1D: Add User B to Org A...');
  const m1d = `mutation AddUserBToOrgA($orgId: uuid!, $userBId: uuid!) { insert_org_members_one(object: {org_id: $orgId, user_id: $userBId, role: "owner"}) { id } }`;
  const r1d = await executeUserGql(userB_id, m1d, { orgId: orgA_id, userBId: userB_id });
  const pass1d = !!r1d.errors;
  results.push({ test: '1D — Add User B to Org A', expected: 'DENIED', actual: r1d.errors ? `DENIED: ${r1d.errors[0].message}` : JSON.stringify(r1d.data), pass: pass1d });

  // 2A. Insert workflow_step referencing Org A workflow
  console.log('Testing 2A: Insert workflow_step referencing Org A workflow...');
  const m2a = `mutation InsertStepInOrgA($wfId: uuid!) { insert_workflow_steps_one(object: {workflow_id: $wfId, position: 1, type: "llm_call", name: "Malicious Step"}) { id } }`;
  const r2a = await executeUserGql(userB_id, m2a, { wfId: orgA_wf_id });
  const pass2a = !!r2a.errors;
  results.push({ test: '2A — Insert workflow_step into Org A', expected: 'DENIED', actual: r2a.errors ? `DENIED: ${r2a.errors[0].message}` : JSON.stringify(r2a.data), pass: pass2a });

  // 2B. Insert workflow_trigger referencing Org A workflow
  console.log('Testing 2B: Insert workflow_trigger referencing Org A workflow...');
  const m2b = `mutation InsertTriggerInOrgA($wfId: uuid!) { insert_workflow_triggers_one(object: {workflow_id: $wfId, type: "manual"}) { id } }`;
  const r2b = await executeUserGql(userB_id, m2b, { wfId: orgA_wf_id });
  const pass2b = !!r2b.errors;
  results.push({ test: '2B — Insert workflow_trigger into Org A', expected: 'DENIED', actual: r2b.errors ? `DENIED: ${r2b.errors[0].message}` : JSON.stringify(r2b.data), pass: pass2b });

  await pgClient.end();

  console.log('\n================================================================');
  console.table(results);
  console.log('================================================================\n');

  // Append to docs/layer1-security-verification.md
  const docPath = path.join(__dirname, '..', 'docs', 'layer1-security-verification.md');
  const existingDoc = fs.readFileSync(docPath, 'utf8');

  const appendText = `
---

## Supplementary Authorization & Escalation Verification

| Test | Expected | Actual | Result |
| :--- | :--- | :--- | :--- |
${results.map(r => `| **${r.test}** | ${r.expected} | \`${r.actual.replace(/\|/g, '\\|')}\` | **${r.pass ? 'PASS' : 'FAIL'}** |`).join('\n')}
`;

  fs.writeFileSync(docPath, existingDoc + appendText, 'utf8');
  console.log('✓ Appended supplementary test results to docs/layer1-security-verification.md');
}

runSupplementarySecuritySuite();
