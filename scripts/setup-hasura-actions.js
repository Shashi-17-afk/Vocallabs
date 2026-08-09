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

async function setupHasuraActions() {
  console.log('=== Tracking Hasura Actions & Custom Types in Metadata ===');
  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  const metadataUrl = graphqlUrl.replace(/\/v1\/graphql\/?$/, '/v1/metadata');

  // Custom GraphQL Types for Hasura Actions
  const customTypes = {
    type: 'set_custom_types',
    args: {
      scalars: [],
      enums: [],
      objects: [
        {
          name: 'TriggerWorkflowResponse',
          fields: [
            { name: 'run_id', type: 'String!' },
            { name: 'status', type: 'String!' },
            { name: 'started_at', type: 'String' }
          ]
        },
        {
          name: 'ApproveStepResponse',
          fields: [
            { name: 'status', type: 'String!' },
            { name: 'step_run_id', type: 'String!' },
            { name: 'approved_by', type: 'String' },
            { name: 'approved_at', type: 'String' }
          ]
        }
      ],
      input_objects: []
    }
  };

  try {
    await fetch(metadataUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': adminSecret
      },
      body: JSON.stringify(customTypes)
    });
    console.log('✓ Custom types configured');
  } catch (e) {
    console.error('Custom types error:', e.message);
  }

  // Create Actions
  const actions = [
    {
      type: 'create_action',
      args: {
        name: 'triggerWorkflowRun',
        definition: {
          kind: 'synchronous',
          handler: 'http://localhost:3000/api/actions/trigger-workflow',
          arguments: [{ name: 'workflow_id', type: 'uuid!' }],
          output_type: 'TriggerWorkflowResponse',
          headers: []
        }
      }
    },
    {
      type: 'create_action',
      args: {
        name: 'approveStep',
        definition: {
          kind: 'synchronous',
          handler: 'http://localhost:3000/api/actions/approve-step',
          arguments: [{ name: 'step_run_id', type: 'uuid!' }],
          output_type: 'ApproveStepResponse',
          headers: []
        }
      }
    }
  ];

  for (const act of actions) {
    try {
      const res = await fetch(metadataUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hasura-admin-secret': adminSecret
        },
        body: JSON.stringify(act)
      });
      const data = await res.json();
      console.log(`Action ${act.args.name} setup result:`, JSON.stringify(data));
    } catch (e) {
      console.error(`Action ${act.args.name} error:`, e.message);
    }
  }

  // Grant role 'user' permission on actions
  const permissions = [
    {
      type: 'create_action_permission',
      args: {
        action: 'triggerWorkflowRun',
        role: 'user'
      }
    },
    {
      type: 'create_action_permission',
      args: {
        action: 'approveStep',
        role: 'user'
      }
    }
  ];

  for (const perm of permissions) {
    try {
      const res = await fetch(metadataUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hasura-admin-secret': adminSecret
        },
        body: JSON.stringify(perm)
      });
      const data = await res.json();
      console.log(`Action permission ${perm.args.action} setup result:`, JSON.stringify(data));
    } catch (e) {
      console.error(`Action permission ${perm.args.action} error:`, e.message);
    }
  }
}

setupHasuraActions();
