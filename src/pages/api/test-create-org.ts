import type { NextApiRequest, NextApiResponse } from 'next';
import { Client } from 'pg';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.split(' ')[1];
  let userId: string | null = null;

  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      const hasuraClaims = payload['https://hasura.io/jwt/claims'];
      userId = hasuraClaims?.['x-hasura-user-id'] || payload.sub;
    }
  } catch (err) {
    return res.status(401).json({ error: 'Invalid JWT token payload' });
  }

  if (!userId) {
    return res.status(401).json({ error: 'x-hasura-user-id not found in token claims' });
  }

  const { orgName } = req.body || {};
  const name = orgName || `Test Org ${Math.floor(Math.random() * 1000)}`;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return res.status(500).json({ error: 'DATABASE_URL missing' });
  }

  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  try {
    await client.connect();
    await client.query('BEGIN');

    // 1. Insert organization
    const orgRes = await client.query(
      'INSERT INTO public.organizations (name, quota_limit, quota_used) VALUES ($1, 100, 0) RETURNING id, name, created_at;',
      [name]
    );
    const org = orgRes.rows[0];

    // 2. Add user as owner in org_members
    await client.query(
      'INSERT INTO public.org_members (org_id, user_id, role) VALUES ($1, $2, $3);',
      [org.id, userId, 'owner']
    );

    await client.query('COMMIT');
    await client.end();

    return res.status(200).json({
      success: true,
      organization: org,
      user_id: userId,
      role: 'owner',
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
