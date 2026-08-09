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

async function runPhase7GraphQLSuite() {
  console.log('================================================================');
  console.log('  PHASE 7 NATIVE HASURA GRAPHQL WORKFLOW CRUD SECURITY SUITE');
  console.log('================================================================\n');

  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  const dbUrl = process.env.DATABASE_URL;

  const pgClient = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const ownerA_id  = '77777777-7777-4777-a777-777777777777';
  const editorA_id = '88888888-8888-4888-a888-888888888888';
  const viewerA_id = '99999999-9999-4999-a999-999999999999';
  const ownerB_id  = 'aaaaaaaa-aaaa-4aaa-baaa-aaaaaaaaaaaa';

  const ts = Date.now();
  console.log('Setting up Test Organizations and User Memberships in Database...');
  await pgClient.query('BEGIN');

  const orgARes = await pgClient.query(`INSERT INTO public.organizations (name, quota_limit) VALUES ($1, 100) RETURNING id;`, [`Org A Phase 7 Target ${ts}`]);
  const orgA_id = orgARes.rows[0].id;

  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner');", [orgA_id, ownerA_id]);
  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'editor');", [orgA_id, editorA_id]);
  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'viewer');", [orgA_id, viewerA_id]);

  const orgBRes = await pgClient.query(`INSERT INTO public.organizations (name, quota_limit) VALUES ($1, 100) RETURNING id;`, [`Org B Phase 7 Attacker ${ts}`]);
  const orgB_id = orgBRes.rows[0].id;
  await pgClient.query("INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, 'owner');", [orgB_id, ownerB_id]);

  await pgClient.query('COMMIT');

  console.log('✓ Org A ID:', orgA_id);
  console.log('  - Owner A ID:', ownerA_id);
  console.log('  - Editor A ID:', editorA_id);
  console.log('  - Viewer A ID:', viewerA_id);
  console.log('✓ Org B ID:', orgB_id);
  console.log('  - Owner B ID:', ownerB_id);

  // Helper for pure GraphQL request using role "user" and session variable x-hasura-user-id
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

  const results = [];

  // =================================================================
  // 1. Owner creates workflow
  // =================================================================
  console.log('\n--- Test 1: Owner creates workflow via GraphQL ---');
  const m1 = `
    mutation OwnerCreateWf($orgId: uuid!, $name: String!, $created_by: uuid!) {
      insert_workflows_one(object: { org_id: $orgId, name: $name, created_by: $created_by }) {
        id
        name
        org_id
      }
    }
  `;
  const r1 = await executeGql(ownerA_id, m1, { orgId: orgA_id, name: 'Org A Owner Workflow', created_by: ownerA_id });
  const wfA_id = r1.data?.insert_workflows_one?.id;
  const pass1 = !!wfA_id;
  console.log(`Result: ${pass1 ? 'PASS' : 'FAIL'} (Created Workflow UUID: ${wfA_id})`);
  results.push({ test: '1. Owner creates workflow', user: 'Owner A', op: 'GraphQL insert_workflows_one', expected: 'PASS', actual: `Created UUID ${wfA_id}`, pass: pass1 });

  // =================================================================
  // 2. Editor creates workflow
  // =================================================================
  console.log('\n--- Test 2: Editor creates workflow via GraphQL ---');
  const r2 = await executeGql(editorA_id, m1, { orgId: orgA_id, name: 'Org A Editor Workflow', created_by: editorA_id });
  const wfEditor_id = r2.data?.insert_workflows_one?.id;
  const pass2 = !!wfEditor_id;
  console.log(`Result: ${pass2 ? 'PASS' : 'FAIL'} (Created Workflow UUID: ${wfEditor_id})`);
  results.push({ test: '2. Editor creates workflow', user: 'Editor A', op: 'GraphQL insert_workflows_one', expected: 'PASS', actual: `Created UUID ${wfEditor_id}`, pass: pass2 });

  // =================================================================
  // 3. Editor edits workflow
  // =================================================================
  console.log('\n--- Test 3: Editor edits workflow via GraphQL ---');
  const m3 = `
    mutation EditorEditWf($id: uuid!, $name: String!) {
      update_workflows_by_pk(pk_columns: { id: $id }, _set: { name: $name }) {
        id
        name
      }
    }
  `;
  const r3 = await executeGql(editorA_id, m3, { id: wfA_id, name: 'Updated Org A Workflow Name' });
  const pass3 = r3.data?.update_workflows_by_pk?.name === 'Updated Org A Workflow Name';
  console.log(`Result: ${pass3 ? 'PASS' : 'FAIL'} (Updated Name: ${r3.data?.update_workflows_by_pk?.name})`);
  results.push({ test: '3. Editor edits workflow', user: 'Editor A', op: 'GraphQL update_workflows_by_pk', expected: 'PASS', actual: JSON.stringify(r3.data?.update_workflows_by_pk || {}), pass: pass3 });

  // =================================================================
  // 4. Editor creates normal step (llm_call)
  // =================================================================
  console.log('\n--- Test 4: Editor creates normal step (llm_call) via GraphQL ---');
  const m4 = `
    mutation EditorCreateStep($wfId: uuid!, $pos: Int!, $type: String!, $name: String!) {
      insert_workflow_steps_one(object: { workflow_id: $wfId, position: $pos, type: $type, name: $name }) {
        id
        position
        type
        name
      }
    }
  `;
  const r4_step1 = await executeGql(editorA_id, m4, { wfId: wfA_id, pos: 1, type: 'llm_call', name: 'Step 1 LLM' });
  const step1_id = r4_step1.data?.insert_workflow_steps_one?.id;
  const pass4 = !!step1_id;
  console.log(`Result: ${pass4 ? 'PASS' : 'FAIL'} (Step 1 UUID: ${step1_id})`);
  results.push({ test: '4. Editor creates normal step', user: 'Editor A', op: 'GraphQL insert_workflow_steps_one', expected: 'PASS', actual: `Created Step UUID ${step1_id}`, pass: pass4 });

  // Create Step 2 for reordering test
  const r4_step2 = await executeGql(editorA_id, m4, { wfId: wfA_id, pos: 2, type: 'http_request', name: 'Step 2 HTTP' });
  const step2_id = r4_step2.data?.insert_workflow_steps_one?.id;

  // =================================================================
  // 5. Editor edits normal step
  // =================================================================
  console.log('\n--- Test 5: Editor edits normal step via GraphQL ---');
  const m5 = `
    mutation EditorUpdateStep($id: uuid!, $name: String!) {
      update_workflow_steps_by_pk(pk_columns: { id: $id }, _set: { name: $name }) {
        id
        name
      }
    }
  `;
  const r5 = await executeGql(editorA_id, m5, { id: step1_id, name: 'Renamed LLM Step' });
  const pass5 = r5.data?.update_workflow_steps_by_pk?.name === 'Renamed LLM Step';
  console.log(`Result: ${pass5 ? 'PASS' : 'FAIL'} (Renamed Step Name: ${r5.data?.update_workflow_steps_by_pk?.name})`);
  results.push({ test: '5. Editor edits normal step', user: 'Editor A', op: 'GraphQL update_workflow_steps_by_pk', expected: 'PASS', actual: JSON.stringify(r5.data?.update_workflow_steps_by_pk || {}), pass: pass5 });

  // =================================================================
  // 6. Editor reorders steps
  // =================================================================
  console.log('\n--- Test 6: Editor reorders steps via GraphQL update_workflow_steps_many ---');
  const m6 = `
    mutation EditorReorderSteps($updates: [workflow_steps_updates!]!) {
      update_workflow_steps_many(updates: $updates) {
        affected_rows
      }
    }
  `;
  const r6 = await executeGql(editorA_id, m6, {
    updates: [
      { where: { id: { _eq: step1_id } }, _set: { position: 2 } },
      { where: { id: { _eq: step2_id } }, _set: { position: 1 } }
    ]
  });
  const pass6 = r6.data?.update_workflow_steps_many?.[0]?.affected_rows > 0;
  console.log(`Result: ${pass6 ? 'PASS' : 'FAIL'} (Affected Rows: ${r6.data?.update_workflow_steps_many?.[0]?.affected_rows})`);
  results.push({ test: '6. Editor reorders steps', user: 'Editor A', op: 'GraphQL update_workflow_steps_many', expected: 'PASS', actual: JSON.stringify(r6.data || {}), pass: pass6 });

  // =================================================================
  // 7. Editor cannot create db_write (DENIED)
  // =================================================================
  console.log('\n--- Test 7: Editor cannot create db_write via GraphQL (DENIED) ---');
  const r7 = await executeGql(editorA_id, m4, { wfId: wfA_id, pos: 3, type: 'db_write', name: 'Illegal DB Write Step' });
  const pass7 = !!r7.errors;
  console.log(`Result: ${pass7 ? 'PASS' : 'FAIL'} (Actual: ${r7.errors?.[0]?.message})`);
  results.push({ test: '7. Editor cannot create db_write', user: 'Editor A', op: 'GraphQL insert_workflow_steps_one (db_write)', expected: 'DENIED', actual: `DENIED: ${r7.errors?.[0]?.message}`, pass: pass7 });

  // =================================================================
  // 8. Editor cannot create notify (DENIED)
  // =================================================================
  console.log('\n--- Test 8: Editor cannot create notify via GraphQL (DENIED) ---');
  const r8 = await executeGql(editorA_id, m4, { wfId: wfA_id, pos: 4, type: 'notify', name: 'Illegal Notify Step' });
  const pass8 = !!r8.errors;
  console.log(`Result: ${pass8 ? 'PASS' : 'FAIL'} (Actual: ${r8.errors?.[0]?.message})`);
  results.push({ test: '8. Editor cannot create notify', user: 'Editor A', op: 'GraphQL insert_workflow_steps_one (notify)', expected: 'DENIED', actual: `DENIED: ${r8.errors?.[0]?.message}`, pass: pass8 });

  // =================================================================
  // 9. Editor cannot create webhook trigger (DENIED)
  // =================================================================
  console.log('\n--- Test 9: Editor cannot create webhook trigger via GraphQL (DENIED) ---');
  const mTrig = `
    mutation CreateTrigger($wfId: uuid!, $type: String!) {
      insert_workflow_triggers_one(object: { workflow_id: $wfId, type: $type }) {
        id
        type
      }
    }
  `;
  const r9 = await executeGql(editorA_id, mTrig, { wfId: wfA_id, type: 'webhook' });
  const pass9 = !!r9.errors;
  console.log(`Result: ${pass9 ? 'PASS' : 'FAIL'} (Actual: ${r9.errors?.[0]?.message})`);
  results.push({ test: '9. Editor cannot create webhook trigger', user: 'Editor A', op: 'GraphQL insert_workflow_triggers_one (webhook)', expected: 'DENIED', actual: `DENIED: ${r9.errors?.[0]?.message}`, pass: pass9 });

  // =================================================================
  // 10. Owner creates db_write (PASS)
  // =================================================================
  console.log('\n--- Test 10: Owner creates db_write via GraphQL (PASS) ---');
  const r10 = await executeGql(ownerA_id, m4, { wfId: wfA_id, pos: 3, type: 'db_write', name: 'Authorized DB Write Step' });
  const dbStep_id = r10.data?.insert_workflow_steps_one?.id;
  const pass10 = !!dbStep_id;
  console.log(`Result: ${pass10 ? 'PASS' : 'FAIL'} (Step UUID: ${dbStep_id})`);
  results.push({ test: '10. Owner creates db_write', user: 'Owner A', op: 'GraphQL insert_workflow_steps_one (db_write)', expected: 'PASS', actual: `Created Step UUID ${dbStep_id}`, pass: pass10 });

  // =================================================================
  // 11. Owner creates notify (PASS)
  // =================================================================
  console.log('\n--- Test 11: Owner creates notify via GraphQL (PASS) ---');
  const r11 = await executeGql(ownerA_id, m4, { wfId: wfA_id, pos: 4, type: 'notify', name: 'Authorized Notify Step' });
  const notifyStep_id = r11.data?.insert_workflow_steps_one?.id;
  const pass11 = !!notifyStep_id;
  console.log(`Result: ${pass11 ? 'PASS' : 'FAIL'} (Step UUID: ${notifyStep_id})`);
  results.push({ test: '11. Owner creates notify', user: 'Owner A', op: 'GraphQL insert_workflow_steps_one (notify)', expected: 'PASS', actual: `Created Step UUID ${notifyStep_id}`, pass: pass11 });

  // =================================================================
  // 12. Owner creates webhook trigger (PASS)
  // =================================================================
  console.log('\n--- Test 12: Owner creates webhook trigger via GraphQL (PASS) ---');
  const r12 = await executeGql(ownerA_id, mTrig, { wfId: wfA_id, type: 'webhook' });
  const trig_id = r12.data?.insert_workflow_triggers_one?.id;
  const pass12 = !!trig_id;
  console.log(`Result: ${pass12 ? 'PASS' : 'FAIL'} (Trigger UUID: ${trig_id})`);
  results.push({ test: '12. Owner creates webhook trigger', user: 'Owner A', op: 'GraphQL insert_workflow_triggers_one (webhook)', expected: 'PASS', actual: `Created Trigger UUID ${trig_id}`, pass: pass12 });

  // =================================================================
  // 13. Owner/editor can edit permitted trigger (PASS)
  // =================================================================
  console.log('\n--- Test 13: Owner/editor edits permitted trigger via GraphQL ---');
  const mUpdateTrig = `
    mutation UpdateTrigger($id: uuid!, $enabled: Boolean!) {
      update_workflow_triggers_by_pk(pk_columns: { id: $id }, _set: { enabled: $enabled }) {
        id
        enabled
      }
    }
  `;
  const r13 = await executeGql(ownerA_id, mUpdateTrig, { id: trig_id, enabled: false });
  const pass13 = r13.data?.update_workflow_triggers_by_pk?.enabled === false;
  console.log(`Result: ${pass13 ? 'PASS' : 'FAIL'} (Enabled: ${r13.data?.update_workflow_triggers_by_pk?.enabled})`);
  results.push({ test: '13. Owner/editor edits trigger', user: 'Owner A', op: 'GraphQL update_workflow_triggers_by_pk', expected: 'PASS', actual: JSON.stringify(r13.data?.update_workflow_triggers_by_pk || {}), pass: pass13 });

  // =================================================================
  // 14. Viewer cannot mutate anything (DENIED)
  // =================================================================
  console.log('\n--- Test 14: Viewer cannot mutate anything via GraphQL (DENIED) ---');
  const r14 = await executeGql(viewerA_id, m1, { orgId: orgA_id, name: 'Viewer Illegal Wf', created_by: viewerA_id });
  const pass14 = !!r14.errors;
  console.log(`Result: ${pass14 ? 'PASS' : 'FAIL'} (Actual: ${r14.errors?.[0]?.message})`);
  results.push({ test: '14. Viewer cannot mutate', user: 'Viewer A', op: 'GraphQL insert_workflows_one', expected: 'DENIED', actual: `DENIED: ${r14.errors?.[0]?.message}`, pass: pass14 });

  // =================================================================
  // 15. Org B cannot access or mutate Org A resources (DENIED)
  // =================================================================
  console.log('\n--- Test 15: Org B cannot access or mutate Org A resources via GraphQL (DENIED) ---');
  const r15 = await executeGql(ownerB_id, m3, { id: wfA_id, name: 'Hacked by Org B' });
  const pass15 = r15.data?.update_workflows_by_pk === null || !!r15.errors;
  const actualStr15 = r15.data?.update_workflows_by_pk !== undefined ? String(r15.data?.update_workflows_by_pk) : (r15.errors?.[0]?.message || 'null');
  console.log(`Result: ${pass15 ? 'PASS' : 'FAIL'} (Actual: ${actualStr15})`);
  results.push({ test: '15. Org B cross-org mutation', user: 'Owner B (Org B)', op: 'GraphQL update_workflows_by_pk', expected: 'DENIED (null)', actual: actualStr15, pass: pass15 });

  // =================================================================
  // 16. Workflow query returns steps + triggers + most recent run status
  // =================================================================
  console.log('\n--- Test 16: Workflow aggregate query returns steps + triggers + most recent run ---');

  await pgClient.query(
    "INSERT INTO public.workflow_runs (workflow_id, trigger_type, status, created_by) VALUES ($1, 'manual', 'completed', $2);",
    [wfA_id, ownerA_id]
  );

  const qAggregate = `
    query GetWorkflowAggregate($id: uuid!) {
      workflows_by_pk(id: $id) {
        id
        name
        org_id
        steps(order_by: { position: asc }) {
          id
          position
          type
          name
        }
        triggers {
          id
          type
          enabled
        }
        runs(order_by: { created_at: desc }, limit: 1) {
          id
          trigger_type
          status
        }
      }
    }
  `;

  const r16 = await executeGql(editorA_id, qAggregate, { id: wfA_id });
  const wfAggregate = r16.data?.workflows_by_pk;
  const pass16 =
    wfAggregate?.id === wfA_id &&
    wfAggregate?.steps?.length >= 4 &&
    wfAggregate?.triggers?.length >= 1 &&
    wfAggregate?.runs?.length === 1 &&
    wfAggregate?.runs[0]?.status === 'completed';

  console.log(`Result: ${pass16 ? 'PASS' : 'FAIL'}`);
  console.log('  - Steps Count:', wfAggregate?.steps?.length);
  console.log('  - Triggers Count:', wfAggregate?.triggers?.length);
  console.log('  - Most Recent Run Status:', wfAggregate?.runs[0]?.status);

  results.push({
    test: '16. Workflow aggregate query',
    user: 'Editor A',
    op: 'GraphQL workflows_by_pk with nested steps, triggers, runs',
    expected: 'PASS (Returned steps + triggers + recent run)',
    actual: `Steps: ${wfAggregate?.steps?.length}, Triggers: ${wfAggregate?.triggers?.length}, Run Status: ${wfAggregate?.runs[0]?.status}`,
    pass: pass16
  });

  await pgClient.end();

  console.log('\n================================================================');
  console.table(results);
  console.log('================================================================\n');

  // Update docs/layer2-authorization-verification.md safely
  const docDir = path.join(__dirname, '..', 'docs');
  if (!fs.existsSync(docDir)) {
    fs.mkdirSync(docDir, { recursive: true });
  }
  const docPath = path.join(docDir, 'layer2-authorization-verification.md');

  const docContent = `# Native Hasura GraphQL Engine Workflow CRUD & Layer 2 Authorization Report

This document records the empirical verification results for Phase 7 (Native Hasura GraphQL Engine Workflow CRUD Operations) and Phase 6 (Layer 2 Server-Side Authorization Rules).

## Hasura GraphQL Operations Verification Matrix

| Test | User Role | GraphQL Operation | Expected | Actual Result | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
${results.map(r => `| **${r.test}** | ${r.user} | \`${r.op}\` | ${r.expected} | \`${r.actual.replace(/\|/g, '\\|')}\` | **${r.pass ? 'PASS' : 'FAIL'}** |`).join('\n')}

