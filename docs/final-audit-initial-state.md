# Phase 0 — Initial Repository & Architecture Audit

## 1. Architecture Found
- **Frontend**: Next.js 14.2.13 (React 18 + TypeScript), styling with custom dark glassmorphism design system (`src/styles/globals.css`).
- **Auth Provider**: Nhost Auth Service (`@nhost/react`, `@nhost/react-apollo`, `@nhost/nhost-js`), using RS256/HS256 JWTs with Hasura session claims (`x-hasura-user-id`, `x-hasura-default-role: "user"`, `x-hasura-allowed-roles: ["user"]`).
- **GraphQL Engine**: Hasura GraphQL Engine (`https://enough-tetra-90.hasura.app/v1/graphql`) backed by Supabase PostgreSQL.
- **Database Schema**: Supabase PostgreSQL 17.6 database containing `organizations`, `org_members`, `workflows`, `workflow_steps`, `workflow_triggers`, `workflow_runs`, `step_runs`, `db_write_audit_logs`, and `notification_logs`.
- **Server Handlers**: Next.js API Routes (`/api/actions/trigger-workflow`, `/api/actions/approve-step`, `/api/events/notify`, `/api/triggers/webhook`).
- **Layer 1 Authorization**: Hasura row-level permission rules on all schema tables filtering via `org_members.user_id = X-Hasura-User-Id`.
- **Layer 2 Authorization**: Server-side role checks (`getCallerOrgRole`) enforcing `owner`, `editor`, `viewer` capabilities and restricting `db_write`, `notify`, `webhook` to `owner`.
- **Workflow Execution Engine**: Sequential step execution loop (`src/lib/execution-engine.ts`) with dynamic variable interpolation (`{{step1.output}}`), conditional branch evaluation, retry backoff, and approval gate pause/resume.
- **Real-Time UI**: Apollo Client + `graphql-ws` WebSocket subscriptions (`SUBSCRIBE_WORKFLOWS`, `SUBSCRIBE_ACTIVE_RUN`).

---

## 2. Expected Architecture Comparison
| Requirement | Status | Architecture Location |
| :--- | :--- | :--- |
| Nhost Auth | Present | `@nhost/react`, `src/lib/nhost.ts` |
| Hasura GraphQL Engine | Present | Hosted Hasura + `src/lib/graphql-client.ts` |
| PostgreSQL Database | Present | Supabase PostgreSQL 17.6 + `migrations/001_initial_schema.sql` |
| Multi-tenant Orgs & Roles | Present | `organizations`, `org_members` (`owner`, `editor`, `viewer`) |
| Hasura Row Permissions | Present | `scripts/setup-hasura-permissions.js` |
| Hasura Actions | Present | `/api/actions/trigger-workflow`, `/api/actions/approve-step` |
| Hasura Event Trigger | Present | `/api/events/notify` + `hasura/metadata/event_triggers.yaml` |
| Execution Engine & Retries | Present | `src/lib/execution-engine.ts` |
| Approval Gate Pause/Resume | Present | `approval_gate` type in execution loop + `/api/actions/approve-step` |
| Atomic Quota Locking | Present | `UPDATE organizations SET quota_used = quota_used + 1 ...` |
| Non-Manual Webhook Trigger | Present | `/api/triggers/webhook` |
| Live Subscriptions | Present | `graphql-ws` in `src/lib/graphql-client.ts` & `src/pages/index.tsx` |

---

## 3. Known Limitations & Notes
- `llm_call` step uses a simulated/stubbed completion generator in `src/lib/execution-engine.ts`. This will be explicitly noted in the final scorecard.
- Scheduled trigger runner is not present (webhook trigger fulfills non-manual trigger requirement).

---

## 4. Initial Test Inventory
- `scripts/test-layer1-security.js`: Layer 1 isolation & cross-org UUID guessing tests.
- `scripts/test-phase7-graphql-crud.js`: Native GraphQL CRUD and role permission tests.
- `scripts/test-phase8-execution-engine.js`: Execution loop, retry, webhook, quota tests.
- `scripts/test-hasura-event-trigger.js`: Hasura Database Event Trigger & idempotency tests.
