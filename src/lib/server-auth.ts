import { Client as PgClient } from 'pg';

export interface CallerOrgContext {
  userId: string;
  orgId: string;
  role: 'owner' | 'editor' | 'viewer' | null;
}

export interface WorkflowDetails {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  createdBy: string;
}

/**
 * Helper to get an isolated DB client for server-side authorization queries
 */
export async function getDbClient(): Promise<PgClient> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL environment variable is missing');
  }
  const client = new PgClient({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

/**
 * Determines caller's role in an organization from database
 */
export async function getCallerOrgRole(
  client: PgClient,
  userId: string,
  orgId: string
): Promise<'owner' | 'editor' | 'viewer' | null> {
  const res = await client.query(
    'SELECT role FROM public.org_members WHERE org_id = $1 AND user_id = $2;',
    [orgId, userId]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0].role as 'owner' | 'editor' | 'viewer';
}

/**
 * Loads workflow details and parent organization ID from database
 */
export async function getWorkflowDetails(
  client: PgClient,
  workflowId: string
): Promise<WorkflowDetails | null> {
  const res = await client.query(
    'SELECT id, org_id, name, description, created_by FROM public.workflows WHERE id = $1;',
    [workflowId]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    description: row.description,
    createdBy: row.created_by,
  };
}

/**
 * Validates Layer 2 Role Restrictions for Privileged Step Types:
 * db_write & notify require 'owner' role.
 */
export function validateStepCreationRole(callerRole: string, stepType: string): void {
  const ownerOnlySteps = ['db_write', 'notify'];
  if (ownerOnlySteps.includes(stepType) && callerRole !== 'owner') {
    throw new Error(`FORBIDDEN: Step type '${stepType}' requires 'owner' role permission`);
  }
}

/**
 * Validates Layer 2 Role Restrictions for Privileged Trigger Types:
 * webhook triggers require 'owner' role.
 */
export function validateTriggerCreationRole(callerRole: string, triggerType: string): void {
  const ownerOnlyTriggers = ['webhook'];
  if (ownerOnlyTriggers.includes(triggerType) && callerRole !== 'owner') {
    throw new Error(`FORBIDDEN: Trigger type '${triggerType}' requires 'owner' role permission`);
  }
}
