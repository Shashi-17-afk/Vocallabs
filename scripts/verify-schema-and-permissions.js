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

async function verifyHasuraSetup() {
  console.log('=== Verifying Hasura Metadata, Relationships & Permissions ===');
  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL;
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;

  const nestedQuery = `
    query TestNestedOrganizationWorkflows {
      organizations {
        id
        name
        quota_limit
        quota_used
        quota_period
        members {
          id
          user_id
          role
        }
        workflows {
          id
          name
          description
          steps {
            id
            position
            type
            name
          }
          triggers {
            id
            type
            enabled
          }
          runs {
            id
            trigger_type
            status
            step_runs {
              id
              status
              attempt_count
            }
          }
        }
      }
      org_monthly_usage {
        org_id
        org_name
        quota_limit
        quota_used
        total_runs_this_month
      }
    }
  `;

  try {
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': adminSecret
      },
      body: JSON.stringify({ query: nestedQuery })
    });
    const data = await res.json();
    if (data.errors) {
      console.error('GraphQL Verification Errors:', data.errors);
    } else {
      console.log('SUCCESS: Nested GraphQL query executed cleanly!');
      console.log('Returned Data Schema Keys:', Object.keys(data.data));
    }
  } catch (err) {
    console.error('Error executing verification query:', err.message);
  }
}

verifyHasuraSetup();
