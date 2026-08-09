import type { NextApiRequest, NextApiResponse } from 'next';
import { Client } from 'pg';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const envCheck = {
    NEXT_PUBLIC_NHOST_SUBDOMAIN: !!process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN,
    NEXT_PUBLIC_NHOST_REGION: !!process.env.NEXT_PUBLIC_NHOST_REGION,
    NEXT_PUBLIC_HASURA_GRAPHQL_URL: !!process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL,
    DATABASE_URL: !!process.env.DATABASE_URL,
    HASURA_GRAPHQL_ADMIN_SECRET: !!process.env.HASURA_GRAPHQL_ADMIN_SECRET,
  };

  let dbStatus = { success: false, message: 'Not tested' };
  let hasuraStatus = { success: false, message: 'Not tested' };
  let nhostJwksStatus = { success: false, message: 'Not tested' };

  // 1. Test Supabase PostgreSQL connection
  if (process.env.DATABASE_URL) {
    try {
      const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
      await client.connect();
      const dbRes = await client.query('SELECT NOW() as current_time, version() as pg_version');
      await client.end();
      dbStatus = {
        success: true,
        message: `Successfully connected to PostgreSQL (${dbRes.rows[0].pg_version.split(',')[0]}) at ${dbRes.rows[0].current_time}`,
      };
    } catch (err: any) {
      dbStatus = { success: false, message: `PostgreSQL connection error: ${err.message}` };
    }
  } else {
    dbStatus = { success: false, message: 'DATABASE_URL is missing' };
  }

  // 2. Test Hasura GraphQL Engine connection
  if (process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL) {
    try {
      const response = await fetch(process.env.NEXT_PUBLIC_HASURA_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.HASURA_GRAPHQL_ADMIN_SECRET
            ? { 'x-hasura-admin-secret': process.env.HASURA_GRAPHQL_ADMIN_SECRET }
            : {}),
        },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      const data = await response.json();
      if (data.data) {
        hasuraStatus = {
          success: true,
          message: 'Hasura GraphQL Engine responds successfully',
        };
      } else {
        hasuraStatus = {
          success: false,
          message: `Hasura error: ${JSON.stringify(data.errors || data)}`,
        };
      }
    } catch (err: any) {
      hasuraStatus = { success: false, message: `Hasura fetch error: ${err.message}` };
    }
  } else {
    hasuraStatus = { success: false, message: 'NEXT_PUBLIC_HASURA_GRAPHQL_URL is missing' };
  }

  // 3. Test Nhost Auth JWKS endpoint reachability
  const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN;
  const region = process.env.NEXT_PUBLIC_NHOST_REGION;
  if (subdomain && region) {
    const jwksUrl = `https://${subdomain}.auth.${region}.nhost.run/v1/.well-known/jwks.json`;
    try {
      const jwksRes = await fetch(jwksUrl);
      if (jwksRes.ok) {
        const jwksData = await jwksRes.json();
        nhostJwksStatus = {
          success: true,
          message: `Nhost Auth JWKS endpoint reachable (Keys count: ${jwksData.keys?.length || 0})`,
        };
      } else {
        nhostJwksStatus = { success: false, message: `Nhost JWKS HTTP status ${jwksRes.status}` };
      }
    } catch (err: any) {
      nhostJwksStatus = { success: false, message: `JWKS fetch error: ${err.message}` };
    }
  } else {
    nhostJwksStatus = { success: false, message: 'Nhost subdomain/region missing' };
  }

  return res.status(200).json({
    timestamp: new Date().toISOString(),
    environment: envCheck,
    diagnostics: {
      supabase_database: dbStatus,
      hasura_graphql: hasuraStatus,
      nhost_jwks_auth: nhostJwksStatus,
    },
  });
}
