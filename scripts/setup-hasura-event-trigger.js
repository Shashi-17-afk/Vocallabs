const fs = require('fs');
const path = require('path');

// Load .env.local
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

async function setupEventTrigger() {
  console.log('================================================================');
  console.log('  HASURA DATABASE EVENT TRIGGER METADATA REGISTRATION');
  console.log('================================================================\n');

  const graphqlUrl = process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL || 'http://localhost:8080/v1/graphql';
  const metadataUrl = graphqlUrl.replace(/\/v1\/graphql$/, '/v1/metadata');
  const adminSecret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;

  console.log('Hasura Metadata URL:', metadataUrl);

  const eventTriggerConfig = {
    name: 'notify_step_completed',
    source: 'default',
    table: {
      schema: 'public',
      name: 'step_runs',
    },
    webhook: 'http://host.docker.internal:3000/api/events/notify',
    headers: [
      {
        name: 'x-hasura-event-secret',
        value: process.env.EVENT_SECRET || process.env.ACTION_SECRET || 'test_event_secret_key_123',
      },
    ],
    update: {
      columns: ['status'],
    },
    retry_conf: {
      num_retries: 3,
      interval_sec: 10,
      timeout_sec: 60,
    },
    replace: false,
  };

  try {
    let res = await fetch(metadataUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hasura-admin-secret': adminSecret,
      },
      body: JSON.stringify({
        type: 'pg_create_event_trigger',
        args: eventTriggerConfig,
      }),
    });

    let data = await res.json();

    if (data.error && data.error.includes('already exists')) {
      console.log('Event trigger exists, replacing...');
      eventTriggerConfig.replace = true;
      res = await fetch(metadataUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-hasura-admin-secret': adminSecret,
        },
        body: JSON.stringify({
          type: 'pg_create_event_trigger',
          args: eventTriggerConfig,
        }),
      });
      data = await res.json();
    }

    console.log('Hasura Metadata Registration Result:', data);

    // Save reproducible Hasura Metadata in hasura/metadata/event_triggers.json and event_triggers.yaml
    const metadataDir = path.join(__dirname, '..', 'hasura', 'metadata');
    if (!fs.existsSync(metadataDir)) {
      fs.mkdirSync(metadataDir, { recursive: true });
    }

    const yamlContent = `name: notify_step_completed
table:
  name: step_runs
  schema: public
webhook: http://host.docker.internal:3000/api/events/notify
headers:
  - name: x-hasura-event-secret
    value_from_env: EVENT_SECRET
update:
  columns:
    - status
retry_conf:
  num_retries: 3
  interval_sec: 10
  timeout_sec: 60
`;

    fs.writeFileSync(path.join(metadataDir, 'event_triggers.yaml'), yamlContent, 'utf8');
    fs.writeFileSync(path.join(metadataDir, 'event_triggers.json'), JSON.stringify(eventTriggerConfig, null, 2), 'utf8');

    console.log('✓ Exported reproducible metadata to hasura/metadata/event_triggers.yaml');
  } catch (err) {
    console.error('Failed to register Hasura Event Trigger:', err.message);
  }
}

setupEventTrigger();
