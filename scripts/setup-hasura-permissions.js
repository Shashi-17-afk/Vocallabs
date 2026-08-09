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
  console.log('=== Establishing Hasura Layer 1 Row-Level Permission Rules ===');
  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  const metadataUrl = graphqlUrl.replace(/\/v1\/graphql\/?$/, '/v1/metadata');

  // First create relationship on org_monthly_usage view -> organizations table
  console.log('Adding organization relationship on org_monthly_usage view...');
  try {
    await fetch(metadataUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': adminSecret
      },
      body: JSON.stringify({
        type: 'pg_create_object_relationship',
        args: {
          source: 'default',
          table: { schema: 'public', name: 'org_monthly_usage' },
          name: 'organization',
          using: {
            manual_configuration: {
              remote_table: { schema: 'public', name: 'organizations' },
              column_mapping: { org_id: 'id' }
            }
          }
        }
      })
    });
  } catch (e) {
    console.log('Relationship notice:', e.message);
  }

  const permissions = [
    // 1. organizations (SELECT)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'organizations' },
        role: 'user',
        permission: {
          columns: ['id', 'name', 'quota_limit', 'quota_used', 'quota_period', 'created_at', 'updated_at'],
          filter: {
            members: {
              user_id: { _eq: 'X-Hasura-User-Id' }
            }
          }
        }
      }
    },

    // 2. org_members (SELECT)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'org_members' },
        role: 'user',
        permission: {
          columns: ['id', 'org_id', 'user_id', 'role', 'created_at', 'updated_at'],
          filter: {
            organization: {
              members: {
                user_id: { _eq: 'X-Hasura-User-Id' }
              }
            }
          }
        }
      }
    },

    // 3. workflows (SELECT)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflows' },
        role: 'user',
        permission: {
          columns: ['id', 'org_id', 'name', 'description', 'created_by', 'created_at', 'updated_at'],
          filter: {
            organization: {
              members: {
                user_id: { _eq: 'X-Hasura-User-Id' }
              }
            }
          }
        }
      }
    },

    // 4. workflow_steps (SELECT)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_steps' },
        role: 'user',
        permission: {
          columns: ['id', 'workflow_id', 'position', 'type', 'name', 'config', 'created_at', 'updated_at'],
          filter: {
            workflow: {
              organization: {
                members: {
                  user_id: { _eq: 'X-Hasura-User-Id' }
                }
              }
            }
          }
        }
      }
    },

    // 5. workflow_triggers (SELECT)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_triggers' },
        role: 'user',
        permission: {
          columns: ['id', 'workflow_id', 'type', 'config', 'enabled', 'created_at', 'updated_at'],
          filter: {
            workflow: {
              organization: {
                members: {
                  user_id: { _eq: 'X-Hasura-User-Id' }
                }
              }
            }
          }
        }
      }
    },

    // 6. workflow_runs (SELECT)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'workflow_runs' },
        role: 'user',
        permission: {
          columns: ['id', 'workflow_id', 'trigger_type', 'status', 'started_at', 'completed_at', 'error', 'created_by', 'created_at', 'updated_at'],
          filter: {
            workflow: {
              organization: {
                members: {
                  user_id: { _eq: 'X-Hasura-User-Id' }
                }
              }
            }
          }
        }
      }
    },

    // 7. step_runs (SELECT)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'step_runs' },
        role: 'user',
        permission: {
          columns: ['id', 'workflow_run_id', 'workflow_step_id', 'status', 'input', 'output', 'error', 'attempt_count', 'approved_by', 'approved_at', 'started_at', 'completed_at'],
          filter: {
            workflow_run: {
              workflow: {
                organization: {
                  members: {
                    user_id: { _eq: 'X-Hasura-User-Id' }
                  }
                }
              }
            }
          }
        }
      }
    },

    // 8. org_monthly_usage (SELECT View)
    {
      type: 'pg_create_select_permission',
      args: {
        source: 'default',
        table: { schema: 'public', name: 'org_monthly_usage' },
        role: 'user',
        permission: {
          columns: ['org_id', 'org_name', 'quota_limit', 'quota_used', 'quota_period', 'total_runs_this_month', 'successful_runs_this_month', 'failed_runs_this_month'],
          filter: {
            organization: {
              members: {
                user_id: { _eq: 'X-Hasura-User-Id' }
              }
            }
          }
        }
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
        args: permissions
      })
    });
    const data = await res.json();
    console.log('Permissions setup result:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error setting up permissions:', err.message);
  }
}

setupPermissions();
