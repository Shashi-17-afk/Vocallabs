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

async function setupPermissions() {
  console.log('=== Establishing Native Hasura GraphQL CRUD & Owner-Only Permission Rules ===');
  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  const metadataUrl = graphqlUrl.replace(/\/v1\/graphql\/?$/, '/v1/metadata');

  const tables = ['organizations', 'org_members', 'workflows', 'workflow_steps', 'workflow_triggers', 'workflow_runs', 'step_runs', 'org_monthly_usage'];
  const actions = ['select', 'insert', 'update', 'delete'];

  // Step 1: Drop existing permissions
  console.log('Clearing existing permissions for role user...');
  for (const table of tables) {
    for (const action of actions) {
      try {
        await fetch(metadataUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-hasura-admin-secret': adminSecret
          },
          body: JSON.stringify({
            type: `pg_drop_${action}_permission`,
            args: {
              source: 'default',
              table: { schema: 'public', name: table },
              role: 'user'
            }
          })
        });
      } catch (e) {
        // Ignore drop errors
      }
    }
  }

  // Base Membership Filters
  const isMemberFilter = {
    organization: {
      members: {
        user_id: { _eq: 'X-Hasura-User-Id' }
      }
    }
  };

  const isOwnerOrEditorFilter = {
    organization: {
      members: {
        user_id: { _eq: 'X-Hasura-User-Id' },
        role: { _in: ['owner', 'editor'] }
      }
    }
  };

  const isOwnerFilter = {
    organization: {
      members: {
        user_id: { _eq: 'X-Hasura-User-Id' },
        role: { _eq: 'owner' }
      }
    }
  };

  // -----------------------------------------------------------------
  // Fine-Grained Step Permission Filter:
  // Normal steps (llm_call, http_request, conditional_branch, approval_gate) -> Owner OR Editor
  // Privileged steps (db_write, notify) -> OWNER ONLY
  // -----------------------------------------------------------------
  const stepOwnerOrEditorCheck = {
    _or: [
      {
        type: { _nin: ['db_write', 'notify'] },
        workflow: isOwnerOrEditorFilter
      },
      {
        type: { _in: ['db_write', 'notify'] },
        workflow: isOwnerFilter
      }
    ]
  };

  // -----------------------------------------------------------------
  // Fine-Grained Trigger Permission Filter:
  // Normal triggers (manual, schedule) -> Owner OR Editor
  // Privileged triggers (webhook) -> OWNER ONLY
  // -----------------------------------------------------------------
  const triggerOwnerOrEditorCheck = {
    _or: [
      {
        type: { _neq: 'webhook' },
        workflow: isOwnerOrEditorFilter
      },
      {
        type: { _eq: 'webhook' },
        workflow: isOwnerFilter
      }
    ]
  };

  const createPermissions = [
    // 1. ORGANIZATIONS (Select)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'organizations' },
        role: 'user',
        permission: {
          columns: ['id', 'name', 'quota_limit', 'quota_used', 'quota_period', 'created_at', 'updated_at'],
          filter: { members: { user_id: { _eq: 'X-Hasura-User-Id' } } }
        }
      }
    },

    // 2. ORG_MEMBERS (Select, Insert, Update, Delete - Owner Only for mutations)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'org_members' },
        role: 'user',
        permission: {
          columns: ['id', 'org_id', 'user_id', 'role', 'created_at', 'updated_at'],
          filter: isMemberFilter
        }
      }
    },
    {
      type: 'pg_create_insert_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'org_members' },
        role: 'user',
        permission: {
          check: isOwnerFilter,
          columns: ['org_id', 'user_id', 'role']
        }
      }
    },
    {
      type: 'pg_create_update_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'org_members' },
        role: 'user',
        permission: {
          filter: isOwnerFilter,
          check: isOwnerFilter,
          columns: ['role']
        }
      }
    },
    {
      type: 'pg_create_delete_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'org_members' },
        role: 'user',
        permission: {
          filter: isOwnerFilter
        }
      }
    },

    // 3. WORKFLOWS (Select, Insert, Update, Delete)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflows' },
        role: 'user',
        permission: {
          columns: ['id', 'org_id', 'name', 'description', 'created_by', 'created_at', 'updated_at'],
          filter: isMemberFilter
        }
      }
    },
    {
      type: 'pg_create_insert_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflows' },
        role: 'user',
        permission: {
          check: isOwnerOrEditorFilter,
          columns: ['org_id', 'name', 'description', 'created_by']
        }
      }
    },
    {
      type: 'pg_create_update_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflows' },
        role: 'user',
        permission: {
          filter: isOwnerOrEditorFilter,
          check: isOwnerOrEditorFilter,
          columns: ['name', 'description']
        }
      }
    },
    {
      type: 'pg_create_delete_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflows' },
        role: 'user',
        permission: {
          filter: isOwnerFilter
        }
      }
    },

    // 4. WORKFLOW_STEPS (Select, Insert, Update, Delete with fine-grained db_write/notify owner restriction)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_steps' },
        role: 'user',
        permission: {
          columns: ['id', 'workflow_id', 'position', 'type', 'name', 'config', 'created_at', 'updated_at'],
          filter: { workflow: isMemberFilter }
        }
      }
    },
    {
      type: 'pg_create_insert_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_steps' },
        role: 'user',
        permission: {
          check: stepOwnerOrEditorCheck,
          columns: ['workflow_id', 'position', 'type', 'name', 'config']
        }
      }
    },
    {
      type: 'pg_create_update_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_steps' },
        role: 'user',
        permission: {
          filter: stepOwnerOrEditorCheck,
          check: stepOwnerOrEditorCheck,
          columns: ['position', 'type', 'name', 'config']
        }
      }
    },
    {
      type: 'pg_create_delete_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_steps' },
        role: 'user',
        permission: {
          filter: { workflow: isOwnerOrEditorFilter }
        }
      }
    },

    // 5. WORKFLOW_TRIGGERS (Select, Insert, Update, Delete with fine-grained webhook owner restriction)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_triggers' },
        role: 'user',
        permission: {
          columns: ['id', 'workflow_id', 'type', 'config', 'enabled', 'created_at', 'updated_at'],
          filter: { workflow: isMemberFilter }
        }
      }
    },
    {
      type: 'pg_create_insert_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_triggers' },
        role: 'user',
        permission: {
          check: triggerOwnerOrEditorCheck,
          columns: ['workflow_id', 'type', 'config', 'enabled']
        }
      }
    },
    {
      type: 'pg_create_update_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_triggers' },
        role: 'user',
        permission: {
          filter: triggerOwnerOrEditorCheck,
          check: triggerOwnerOrEditorCheck,
          columns: ['type', 'config', 'enabled']
        }
      }
    },
    {
      type: 'pg_create_delete_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_triggers' },
        role: 'user',
        permission: {
          filter: { workflow: isOwnerOrEditorFilter }
        }
      }
    },

    // 6. WORKFLOW_RUNS (Select)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_runs' },
        role: 'user',
        permission: {
          columns: ['id', 'workflow_id', 'trigger_type', 'status', 'started_at', 'completed_at', 'error', 'created_by', 'created_at', 'updated_at'],
          filter: { workflow: isMemberFilter }
        }
      }
    },

    // 7. STEP_RUNS (Select)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'step_runs' },
        role: 'user',
        permission: {
          columns: ['id', 'workflow_run_id', 'workflow_step_id', 'status', 'input', 'output', 'error', 'attempt_count', 'approved_by', 'approved_at', 'started_at', 'completed_at'],
          filter: { workflow_run: { workflow: isMemberFilter } }
        }
      }
    },

    // 8. ORG_MONTHLY_USAGE (Select View)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'org_monthly_usage' },
        role: 'user',
        permission: {
          columns: ['org_id', 'org_name', 'quota_limit', 'quota_used', 'quota_period', 'total_runs_this_month', 'successful_runs_this_month', 'failed_runs_this_month'],
          filter: isMemberFilter
        }
      }
    }
  ];

  console.log('Re-creating permissions for role user...');
  try {
    const res = await fetch(metadataUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': adminSecret
      },
      body: JSON.stringify({
        type: 'bulk',
        args: createPermissions
      })
    });
    const data = await res.json();
    console.log('Permissions setup result:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error setting up permissions:', err.message);
  }
}

setupPermissions();
