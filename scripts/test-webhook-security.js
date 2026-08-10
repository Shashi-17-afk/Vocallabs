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

const APP_URL = 'http://localhost:3000';
const WORKFLOW_ID = 'd6b882a5-7523-474f-8aa5-d63d5bb0853d';
const CORRECT_SECRET = 'my_webhook_secret_123';
const WRONG_SECRET = 'WRONG_SECRET_123';

async function runRegressionTest() {
  console.log('================================================================');
  console.log('  WEBHOOK TRIGGER AUTHENTICATION REGRESSION TEST SUITE');
  console.log('================================================================\n');

  const pgClient = new PgClient({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await pgClient.connect();

  // Helper to count workflow_runs for this workflow
  async function getRunCount() {
    const res = await pgClient.query(
      `SELECT COUNT(*) FROM public.workflow_runs WHERE workflow_id = $1;`,
      [WORKFLOW_ID]
    );
    return parseInt(res.rows[0].count, 10);
  }

  const initialCount = await getRunCount();
  console.log(`[Baseline] Initial workflow_runs count for '${WORKFLOW_ID}': ${initialCount}\n`);

  let passedTests = 0;
  let totalTests = 0;

  function recordResult(testName, expected, actual, pass) {
    totalTests++;
    if (pass) passedTests++;
    console.log(`--- ${testName} ---`);
    console.log(`  Expected: ${expected}`);
    console.log(`  Actual:   ${actual}`);
    console.log(`  Result:   ${pass ? 'PASS ✅' : 'FAIL ❌'}\n`);
  }

  // 1. Wrong secret in Body
  try {
    const res = await fetch(`${APP_URL}/api/triggers/webhook?workflow_id=${WORKFLOW_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: WRONG_SECRET, payload: { msg: 'test' } }),
    });
    const pass = res.status === 401;
    recordResult('Test 1: Wrong Secret in JSON Body', 'HTTP 401 Unauthorized', `HTTP ${res.status}`, pass);
  } catch (err) {
    recordResult('Test 1: Wrong Secret in JSON Body', 'HTTP 401 Unauthorized', err.message, false);
  }

  // 2. Wrong secret in x-trigger-secret header
  try {
    const res = await fetch(`${APP_URL}/api/triggers/webhook?workflow_id=${WORKFLOW_ID}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-trigger-secret': WRONG_SECRET,
      },
      body: JSON.stringify({ payload: { msg: 'test' } }),
    });
    const pass = res.status === 401;
    recordResult('Test 2: Wrong Secret in x-trigger-secret Header', 'HTTP 401 Unauthorized', `HTTP ${res.status}`, pass);
  } catch (err) {
    recordResult('Test 2: Wrong Secret in x-trigger-secret Header', 'HTTP 401 Unauthorized', err.message, false);
  }

  // 3. No secret anywhere
  try {
    const res = await fetch(`${APP_URL}/api/triggers/webhook?workflow_id=${WORKFLOW_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { msg: 'test' } }),
    });
    const pass = res.status === 401;
    recordResult('Test 3: Missing Secret (No secret in body/header/query)', 'HTTP 401 Unauthorized', `HTTP ${res.status}`, pass);
  } catch (err) {
    recordResult('Test 3: Missing Secret', 'HTTP 401 Unauthorized', err.message, false);
  }

  // Verify DB state after 3 invalid/unauthorized attempts
  const countAfterInvalid = await getRunCount();
  const noRunsCreatedForInvalid = countAfterInvalid === initialCount;
  recordResult(
    'Test 4: DB Integrity Check — Invalid/Missing secret requests create 0 runs',
    `Run count remains ${initialCount}`,
    `Run count is ${countAfterInvalid}`,
    noRunsCreatedForInvalid
  );

  // 5. Correct secret in Body
  let createdRunId = null;
  try {
    const res = await fetch(`${APP_URL}/api/triggers/webhook?workflow_id=${WORKFLOW_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: CORRECT_SECRET, payload: { msg: 'test' } }),
    });
    const data = await res.json();
    createdRunId = data.run_id;
    const pass = res.status === 200 && data.status === 'triggered' && !!createdRunId;
    recordResult('Test 5: Correct Secret in JSON Body', 'HTTP 200 + triggered status', `HTTP ${res.status}, run_id=${createdRunId}`, pass);
  } catch (err) {
    recordResult('Test 5: Correct Secret in JSON Body', 'HTTP 200', err.message, false);
  }

  // Verify DB state after 1 valid attempt
  const countAfterValid = await getRunCount();
  const runCreatedForValid = countAfterValid === initialCount + 1;
  recordResult(
    'Test 6: DB Integrity Check — Correct secret request creates exactly 1 run',
    `Run count increases by 1 to ${initialCount + 1}`,
    `Run count is ${countAfterValid}`,
    runCreatedForValid
  );

  // 7. Missing workflow_id
  try {
    const res = await fetch(`${APP_URL}/api/triggers/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: CORRECT_SECRET }),
    });
    const pass = res.status === 400;
    recordResult('Test 7: Missing workflow_id query param', 'HTTP 400 Bad Request', `HTTP ${res.status}`, pass);
  } catch (err) {
    recordResult('Test 7: Missing workflow_id query param', 'HTTP 400', err.message, false);
  }

  // 8. Unknown workflow_id
  try {
    const res = await fetch(`${APP_URL}/api/triggers/webhook?workflow_id=00000000-0000-0000-0000-000000000000`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: CORRECT_SECRET }),
    });
    const pass = res.status === 404;
    recordResult('Test 8: Non-existent workflow_id', 'HTTP 404 Not Found', `HTTP ${res.status}`, pass);
  } catch (err) {
    recordResult('Test 8: Non-existent workflow_id', 'HTTP 404', err.message, false);
  }

  await pgClient.end();

  console.log('================================================================');
  console.log(`  TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

runRegressionTest().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
