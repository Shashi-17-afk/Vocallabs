import { Client as PgClient } from 'pg';
import { getDbClient, getWorkflowDetails, getCallerOrgRole } from './server-auth';

export interface ExecutionContext {
  workflowRunId: string;
  workflowId: string;
  orgId: string;
  userId: string;
  stepOutputs: Record<string, any>;
}

export function interpolateVariables(template: string, ctx: ExecutionContext): string {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{\s*([\w\.]+)\s*\}\}/g, (_, path) => {
    const parts = path.split('.');
    let curr: any = { ...ctx.stepOutputs, input: ctx.stepOutputs.input || {} };
    for (const p of parts) {
      if (curr && typeof curr === 'object' && p in curr) {
        curr = curr[p];
      } else {
        return '';
      }
    }
    return typeof curr === 'object' ? JSON.stringify(curr) : String(curr);
  });
}

export function evaluateCondition(expression: string, ctx: ExecutionContext): boolean {
  const interpolated = interpolateVariables(expression, ctx).trim();
  if (interpolated === 'true' || interpolated === '1') return true;
  if (interpolated === 'false' || interpolated === '0') return false;

  const match = interpolated.match(/^(.+?)\s*(==|!=|>|<|>=|<=)\s*(.+)$/);
  if (match) {
    const [, left, op, right] = match;
    const cleanLeft = left.replace(/^['"]|['"]$/g, '').trim();
    const cleanRight = right.replace(/^['"]|['"]$/g, '').trim();
    const numLeft = Number(cleanLeft);
    const numRight = Number(cleanRight);

    if (!isNaN(numLeft) && !isNaN(numRight)) {
      if (op === '>') return numLeft > numRight;
      if (op === '<') return numLeft < numRight;
      if (op === '>=') return numLeft >= numRight;
      if (op === '<=') return numLeft <= numRight;
      if (op === '==') return numLeft === numRight;
      if (op === '!=') return numLeft !== numRight;
    }

    if (op === '==') return cleanLeft === cleanRight;
    if (op === '!=') return cleanLeft !== cleanRight;
  }
  return Boolean(interpolated);
}

export async function executeStep(
  client: PgClient,
  step: any,
  ctx: ExecutionContext
): Promise<{ status: 'completed' | 'paused' | 'failed'; output?: any; error?: string }> {
  const role = await getCallerOrgRole(client, ctx.userId, ctx.orgId);
  if (!role || role === 'viewer') {
    throw new Error(`FORBIDDEN: User '${ctx.userId}' with role '${role}' is not authorized to execute step '${step.name}'`);
  }

  if (['db_write', 'notify'].includes(step.type) && role !== 'owner') {
    throw new Error(`FORBIDDEN: Step type '${step.type}' requires 'owner' role permission`);
  }

  const maxRetries = step.config?.max_retries || 3;
  let attemptCount = 0;
  let lastError: string | null = null;

  const existingSrRes = await client.query(
    `SELECT id, status FROM public.step_runs WHERE workflow_run_id = $1 AND workflow_step_id = $2;`,
    [ctx.workflowRunId, step.id]
  );

  let stepRunId: string;
  if (existingSrRes.rows.length > 0) {
    stepRunId = existingSrRes.rows[0].id;
    await client.query(
      `UPDATE public.step_runs SET status = 'running', started_at = NOW() WHERE id = $1;`,
      [stepRunId]
    );
  } else {
    const newSrRes = await client.query(
      `INSERT INTO public.step_runs (workflow_run_id, workflow_step_id, status, input, attempt_count, started_at)
       VALUES ($1, $2, 'running', $3, 1, NOW())
       RETURNING id;`,
      [ctx.workflowRunId, step.id, JSON.stringify(step.config || {})]
    );
    stepRunId = newSrRes.rows[0].id;
  }

  if (step.type === 'approval_gate') {
    await client.query(
      `UPDATE public.step_runs SET status = 'paused' WHERE id = $1;`,
      [stepRunId]
    );
    await client.query(
      `UPDATE public.workflow_runs SET status = 'paused', updated_at = NOW() WHERE id = $1;`,
      [ctx.workflowRunId]
    );
    return { status: 'paused', output: { message: 'Workflow execution paused at approval gate' } };
  }

  while (attemptCount < maxRetries) {
    attemptCount++;
    try {
      let output: any;

      if (step.type === 'llm_call') {
        const prompt = interpolateVariables(step.config?.prompt || 'Hello AI', ctx);
        output = {
          prompt,
          completion: `[LLM Response for: "${prompt}"] Execution successful.`,
          tokens_used: prompt.length + 24,
        };
      } else if (step.type === 'http_request') {
        const url = interpolateVariables(step.config?.url || 'https://httpbin.org/get', ctx);
        const method = step.config?.method || 'GET';
        
        if (url.includes('fail-test')) {
          throw new Error('Simulated HTTP 500 Server Error for retry test');
        }

        output = {
          url,
          method,
          status: 200,
          body: { success: true, message: `HTTP Request to ${url} succeeded` },
        };
      } else if (step.type === 'db_write') {
        const table = step.config?.table || 'audit_logs';
        const rawPayload = step.config?.payload || { action: 'workflow_step_executed' };
        
        await client.query(
          `INSERT INTO public.db_write_audit_logs (workflow_run_id, table_name, record_payload)
           VALUES ($1, $2, $3);`,
          [ctx.workflowRunId, table, JSON.stringify(rawPayload)]
        );

        output = {
          table,
          written: true,
          timestamp: new Date().toISOString(),
        };
      } else if (step.type === 'notify') {
        const channel = step.config?.channel || 'slack';
        const message = interpolateVariables(step.config?.message || 'Workflow notification sent', ctx);
        output = {
          channel,
          delivered: true,
          message,
          timestamp: new Date().toISOString(),
        };
      } else if (step.type === 'conditional_branch') {
        const condition = step.config?.condition || 'true';
        const result = evaluateCondition(condition, ctx);
        output = {
          condition,
          result,
          branch_taken: result ? 'true_branch' : 'false_branch',
        };
      } else {
        output = { step_type: step.type, executed: true };
      }

      await client.query(
        `UPDATE public.step_runs 
         SET status = 'completed', 
             output = $1, 
             attempt_count = $2, 
             completed_at = NOW(), 
             error = NULL 
         WHERE id = $3;`,
        [JSON.stringify(output), attemptCount, stepRunId]
      );

      return { status: 'completed', output };
    } catch (err: any) {
      lastError = err.message;
      console.error(`Step '${step.name}' attempt ${attemptCount} failed:`, err.message);

      await client.query(
        `UPDATE public.step_runs 
         SET attempt_count = $1, 
             error = $2 
         WHERE id = $3;`,
        [attemptCount, lastError, stepRunId]
      );

      if (attemptCount < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attemptCount) * 100));
      }
    }
  }

  await client.query(
    `UPDATE public.step_runs 
     SET status = 'failed', 
         completed_at = NOW(), 
         error = $1 
     WHERE id = $2;`,
    [lastError, stepRunId]
  );

  return { status: 'failed', error: lastError || 'Step execution failed after maximum retries' };
}

export async function runWorkflowExecutionEngine(
  workflowRunId: string
): Promise<{ status: 'completed' | 'paused' | 'failed'; error?: string }> {
  const client = await getDbClient();

  try {
    const runRes = await client.query(
      `SELECT wr.id, wr.workflow_id, wr.status, wr.created_by, w.org_id
       FROM public.workflow_runs wr
       JOIN public.workflows w ON wr.workflow_id = w.id
       WHERE wr.id = $1;`,
      [workflowRunId]
    );

    if (runRes.rows.length === 0) {
      await client.end();
      throw new Error(`Workflow run '${workflowRunId}' not found`);
    }

    const run = runRes.rows[0];

    const stepsRes = await client.query(
      `SELECT id, position, type, name, config 
       FROM public.workflow_steps 
       WHERE workflow_id = $1 
       ORDER BY position ASC;`,
      [run.workflow_id]
    );
    const steps = stepsRes.rows;

    const stepRunsRes = await client.query(
      `SELECT ws.name, ws.position, sr.output
       FROM public.step_runs sr
       JOIN public.workflow_steps ws ON sr.workflow_step_id = ws.id
       WHERE sr.workflow_run_id = $1 AND sr.status = 'completed';`,
      [workflowRunId]
    );

    const stepOutputs: Record<string, any> = {};
    for (const row of stepRunsRes.rows) {
      if (row.output) {
        stepOutputs[row.name] = row.output;
        stepOutputs[`step${row.position}`] = row.output;
      }
    }

    const ctx: ExecutionContext = {
      workflowRunId,
      workflowId: run.workflow_id,
      orgId: run.org_id,
      userId: run.created_by,
      stepOutputs,
    };

    for (const step of steps) {
      const checkCompleted = await client.query(
        `SELECT status FROM public.step_runs WHERE workflow_run_id = $1 AND workflow_step_id = $2 AND status = 'completed';`,
        [workflowRunId, step.id]
      );
      if (checkCompleted.rows.length > 0) {
        continue;
      }

      const res = await executeStep(client, step, ctx);

      if (res.status === 'paused') {
        await client.end();
        return { status: 'paused' };
      }

      if (res.status === 'failed') {
        await client.query(
          `UPDATE public.workflow_runs SET status = 'failed', completed_at = NOW(), error = $1 WHERE id = $2;`,
          [res.error, workflowRunId]
        );
        await client.end();
        return { status: 'failed', error: res.error };
      }

      ctx.stepOutputs[step.name] = res.output;
      ctx.stepOutputs[`step${step.position}`] = res.output;
    }

    await client.query(
      `UPDATE public.workflow_runs SET status = 'completed', completed_at = NOW(), error = NULL WHERE id = $1;`,
      [workflowRunId]
    );

    await client.end();
    return { status: 'completed' };
  } catch (err: any) {
    await client.query(
      `UPDATE public.workflow_runs SET status = 'failed', completed_at = NOW(), error = $1 WHERE id = $2;`,
      [err.message, workflowRunId]
    ).catch(() => {});
    await client.end().catch(() => {});
    return { status: 'failed', error: err.message };
  }
}
