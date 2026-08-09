const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Read .env.local manually
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

async function applyMigration() {
  console.log('=== Applying Database Schema Migration ===');
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('ERROR: DATABASE_URL is not defined in .env.local');
    process.exit(1);
  }

  const migrationPath = path.join(__dirname, '..', 'migrations', '001_initial_schema.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  const client = new Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('Connected to PostgreSQL. Executing migration DDL...');
    await client.query(sql);
    console.log('SUCCESS: Migration applied cleanly!');

    // Verify created tables
    const tableRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);
    console.log('\n--- Verified Tables in public schema ---');
    tableRes.rows.forEach(r => console.log('  ✓ Table:', r.table_name));

    // Verify created views
    const viewRes = await client.query(`
      SELECT table_name 
      FROM information_schema.views 
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    console.log('\n--- Verified Views in public schema ---');
    viewRes.rows.forEach(r => console.log('  ✓ View:', r.table_name));

    await client.end();
  } catch (err) {
    console.error('ERROR applying migration:', err.message);
    process.exit(1);
  }
}

applyMigration();
