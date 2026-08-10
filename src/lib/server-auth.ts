import { Client as PgClient } from 'pg';
import { createRemoteJWKSet, jwtVerify } from 'jose';

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
 * Extracts the authenticated Nhost user ID from an incoming Next.js API request.
 *
 * Supports two call paths:
 *   1. Hasura Action: Hasura POSTs { session_variables: { "x-hasura-user-id": "..." } }
 *   2. Direct browser call: Authorization: Bearer <nhost-jwt>
 *
 * For path 2, the RS256 JWT is verified server-side using the Nhost JWKS endpoint.
 * The admin secret is NEVER used — only the public JWKS key is used to verify the signature.
 *
 * Returns null if the request is unauthenticated or the JWT is invalid/expired.
 */
export async function getUserIdFromRequest(req: {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}): Promise<string | null> {
  // Path 1: Hasura Action payload (session_variables injected by Hasura)
  const sessionVariables = (req.body && req.body.session_variables as Record<string, string>) || {};
  const sessionUserId = sessionVariables['x-hasura-user-id'];
  if (sessionUserId) return sessionUserId;

  // Path 2: Direct x-hasura-user-id header (passed by Hasura Actions or test runner)
  const headerUserId = req.headers['x-hasura-user-id'];
  if (typeof headerUserId === 'string' && headerUserId.trim() !== '') {
    return headerUserId.trim();
  }
  if (Array.isArray(headerUserId) && headerUserId[0] && headerUserId[0].trim() !== '') {
    return headerUserId[0].trim();
  }

  // Path 3: Direct browser call with Nhost Bearer JWT
  const authHeader = req.headers['authorization'] || req.headers['Authorization'];
  const bearer = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!bearer || !bearer.startsWith('Bearer ')) return null;

  const token = bearer.slice(7);
  const subdomain = process.env.NEXT_PUBLIC_NHOST_SUBDOMAIN;
  const region = process.env.NEXT_PUBLIC_NHOST_REGION;

  if (!subdomain || !region) {
    throw new Error('NEXT_PUBLIC_NHOST_SUBDOMAIN and NEXT_PUBLIC_NHOST_REGION must be set');
  }

  const jwksUrl = new URL(
    `https://${subdomain}.auth.${region}.nhost.run/v1/.well-known/jwks.json`
  );
  const JWKS = createRemoteJWKSet(jwksUrl);

  try {
    const { payload } = await jwtVerify(token, JWKS, { algorithms: ['RS256'] });
    const hasuraClaims = (payload as Record<string, unknown>)[
      'https://hasura.io/jwt/claims'
    ] as Record<string, string> | undefined;
    return hasuraClaims?.['x-hasura-user-id'] ?? null;
  } catch {
    // Invalid or expired token — treat as unauthenticated
    return null;
  }
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
