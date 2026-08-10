const fs = require('fs');
const path = require('path');

// Load env
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

async function checkAndFixJwtConfig() {
  const hasuraCloudUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN;
  const region = process.env.NEXT_PUBLIC_NHOST_REGION;

  console.log('================================================================');
  console.log('  HASURA CLOUD JWT CONFIGURATION AUDIT');
  console.log('================================================================\n');

  // Step 1: Fetch Nhost JWKS
  const jwksUrl = `https://${subdomain}.auth.${region}.nhost.run/v1/.well-known/jwks.json`;
  console.log('Fetching Nhost JWKS from:', jwksUrl.replace(subdomain, '[SUBDOMAIN]'));
  const jwksRes = await fetch(jwksUrl);
  const jwks = await jwksRes.json();
  const jwk = jwks.keys && jwks.keys[0];
  
  if (!jwk) {
    console.error('No JWK keys found in Nhost JWKS');
    process.exit(1);
  }
  
  console.log('Nhost JWKS Key algorithm:', jwk.alg, '| Key type:', jwk.kty);

  // Step 2: Test Hasura Cloud with admin secret
  const adminTestRes = await fetch(hasuraCloudUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hasura-admin-secret': adminSecret,
    },
    body: JSON.stringify({ query: '{ workflows(limit: 1) { id } }' }),
  });
  const adminData = await adminTestRes.json();
  
  if (adminData.errors) {
    console.error('Admin secret test failed:', JSON.stringify(adminData.errors));
    process.exit(1);
  }
  console.log('Hasura Cloud admin secret: WORKS');

  // Step 3: Sign in with Nhost and get a real JWT token
  const authUrl = `https://${subdomain}.auth.${region}.nhost.run/v1/signin/email-password`;
  const authRes = await fetch(authUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'shashishanthan2706@gmail.com', password: 'ShaDoW@17' }),
  });
  const authData = await authRes.json();
  
  if (!authData.session) {
    console.error('Nhost auth failed:', JSON.stringify(authData));
    process.exit(1);
  }
  
  const token = authData.session.accessToken;
  const userId = authData.session.user.id;
  console.log('Nhost JWT obtained for user:', userId);

  // Step 4: Test JWT on Hasura Cloud
  const jwtTestRes = await fetch(hasuraCloudUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({ query: '{ workflows(limit: 1) { id } }' }),
  });
  const jwtData = await jwtTestRes.json();
  
  if (jwtData.errors) {
    console.log('JWT Test Result: FAILED');
    console.log('  Error:', jwtData.errors[0] && jwtData.errors[0].message);
    console.log('\nDIAGNOSIS:');
    console.log('Hasura Cloud JWT secret is NOT configured to accept Nhost RS256 tokens.');
    console.log('JWKS URL for Nhost:', jwksUrl.replace(subdomain, '[SUBDOMAIN]'));
    console.log('\nREQUIRED: Set HASURA_GRAPHQL_JWT_SECRET environment variable in Hasura Cloud console to:');
    const jwtConfig = JSON.stringify({
      type: 'RS256',
      jwk_url: jwksUrl,
      claims_format: 'json'
    });
    console.log(jwtConfig);
    return false;
  } else {
    console.log('Hasura Cloud accepts Nhost JWT tokens: JWT IS CONFIGURED');
    console.log('  Workflows accessible:', (jwtData.data && jwtData.data.workflows && jwtData.data.workflows.length) || 0);
    return true;
  }
}

checkAndFixJwtConfig().then(function(ok) {
  console.log('\n================================================================');
  console.log('  RESULT:', ok ? 'JWT PROPERLY CONFIGURED' : 'JWT CONFIGURATION NEEDED');
  console.log('================================================================');
}).catch(function(e) {
  console.error('Error:', e.message);
  process.exit(1);
});
