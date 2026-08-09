import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbClient, getWorkflowDetails, getCallerOrgRole, validateStepCreationRole } from '@/lib/server-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const userId = req.headers['x-hasura-user-id'] as string;
  const { workflow_id, position, type, name, config } = req.body;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthenticated: x-hasura-user-id header is missing' });
  }

  if (!workflow_id || !type || !name) {
    return res.status(400).json({ message: 'Missing required fields: workflow_id, type, name' });
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
      return res.status(403).json({ message: `FORBIDDEN: Role '${role || 'non-member'}' cannot modify workflow steps` });
    }

    // Enforce Layer 2 Owner-Only Step Restrictions
    try {
      validateStepCreationRole(role, type);
    } catch (err: any) {
      await client.end();
      return res.status(403).json({ message: err.message });
    }

    const stepRes = await client.query(
      `INSERT INTO public.workflow_steps (workflow_id, position, type, name, config)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *;`,
      [workflow_id, position || 1, type, name, JSON.stringify(config || {})]
    );

    await client.end();
    return res.status(200).json(stepRes.rows[0]);
  } catch (err: any) {
    await client.end().catch(() => {});
    return res.status(500).json({ message: err.message });
  }
}
