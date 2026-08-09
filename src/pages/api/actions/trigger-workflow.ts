import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbClient, getWorkflowDetails, getCallerOrgRole } from '@/lib/server-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  // Optional: verify action secret header from Hasura
  const actionSecret = req.headers['x-hasura-action-secret'];
  const expectedSecret = process.env.ACTION_SECRET;
  if (expectedSecret && actionSecret !== expectedSecret) {
    return res.status(401).json({ message: 'Unauthorized Hasura Action request' });
  }

  // Extract Hasura session variables and input
  const sessionVariables = req.body.session_variables || {};
  const userId = sessionVariables['x-hasura-user-id'] || req.headers['x-hasura-user-id'];
  const { workflow_id } = req.body.input || req.body;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthenticated: x-hasura-user-id session variable is missing' });
  }

  if (!workflow_id) {
    return res.status(400).json({ message: 'Missing required argument: workflow_id' });
  }

  const client = await getDbClient();

  try {
    // 1. Get workflow details
    const workflow = await getWorkflowDetails(client, workflow_id);
    if (!workflow) {
      await client.end();
      return res.status(400).json({ message: `Workflow with ID '${workflow_id}' not found` });
    }

    // 2. Perform Layer 2 Server-Side Authorization Check
    const role = await getCallerOrgRole(client, userId as string, workflow.orgId);
    if (!role || role === 'viewer') {
      await client.end();
      return res.status(403).json({
        message: `FORBIDDEN: Role '${role || 'non-member'}' is not authorized to trigger workflow execution`,
      });
    }

    // 3. Atomic Quota Lock & Reservation Check
    const quotaRes = await client.query(
      `UPDATE public.organizations 
       SET quota_used = quota_used + 1, updated_at = NOW() 
       WHERE id = $1 AND quota_used < quota_limit 
       RETURNING quota_used, quota_limit;`,
      [workflow.orgId]
    );

    if (quotaRes.rows.length === 0) {
      await client.end();
      return res.status(400).json({ message: 'ORGANIZATION_QUOTA_EXHAUSTED: Monthly quota limit reached' });
    }

    // 4. Initialize Workflow Run
    const runRes = await client.query(
      `INSERT INTO public.workflow_runs (workflow_id, trigger_type, status, created_by) 
       VALUES ($1, 'manual', 'running', $2) 
       RETURNING id, status, started_at;`,
      [workflow.id, userId]
    );
    const run = runRes.rows[0];

    await client.end();

    return res.status(200).json({
      run_id: run.id,
      status: 'started',
      started_at: run.started_at,
    });
  } catch (err: any) {
    await client.end().catch(() => {});
    return res.status(500).json({ message: err.message });
  }
}
