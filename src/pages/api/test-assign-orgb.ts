import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbClient, getUserIdFromRequest } from '@/lib/server-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const userId = await getUserIdFromRequest(req);
  if (!userId) {
    return res.status(401).json({ message: 'Unauthorized: Missing or invalid authentication token' });
  }

  const { role } = req.body || {};
  const targetRole = role === 'viewer' ? 'viewer' : 'editor';

  const client = await getDbClient();

  try {
    // Get or Create Production Org B
    let orgRes = await client.query(`SELECT id FROM public.organizations WHERE name = 'Production Org B';`);
    let orgBId: string;

    if (orgRes.rows.length === 0) {
      const newOrg = await client.query(`INSERT INTO public.organizations (name, quota_limit) VALUES ('Production Org B', 100) RETURNING id;`);
      orgBId = newOrg.rows[0].id;
    } else {
      orgBId = orgRes.rows[0].id;
    }

    // Insert membership into Production Org B
    await client.query(
      `INSERT INTO public.org_members (org_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = $3;`,
      [orgBId, userId, targetRole]
    );

    await client.end();

    return res.status(200).json({
      message: `Successfully assigned user to Production Org B with role '${targetRole}'`,
      org_id: orgBId,
      user_id: userId,
      role: targetRole,
    });
  } catch (err: any) {
    await client.end().catch(() => {});
    return res.status(500).json({ message: err.message });
  }
}
