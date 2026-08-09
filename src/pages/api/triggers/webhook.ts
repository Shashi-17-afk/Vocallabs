import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbClient } from '@/lib/server-auth';
import { runWorkflowExecutionEngine } from '@/lib/execution-engine';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { workflow_id, secret } = req.query;
  const triggerSecretHeader = req.headers['x-trigger-secret'] || secret;

  if (!workflow_id) {
    return res.status(400).json({ message: 'Missing required query parameter: workflow_id' });
  }

  const client = await getDbClient();

  try {
    const trigRes = await client.query(
      `SELECT wt.id, wt.config, wt.enabled, w.id AS workflow_id, w.org_id, w.created_by
       FROM public.workflow_triggers wt
       JOIN public.workflows w ON wt.workflow_id = w.id
       WHERE w.id = $1 AND wt.type = 'webhook' AND wt.enabled = true;`,
      [workflow_id]
    );

    if (trigRes.rows.length === 0) {
      await client.end();
      return res.status(404).json({ message: `No active webhook trigger found for workflow '${workflow_id}'` });
    }

    const trig = trigRes.rows[0];
    const expectedSecret = trig.config?.secret || 'secret_webhook_key_123';

    if (triggerSecretHeader && triggerSecretHeader !== expectedSecret) {
      await client.end();
      return res.status(401).json({ message: 'Unauthorized: Invalid trigger secret key' });
    }

    const quotaRes = await client.query(
      `UPDATE public.organizations 
       SET quota_used = quota_used + 1, updated_at = NOW() 
       WHERE id = $1 AND quota_used < quota_limit 
       RETURNING quota_used, quota_limit;`,
      [trig.org_id]
    );

    if (quotaRes.rows.length === 0) {
      await client.end();
      return res.status(400).json({ message: 'ORGANIZATION_QUOTA_EXHAUSTED: Monthly quota limit reached' });
    }

    const runRes = await client.query(
      `INSERT INTO public.workflow_runs (workflow_id, trigger_type, status, created_by) 
       VALUES ($1, 'webhook', 'running', $2) 
       RETURNING id, status, started_at;`,
      [trig.workflow_id, trig.created_by]
    );
    const run = runRes.rows[0];
    await client.end();

    // Await Execution Engine loop so step execution & state transitions complete deterministically
    const execResult = await runWorkflowExecutionEngine(run.id);

    return res.status(200).json({
      status: 'triggered',
      trigger_type: 'webhook',
      run_id: run.id,
      workflow_id: trig.workflow_id,
      execution_status: execResult.status,
      started_at: run.started_at,
    });
  } catch (err: any) {
    await client.end().catch(() => {});
    return res.status(500).json({ message: err.message });
  }
}
