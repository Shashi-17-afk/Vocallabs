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

function parseJwt(token) {
  const base64Url = token.split('.')[1];
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const jsonPayload = Buffer.from(base64, 'base64').toString('utf8');
  return JSON.parse(jsonPayload);
}

async function verifyNhostAuth() {
  console.log('================================================================');
  console.log('  PHASE 2 & 3: REAL NHOST AUTHENTICATION & HASURA JWT CLAIM TEST');
  console.log('================================================================\n');

  const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN || 'jpcetnwktzhavpkiyepi';
  const region = process.env.NEXT_PUBLIC_NHOST_REGION || 'ap-south-1';
  const authUrl = `https://${subdomain}.auth.${region}.nhost.run/v1`;
  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;

  const testEmail = 'shashishanthan2706@gmail.com';
  // Password comes from secure input during turn - never hardcoded or printed

  const args = process.argv.slice(2);
  const password = args[0];

  if (!password) {
    console.error('Password argument required for verification');
    process.exit(1);
  }

  let token = null;
  let userId = null;

  console.log('Attempting Nhost Sign-In for email:', testEmail);

  try {
    let signInRes = await fetch(`${authUrl}/signin/email-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password }),
    });

    let signInData = await signInRes.json();

    if (signInRes.status !== 200) {
      console.log('Sign-in result status:', signInRes.status, signInData.message || '');
      console.log('Attempting Nhost Sign-Up for user registration...');

      const signUpRes = await fetch(`${authUrl}/signup/email-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: testEmail, password }),
      });

      const signUpData = await signUpRes.json();
      console.log('Sign-up status:', signUpRes.status);

      if (signUpRes.status === 200 && signUpData.session) {
        token = signUpData.session.accessToken;
        userId = signUpData.session.user.id;
      } else {
        // Try sign-in again in case account was created
        signInRes = await fetch(`${authUrl}/signin/email-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: testEmail, password }),
        });
        signInData = await signInRes.json();
        if (signInRes.status === 200 && signInData.session) {
          token = signInData.session.accessToken;
          userId = signInData.session.user.id;
        }
      }
    } else if (signInData.session) {
      token = signInData.session.accessToken;
      userId = signInData.session.user.id;
    }

    if (!token) {
      console.error('Failed to obtain authenticated Nhost JWT session.');
      process.exit(1);
    }

    console.log('✓ Successfully authenticated real Nhost user session');
    console.log('✓ User ID:', userId);

    // Parse and verify JWT claims securely (without printing token string)
    const decoded = parseJwt(token);
    const hasuraClaims = decoded['https://hasura.io/jwt/claims'] || {};

    console.log('✓ Hasura Default Role:', hasuraClaims['x-hasura-default-role']);
    console.log('✓ Hasura Allowed Roles:', hasuraClaims['x-hasura-allowed-roles']);
    console.log('✓ Hasura User ID claim matches user.id:', hasuraClaims['x-hasura-user-id'] === userId);

    // Setup DB org membership for real Nhost User ID
    const pgClient = new PgClient({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pgClient.connect();

    // Ensure Organization A exists for real user
    let orgRes = await pgClient.query(`SELECT id FROM public.organizations WHERE name = 'Production Org A';`);
    let orgId;
    if (orgRes.rows.length === 0) {
      const insOrg = await pgClient.query(`INSERT INTO public.organizations (name, quota_limit) VALUES ('Production Org A', 100) RETURNING id;`);
      orgId = insOrg.rows[0].id;
    } else {
      orgId = orgRes.rows[0].id;
    }

    // Ensure real Nhost user is owner of Production Org A
    await pgClient.query(
      `INSERT INTO public.org_members (org_id, user_id, role)
       VALUES ($1, $2, 'owner')
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner';`,
      [orgId, userId]
    );
    await pgClient.end();

    console.log('✓ Ensured real Nhost User is Owner of Production Org A (Org ID:', orgId, ')');

    // Test Authenticated GraphQL Query using real Nhost JWT token
    console.log('\nTesting Authenticated Hasura GraphQL Query using real Nhost JWT...');

    const gqlQuery = `
      query GetMyWorkflows {
        workflows {
          id
          name
          org_id
        }
      }
    `;

    const gqlRes = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query: gqlQuery }),
    });

    const gqlData = await gqlRes.json();

    if (gqlData.errors) {
      console.error('GraphQL Query Error:', gqlData.errors);
      process.exit(1);
    }

    console.log('✓ Authenticated GraphQL Query Result:', gqlData.data);
    console.log('✓ Hasura correctly validated RS256/HS256 JWT from Nhost Auth!');
  } catch (err) {
    console.error('Nhost Auth verification error:', err.message);
    process.exit(1);
  }
}

verifyNhostAuth();
