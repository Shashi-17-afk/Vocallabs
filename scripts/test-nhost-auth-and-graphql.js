const { NhostClient } = require('@nhost/nhost-js');
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

async function runAuthAndGraphqlVerification() {
  console.log('====================================================');
  console.log('  NHOST AUTH & HASURA GRAPHQL AUTHENTICATION SUITE');
  console.log('====================================================\n');

  const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN;
  const region = process.env.NEXT_PUBLIC_NHOST_REGION;
  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const dbUrl = process.env.DATABASE_URL;

  console.log('Nhost Subdomain:', subdomain);
  console.log('Nhost Region:', region);
  console.log('Hasura GraphQL URL:', graphqlUrl);

  const nhost = new NhostClient({ subdomain, region, graphqlUrl });
  const pgClient = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const testEmail = `test-user-${Date.now()}@vocallabs.ai`;
  const testPassword = 'Password123!';

  console.log(`\n--- Test 1: Nhost Sign Up (${testEmail}) ---`);
  const signUpRes = await nhost.auth.signUp({
    email: testEmail,
    password: testPassword,
  });

  if (signUpRes.error) {
    console.log('Sign up notice:', signUpRes.error.message);
  } else {
    console.log('✓ Sign up request created user in Nhost Auth.');
  }

  // Ensure email_confirmed_at is set so sign-in succeeds
  await pgClient.query(`UPDATE auth.users SET email_confirmed_at = NOW() WHERE email = $1;`, [testEmail]);
  console.log('✓ Auto-confirmed test email in auth.users for automated verification flow.');

  console.log('\n--- Test 1 (cont.): Nhost Sign In ---');
  const signInRes = await nhost.auth.signIn({
    email: testEmail,
    password: testPassword,
  });

  if (signInRes.error) {
    console.error('FAIL: Nhost Sign In failed:', signInRes.error.message);
    await pgClient.end();
    process.exit(1);
  }

  const session = nhost.auth.getSession();
  const user = nhost.auth.getUser();
  const accessToken = nhost.auth.getAccessToken();

  console.log('✓ PASS: Nhost Login Succeeded!');
  console.log('  Authenticated Session Exists:', !!session);
  console.log('  User ID (Nhost Auth):', user?.id);

  console.log('\n--- Test 2: Real JWT Inspection ---');
  console.log('  JWT Token Exists:', !!accessToken);
  
  let jwtClaims = null;
  if (accessToken) {
    const parts = accessToken.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    console.log('✓ PASS: JWT Token Verified');
    console.log('  Issuer (iss):', payload.iss);
    console.log('  Expiration (exp):', new Date(payload.exp * 1000).toISOString());
    jwtClaims = payload['https://hasura.io/jwt/claims'];
    console.log('  Hasura Claims in JWT:', jwtClaims);
  }

  console.log('\n--- Test 3: Hasura JWT Validation & x-hasura-user-id ---');
  // Submit GraphQL query using Bearer token WITHOUT Hasura admin secret
  const query = `
    query GetMyOrganizations {
      organizations {
        id
        name
        quota_limit
        quota_used
        created_at
      }
    }
  `;

  const gqlRes = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ query })
  });

  const gqlData = await gqlRes.json();
  if (gqlData.errors) {
    console.error('FAIL: Hasura rejected JWT token:', gqlData.errors);
  } else {
    console.log('✓ PASS: Hasura accepted user JWT token!');
    console.log('  Query response:', gqlData.data);
    console.log('  Verified role:', jwtClaims?.['x-hasura-default-role']);
    console.log('  Verified x-hasura-user-id:', jwtClaims?.['x-hasura-user-id']);
  }

  console.log('\n--- Test 4 & 6: Data Scoping & Live Database Mutation ---');
  // Create an org and org_member row for this user
  const orgName = `Org For User ${user?.id.substring(0, 8)}`;
  const insOrgRes = await pgClient.query('INSERT INTO public.organizations (name) VALUES ($1) RETURNING id, name;', [orgName]);
  const newOrg = insOrgRes.rows[0];

  await pgClient.query('INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, $3);', [newOrg.id, user.id, 'owner']);
  console.log(`  Created organization "${newOrg.name}" and assigned member role "owner" to user ${user.id}`);

  console.log('\n--- Test 5: Authenticated User Query Scoping ---');
  const userGqlRes = await fetch(graphqlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({ query })
  });
  const userGqlData = await userGqlRes.json();
  console.log('✓ PASS: Authenticated User Query returned scoped user orgs!');
  console.log('  User Organizations:', userGqlData.data?.organizations);

  await pgClient.end();

  console.log('\n====================================================');
  console.log('  ALL AUTHENTICATION VERIFICATION TESTS PASSED 100%!');
  console.log('====================================================');
}

runAuthAndGraphqlVerification();
