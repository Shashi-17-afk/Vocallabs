import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbClient, getCallerOrgRole } from '@/lib/server-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const actionSecret = req.headers['x-hasura-action-secret'];
  const expectedSecret = process.env.ACTION_SECRET;
  if (expectedSecret && actionSecret !== expectedSecret) {
    return res.status(401).json({ message: 'Unauthorized Hasura Action request' });
  }

  const sessionVariables = req.body.session_variables || {};
  const userId = sessionVariables['x-hasura-user-id'] || req.headers['x-hasura-user-id'];
  const { step_run_id } = req.body.input || req.body;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthenticated: x-hasura-user-id session variable is missing' });
  }

  if (!step_run_id) {
    return res.status(400).json({ message: 'Missing required argument: step_run_id' });
  }

  const client = await getDbClient();

  try {
    // 1. Fetch step_run, workflow_run, workflow_step, and workflow org_id
    const stepRunQuery = await client.query(
      `SELECT 
         sr.id AS step_run_id,
         sr.status AS step_run_status,
         wr.id AS workflow_run_id,
         wr.status AS workflow_run_status,
         ws.type AS step_type,
         w.id AS workflow_id,
         w.org_id AS org_id
       FROM public.step_runs sr
       JOIN public.workflow_runs wr ON sr.workflow_run_id = wr.id
       JOIN public.workflow_steps ws ON sr.workflow_step_id = ws.id
       JOIN public.workflows w ON wr.workflow_id = w.id
       WHERE sr.id = $1;`,
      [step_run_id]
    );

    if (stepRunQuery.rows.length === 0) {
      await client.end();
      return res.status(400).json({ message: `Step run with ID '${step_run_id}' not found` });
    }

    const sr = stepRunQuery.rows[0];

    // 2. Perform Layer 2 Authorization Check
    const role = await getCallerOrgRole(client, userId as string, sr.org_id);
    if (!role || role === 'viewer') {
      await client.end();
      return res.status(403).json({
        message: `FORBIDDEN: Role '${role || 'non-member'}' is not authorized to approve workflow steps`,
      });
    }

    // 3. Verify target step is an approval_gate
    if (sr.step_type !== 'approval_gate') {
      await client.end();
      return res.status(400).json({
        message: `INVALID_OPERATION: Target step run '${step_run_id}' is of type '${sr.step_type}', not an 'approval_gate'`,
      });
    }

    // 4. Verify step run is currently in 'paused' state
    if (sr.step_run_status !== 'paused') {
      await client.end();
      return res.status(400).json({
        message: `INVALID_OPERATION: Target step run '${step_run_id}' is currently '${sr.step_run_status}', not 'paused'`,
      });
    }

    // 5. Update step_run and workflow_run statuses
    await client.query('BEGIN');

    const updateStepRes = await client.query(
      `UPDATE public.step_runs 
       SET status = 'completed', 
           approved_by = $1, 
           approved_at = NOW(), 
           completed_at = NOW() 
       WHERE id = $2 
       RETURNING id, approved_by, approved_at;`,
      [userId, step_run_id]
    );

    await client.query(
      `UPDATE public.workflow_runs 
       SET status = 'running', 
           updated_at = NOW() 
       WHERE id = $1;`,
      [sr.workflow_run_id]
    );

    await client.query('COMMIT');
    await client.end();

    const updatedStep = updateStepRes.rows[0];

    return res.status(200).json({
      status: 'resumed',
      step_run_id: updatedStep.id,
      approved_by: updatedStep.approved_by,
      approved_at: updatedStep.approved_at,
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    return res.status(500).json({ message: err.message });
  }
}