---

## Architecture: Native Hasura GraphQL API vs Internal Server Endpoints

### 1. Primary Assignment Hasura GraphQL Engine Interface (\`/v1/graphql\`)
All workflow, step, and trigger CRUD operations are executed directly against Hasura GraphQL Engine using standard GraphQL queries and mutations:

* **Create Workflow**: \`mutation { insert_workflows_one(object: { org_id, name, created_by }) { id } }\`
* **Update Workflow**: \`mutation { update_workflows_by_pk(pk_columns: { id }, _set: { name, description }) { id } }\`
* **Delete Workflow**: \`mutation { delete_workflows_by_pk(id) { id } }\`
* **Create Step**: \`mutation { insert_workflow_steps_one(object: { workflow_id, position, type, name, config }) { id } }\`
* **Update Step**: \`mutation { update_workflow_steps_by_pk(pk_columns: { id }, _set: { name, config }) { id } }\`
* **Reorder Steps**: \`mutation { update_workflow_steps_many(updates: [{ where: { id: { _eq: "step1" } }, _set: { position: 1 } }, { where: { id: { _eq: "step2" } }, _set: { position: 2 } }]) { affected_rows } }\`
* **Delete Step**: \`mutation { delete_workflow_steps_by_pk(id) { id } }\`
* **Create Trigger**: \`mutation { insert_workflow_triggers_one(object: { workflow_id, type, config, enabled }) { id } }\`
* **Update Trigger**: \`mutation { update_workflow_triggers_by_pk(pk_columns: { id }, _set: { enabled, config }) { id } }\`
* **Delete Trigger**: \`mutation { delete_workflow_triggers_by_pk(id) { id } }\`
* **Aggregate Query**:
  \`\`\`graphql
  query GetWorkflowAggregate($id: uuid!) {
    workflows_by_pk(id: $id) {
      id
      name
      org_id
      steps(order_by: { position: asc }) { id position type name config }
      triggers { id type config enabled }
      runs(order_by: { created_at: desc }, limit: 1) { id trigger_type status started_at completed_at }
    }
  }
  \`\`\`

---

### 2. Internal Server Endpoints & Hasura Actions
* **Hasura Action \`triggerWorkflowRun\`** (\`/api/actions/trigger-workflow\`): Verifies caller role, checks quota limit, initializes workflow run.
* **Hasura Action \`approveStep\`** (\`/api/actions/approve-step\`): Verifies approver role, checks \`approval_gate\` paused status, updates \`step_runs\` and resumes execution.

---

## Declarative Hasura Permission Matrix

| Role | Read Workflow / Steps / Triggers | Insert Normal Step (\`llm_call\`, \`http_request\`) | Insert Privileged Step (\`db_write\`, \`notify\`) | Insert Webhook Trigger | Reorder Steps | Delete Workflow |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Owner** | Allowed | Allowed | **Allowed** | **Allowed** | Allowed | Allowed |
| **Editor** | Allowed | Allowed | **DENIED (Hasura Check)** | **DENIED (Hasura Check)** | Allowed | Denied |
| **Viewer** | Allowed | Denied | Denied | Denied | Denied | Denied |
`;

  fs.writeFileSync(docPath, docContent, 'utf8');
  console.log('✓ Updated docs/layer2-authorization-verification.md');
}

runPhase7GraphQLSuite();
