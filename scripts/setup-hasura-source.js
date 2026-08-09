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
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        process.env[key] = val;
      }
    }
  }
}

async function addSourceAndTrackTables() {
  console.log('=== Connecting Supabase PostgreSQL to Hasura ===');
  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  const dbUrl = process.env.DATABASE_URL;
  const metadataUrl = graphqlUrl.replace(/\/v1\/graphql\/?$/, '/v1/metadata');

  console.log('Connecting to database URL:', dbUrl.replace(/:[^:@]+@/, ':****@'));

  // Step 1: Add PostgreSQL source "default"
  console.log('Adding database source "default"...');
  const addSourcePayload = {
    type: 'pg_add_source',
    args: {
      name: 'default',
      configuration: {
        connection_info: {
          database_url: dbUrl,
          pool_settings: {
            max_connections: 20,
            idle_timeout: 180,
            retries: 3
          },
          ssl_configuration: {
            sslmode: 'require'
          }
        }
      }
    }
  };

  try {
    const sourceRes = await fetch(metadataUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': adminSecret
      },
      body: JSON.stringify(addSourcePayload)
    });
    const sourceData = await sourceRes.json();
    console.log('Add source response:', sourceData);

    // Step 2: Track all tables
    console.log('\nTracking public schema tables...');
    const tables = [
      'organizations',
      'org_members',
      'workflows',
      'workflow_steps',
      'workflow_triggers',
      'workflow_runs',
      'step_runs',
      'db_write_audit_logs',
      'org_monthly_usage'
    ];

    const bulkArgs = tables.map(tableName => ({
      type: 'pg_track_table',
      args: {
        source: 'default',
        table: { schema: 'public', name: tableName }
      }
    }));

    const trackRes = await fetch(metadataUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': adminSecret
      },
      body: JSON.stringify({
        type: 'bulk',
        args: bulkArgs
      })
    });
    const trackData = await trackRes.json();
    console.log('Track tables response:', trackData);

  } catch (err) {
    console.error('Error adding source & tracking tables:', err.message);
  }
}

addSourceAndTrackTables();
