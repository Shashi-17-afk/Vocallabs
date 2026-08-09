import type { NextApiRequest, NextApiResponse } from 'next';
import { getDbClient } from '@/lib/server-auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  // 1. Authenticate Hasura Event Trigger Secret
  const secretHeader = req.headers['x-hasura-event-secret'] || req.headers['x-hasura-action-secret'];
  const expectedSecret = process.env.EVENT_SECRET || process.env.ACTION_SECRET || 'test_event_secret_key_123';

  if (secretHeader !== expectedSecret) {
    return res.status(401).json({ message: 'Unauthorized: Invalid Hasura Event Trigger secret' });
  }

  const body = req.body || {};
  const eventId = body.id || body.event_id;
  const newData = body.event?.data?.new || body.data;

  if (!newData || !newData.id) {
    return res.status(400).json({ message: 'Invalid payload: missing step_run data' });
  }

  const stepRunId = newData.id;
  const stepRunStatus = newData.status;

  // Verify status is completed
  if (stepRunStatus !== 'completed') {
    return res.status(200).json({ status: 'ignored', message: `Step run status is '${stepRunStatus}', expected 'completed'` });
  }

  const client = await getDbClient();

  try {
    // 2. Fetch step details and verify step type is 'notify'
    const stepQuery = await client.query(
      `SELECT sr.id AS step_run_id, sr.status, sr.output, ws.type AS step_type, ws.name AS step_name, ws.config
       FROM public.step_runs sr
       JOIN public.workflow_steps ws ON sr.workflow_step_id = ws.id
       WHERE sr.id = $1;`,
      [stepRunId]
    );

    if (stepQuery.rows.length === 0) {
      await client.end();
      return res.status(404).json({ message: `Step run '${stepRunId}' not found` });
    }

    const stepInfo = stepQuery.rows[0];

    if (stepInfo.step_type !== 'notify') {
      await client.end();
      return res.status(200).json({ status: 'ignored', message: `Step type '${stepInfo.step_type}' is not 'notify'` });
    }

    // 3. Ensure notification_logs table exists for Idempotency
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.notification_logs (
        event_id TEXT PRIMARY KEY,
        step_run_id UUID NOT NULL,
        channel TEXT,
        delivered_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // 4. Idempotency Check: Atomic insert on conflict do nothing
    const effectiveEventId = eventId || `evt_${stepRunId}`;
    const insertLogRes = await client.query(
      `INSERT INTO public.notification_logs (event_id, step_run_id, channel)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id;`,
      [effectiveEventId, stepRunId, stepInfo.config?.channel || 'slack']
    );

    if (insertLogRes.rows.length === 0) {
      // Duplicate event delivery detected -> Skip gracefully
      await client.end();
      return res.status(200).json({
        status: 'idempotent_skip',
        event_id: effectiveEventId,
        message: 'Event already processed and notification delivered previously',
      });
    }

    // 5. Deliver Notification Payload (Mock Slack / Email / Webhook delivery)
    const notificationPayload = {
      event_id: effectiveEventId,
      step_run_id: stepRunId,
      channel: stepInfo.config?.channel || 'slack',
      message: stepInfo.output?.message || stepInfo.config?.message || 'Notification step completed',
      delivered_at: new Date().toISOString(),
    };

    console.log(`[NOTIFY EVENT TRIGGER HANDLER] Successfully delivered notification for step '${stepInfo.step_name}':`, notificationPayload);

    await client.end();

    return res.status(200).json({
      status: 'delivered',
      event_id: effectiveEventId,
      step_run_id: stepRunId,
      notification: notificationPayload,
    });
  } catch (err: any) {
    await client.end().catch(() => {});
    return res.status(500).json({ message: err.message });
  }
}
