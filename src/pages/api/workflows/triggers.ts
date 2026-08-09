import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbClient, getWorkflowDetails, getCallerOrgRole, validateTriggerCreationRole } from '@/lib/server-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const userId = req.headers['x-hasura-user-id'] as string;
  const { workflow_id, type, config, enabled } = req.body;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthenticated: x-hasura-user-id header is missing' });
  }

  if (!workflow_id || !type) {
    return res.status(400).json({ message: 'Missing required fields: workflow_id, type' });
  }

  const client = await getDbClient();

  try {
    const workflow = await getWorkflowDetails(client, workflow_id);
    if (!workflow) {
      await client.end();
      return res.status(400).json({ message: `Workflow '${workflow_id}' not found` });
    }

    const role = await getCallerOrgRole(client, userId, workflow.orgId);
    if (!role || role === 'viewer') {
      await client.end();
      return res.status(403).json({ message: `FORBIDDEN: Role '${role || 'non-member'}' cannot modify workflow triggers` });
    }

    // Enforce Layer 2 Owner-Only Trigger Restrictions
    try {
      validateTriggerCreationRole(role, type);
    } catch (err: any) {
      await client.end();
      return res.status(403).json({ message: err.message });
    }

    const trigRes = await client.query(
      `INSERT INTO public.workflow_triggers (workflow_id, type, config, enabled)
       VALUES ($1, $2, $3, $4)
       RETURNING *;`,
      [workflow_id, type, JSON.stringify(config || {}), enabled !== undefined ? enabled : true]
    );

    await client.end();
    return res.status(200).json(trigRes.rows[0]);
  } catch (err: any) {
    await client.end().catch(() => {});
    return res.status(500).json({ message: err.message });
  }
}
