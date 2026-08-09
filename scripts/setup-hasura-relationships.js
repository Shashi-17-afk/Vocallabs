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

async function setupRelationships() {
  console.log('=== Establishing Hasura Foreign Key Relationships ===');
  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  const metadataUrl = graphqlUrl.replace(/\/v1\/graphql\/?$/, '/v1/metadata');

  const relationships = [
    // Array Relationships
    {
      type: 'pg_create_array_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'organizations' },
        name: 'members',
        using: { foreign_key_constraint_on: { table: { schema: 'public', name: 'org_members' }, column: 'org_id' } }
      }
    },
    {
      type: 'pg_create_array_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'organizations' },
        name: 'workflows',
        using: { foreign_key_constraint_on: { table: { schema: 'public', name: 'workflows' }, column: 'org_id' } }
      }
    },
    {
      type: 'pg_create_array_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflows' },
        name: 'steps',
        using: { foreign_key_constraint_on: { table: { schema: 'public', name: 'workflow_steps' }, column: 'workflow_id' } }
      }
    },
    {
      type: 'pg_create_array_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflows' },
        name: 'triggers',
        using: { foreign_key_constraint_on: { table: { schema: 'public', name: 'workflow_triggers' }, column: 'workflow_id' } }
      }
    },
    {
      type: 'pg_create_array_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflows' },
        name: 'runs',
        using: { foreign_key_constraint_on: { table: { schema: 'public', name: 'workflow_runs' }, column: 'workflow_id' } }
      }
    },
    {
      type: 'pg_create_array_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_runs' },
        name: 'step_runs',
        using: { foreign_key_constraint_on: { table: { schema: 'public', name: 'step_runs' }, column: 'workflow_run_id' } }
      }
    },

    // Object Relationships
    {
      type: 'pg_create_object_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'org_members' },
        name: 'organization',
        using: { foreign_key_constraint_on: 'org_id' }
      }
    },
    {
      type: 'pg_create_object_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflows' },
        name: 'organization',
        using: { foreign_key_constraint_on: 'org_id' }
      }
    },
    {
      type: 'pg_create_object_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_steps' },
        name: 'workflow',
        using: { foreign_key_constraint_on: 'workflow_id' }
      }
    },
    {
      type: 'pg_create_object_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_triggers' },
        name: 'workflow',
        using: { foreign_key_constraint_on: 'workflow_id' }
      }
    },
    {
      type: 'pg_create_object_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_runs' },
        name: 'workflow',
        using: { foreign_key_constraint_on: 'workflow_id' }
      }
    },
    {
      type: 'pg_create_object_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'step_runs' },
        name: 'workflow_run',
        using: { foreign_key_constraint_on: 'workflow_run_id' }
      }
    },
    {
      type: 'pg_create_object_relationship',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'step_runs' },
        name: 'workflow_step',
        using: { foreign_key_constraint_on: 'workflow_step_id' }
      }
    }
  ];

  try {
    const res = await fetch(metadataUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': adminSecret
      },
      body: JSON.stringify({
        type: 'bulk',
        args: relationships
      })
    });
    const data = await res.json();
    console.log('Relationships setup result:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error setting up relationships:', err.message);
  }
}

setupRelationships();
