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

async function createRbacTestUser() {
  console.log('================================================================');
  console.log('  CREATE DEDICATED RBAC TEST USER FOR PRODUCTION ORG A');
  console.log('================================================================\n');

  const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || 'jpcetnwktzhavpkiyepi';
  const region = process.env.NEXT_PUBLIC_NHOST_REGION || 'ap-south-1';
  const authUrl = `https://${subdomain}.auth.${region}.nhost.run/v1`;

  const testEmail = 'editor.test.rbac@vocallabs.internal';
  
  // Accept password from command-line argument (do NOT hardcode or print)
  const args = process.argv.slice(2);
  const password = args[0];

  if (!password) {
    console.error('❌ Error: Password argument is required. Pass a test password as command line argument.');
    process.exit(1);
  }

  // 1. Sign up user via Nhost Auth
  console.log(`1. Attempting Nhost Auth Sign-Up for synthetic email: ${testEmail}...`);
  let signUpRes = await fetch(`${authUrl}/signup/email-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, password }),
  });

  let signUpData = await signUpRes.json();
  console.log(`   Sign-up HTTP status: ${signUpRes.status}`);

  if (signUpRes.status !== 200 && signUpData.error !== 'email-already-in-use') {
    console.error('❌ Nhost Sign-Up failed:', signUpData);
    process.exit(1);
  }

  // 2. Connect to PostgreSQL to administratively verify email & add to Production Org A
  const pgClient = new PgClient({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await pgClient.connect();

  console.log('\n2. Querying auth.users table in PostgreSQL for synthetic user record...');
  const userQuery = await pgClient.query(
    `SELECT id, email, email_verified, disabled FROM auth.users WHERE email = $1;`,
    [testEmail]
  );

  if (userQuery.rows.length === 0) {
    console.error(`❌ User '${testEmail}' not found in auth.users database table.`);
    await pgClient.end();
    process.exit(1);
  }

  const user = userQuery.rows[0];
  const newUserId = user.id;
  console.log(`   User UUID found: ${newUserId}`);
  console.log(`   Initial email_verified status: ${user.email_verified}`);

  // 3. Administratively confirm email verification in database without disabling global policy
  if (!user.email_verified) {
    console.log('\n3. Administratively confirming email_verified = true in auth.users table...');
    await pgClient.query(
      `UPDATE auth.users SET email_verified = true WHERE id = $1;`,
      [newUserId]
    );
    console.log('   ✓ Email verification state set to true for test user ONLY.');
  } else {
    console.log('   ✓ User email is already verified.');
  }

  // 4. Ensure Production Org A exists
  const orgQuery = await pgClient.query(
    `SELECT id, name FROM public.organizations WHERE name = 'Production Org A';`
  );

  if (orgQuery.rows.length === 0) {
    console.error(`❌ 'Production Org A' not found in database.`);
    await pgClient.end();
    process.exit(1);
  }

  const orgId = orgQuery.rows[0].id;
  console.log(`\n4. Found Production Org A (ID: ${orgId})`);

  // 5. Add user to Production Org A as 'editor'
  console.log(`5. Adding test user (${newUserId}) to Production Org A as role 'editor'...`);
  await pgClient.query(
    `INSERT INTO public.org_members (org_id, user_id, role)
     VALUES ($1, $2, 'editor')
     ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'editor';`,
    [orgId, newUserId]
  );
  console.log('   ✓ Added member to Production Org A with role = editor');

  // Verify existing owner is untouched
  const ownerQuery = await pgClient.query(
    `SELECT user_id, role FROM public.org_members WHERE org_id = $1 AND role = 'owner';`,
    [orgId]
  );
  console.log(`   ✓ Confirmed existing owner is untouched (Owner count: ${ownerQuery.rows.length})`);

  await pgClient.end();

  // 6. Test Nhost Sign-In with new user credentials to confirm session creation
  console.log('\n6. Testing Nhost Auth Sign-In for synthetic test user...');
  const signInRes = await fetch(`${authUrl}/signin/email-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, password }),
  });
  const signInData = await signInRes.json();

  if (signInRes.status !== 200 || !signInData.session) {
    console.error('❌ Sign-in failed for synthetic user:', signInData);
    process.exit(1);
  }

  console.log('   ✓ Successfully authenticated synthetic test user session!');
  console.log(`   ✓ Nhost Session User ID: ${signInData.session.user.id}`);
  console.log(`   ✓ Email Verified Flag: ${signInData.session.user.emailVerified}`);
  console.log(`   ✓ Default Role: ${signInData.session.user.defaultRole}`);

  console.log('\n================================================================');
  console.log('  SUCCESSFULLY CREATED AND CONFIGURED DEDICATED RBAC TEST USER');
  console.log('================================================================\n');
  console.log(`  Synthetic Email: ${testEmail}`);
  console.log(`  User UUID:       ${newUserId}`);
  console.log(`  Organization:    Production Org A (${orgId})`);
  console.log(`  Assigned Role:   editor`);
  console.log(`  Auth Verification: Administratively Confirmed in auth.users\n`);
}

createRbacTestUser().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
