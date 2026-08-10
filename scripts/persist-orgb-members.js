const { Client: PgClient } = require('pg');
const fs = require('fs');
const path = require('path');

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

async function persistOrgBMembers() {
  console.log('================================================================');
  console.log('  PERSISTING PRODUCTION ORG B & DEDICATED MEMBERSHIPS');
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
  console.log(`1. Production Org B UUID: ${orgBId}`);

  const editorUserId = '1c2bc471-c96a-4a6d-8bcf-f548980a4468'; // shashishanthan2706+editor@gmail.com
  const viewerUserId = 'fd5ae610-f848-44c4-83d9-066a734f4000'; // shashishanthan2706+viewer@gmail.com

  // 2. Insert Editor Membership
  await pgClient.query(
    `INSERT INTO public.org_members (org_id, user_id, role)
     VALUES ($1, $2, 'editor')
     ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'editor';`,
    [orgBId, editorUserId]
  );
  console.log(`2. ✓ Assigned shashishanthan2706+editor@gmail.com (${editorUserId}) as EDITOR in Production Org B`);

  // 3. Insert Viewer Membership
  await pgClient.query(
    `INSERT INTO public.org_members (org_id, user_id, role)
     VALUES ($1, $2, 'viewer')
     ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'viewer';`,
    [orgBId, viewerUserId]
  );
  console.log(`3. ✓ Assigned shashishanthan2706+viewer@gmail.com (${viewerUserId}) as VIEWER in Production Org B`);

  // 4. Verify Memberships in DB
  const verifyRes = await pgClient.query(
    `SELECT om.id, om.org_id, o.name AS org_name, om.user_id, om.role
     FROM public.org_members om
     JOIN public.organizations o ON om.org_id = o.id
     WHERE om.org_id = $1;`,
    [orgBId]
  );

  console.log('\n--- VERIFIED MEMBERSHIPS IN DATABASE ---');
  console.log(JSON.stringify(verifyRes.rows, null, 2));

  await pgClient.end();
  console.log('\n================================================================');
  console.log('  SUCCESSFULLY PERSISTED PRODUCTION ORG B MEMBERSHIPS!');
  console.log('================================================================\n');
}

persistOrgBMembers().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
