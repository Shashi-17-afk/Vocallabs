import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbClient } from '@/lib/server-auth';
import { runWorkflowExecutionEngine } from '@/lib/execution-engine';
import crypto from 'crypto';

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  const { workflow_id } = req.query;

  if (!workflow_id || typeof workflow_id !== 'string') {
    return res.status(400).json({ message: 'Missing required query parameter: workflow_id' });
  }

  // Extract incoming trigger secret from header, query, or body
  let incomingSecret: string | undefined = undefined;

  const triggerSecretHeader = req.headers['x-trigger-secret'];
  const authHeader = req.headers['authorization'];

  if (typeof triggerSecretHeader === 'string' && triggerSecretHeader.trim() !== '') {
    incomingSecret = triggerSecretHeader.trim();
  } else if (typeof authHeader === 'string' && authHeader.trim() !== '') {
    const trimmed = authHeader.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      incomingSecret = trimmed.substring(7).trim();
    } else {
      incomingSecret = trimmed;
    }
  } else if (typeof req.query.secret === 'string' && req.query.secret.trim() !== '') {
    incomingSecret = req.query.secret.trim();
  } else if (req.body && typeof req.body === 'object' && typeof req.body.secret === 'string' && req.body.secret.trim() !== '') {
    incomingSecret = req.body.secret.trim();
  }

  if (!incomingSecret) {
    return res.status(401).json({ message: 'Unauthorized: Missing trigger secret key' });
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

    if (!safeCompare(incomingSecret, expectedSecret)) {
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
