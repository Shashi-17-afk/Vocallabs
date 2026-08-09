# Layer 2 Server-Side Authorization & Workflow CRUD Verification Report

This document records the empirical verification results for Phase 6 (Layer 2 Server-Side Authorization Rules) and Phase 7 (Workflow CRUD Operations).

## Verification Matrix

| Test | Role | Operation | Expected | Actual | Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Owner workflow CRUD** | Owner A | `Create Workflow` | PASS (Created) | `Created UUID 81d5f96f-997a-4155-ba0d-4a49a7fa7cb5` | **PASS** |
| **2. Editor workflow CRUD** | Editor A | `Create Workflow` | PASS (Created) | `Created UUID a5cad2c5-e059-49cb-8d10-df1dfc0b2c11` | **PASS** |
| **3. Viewer workflow read** | Viewer A | `workflows_by_pk` | PASS (Returned workflow) | `{"id":"81d5f96f-997a-4155-ba0d-4a49a7fa7cb5","name":"Owner Created Workflow"}` | **PASS** |
| **4. Viewer workflow mutation** | Viewer A | `insert_workflows_one` | DENIED | `DENIED: check constraint of an insert/update permission has failed` | **PASS** |
| **5. Editor adding normal step** | Editor A | `Add step (llm_call)` | PASS (200 OK) | `Status 200, Step ID 2d93a118-6307-4992-a945-3027a4eadb42` | **PASS** |
| **6. Editor adding db_write** | Editor A | `Add step (db_write)` | DENIED (403 Forbidden) | `Status 403, FORBIDDEN: Step type 'db_write' requires 'owner' role permission` | **PASS** |
| **7. Editor adding notify** | Editor A | `Add step (notify)` | DENIED (403 Forbidden) | `Status 403, FORBIDDEN: Step type 'notify' requires 'owner' role permission` | **PASS** |
| **8. Editor creating webhook trigger** | Editor A | `Add trigger (webhook)` | DENIED (403 Forbidden) | `Status 403, FORBIDDEN: Trigger type 'webhook' requires 'owner' role permission` | **PASS** |
| **9. Owner adding db_write** | Owner A | `Add step (db_write)` | PASS (200 OK) | `Status 200, Step ID d7e93a86-800d-4cae-a424-4c7798a95c2b` | **PASS** |
| **10. Owner adding notify** | Owner A | `Add step (notify)` | PASS (200 OK) | `Status 200, Step ID 7c5dd1b8-47fc-4795-838e-676658fca043` | **PASS** |
| **11. Owner creating webhook trigger** | Owner A | `Add trigger (webhook)` | PASS (200 OK) | `Status 200, Trigger ID 7a8bac43-3569-4499-b16f-c9b24d232e9f` | **PASS** |
| **12. Org B attack against Org A** | Owner B (Org B) | `Modify Org A Workflow` | DENIED (403 Forbidden) | `Status 403, FORBIDDEN: Role 'non-member' cannot modify workflow steps` | **PASS** |
| **Action: triggerWorkflowRun (Editor)** | Editor A | `triggerWorkflowRun` | PASS (Started) | `Run ID a3e4e6a5-2aec-426a-84a8-d2d36fb550ce` | **PASS** |
| **Action: triggerWorkflowRun (Viewer)** | Viewer A | `triggerWorkflowRun` | DENIED (403) | `Status 403, FORBIDDEN: Role 'viewer' is not authorized to trigger workflow execution` | **PASS** |
| **Action: approveStep (Viewer)** | Viewer A | `approveStep` | DENIED (403) | `Status 403, FORBIDDEN: Role 'viewer' is not authorized to approve workflow steps` | **PASS** |
| **Action: approveStep (Editor)** | Editor A | `approveStep` | PASS (Resumed) | `Status resumed, Approved by 44444444-4444-4444-a444-444444444444` | **PASS** |

---

## Role Capabilities & Server-Side Enforcement Architecture

| Role | Workflow Read | Workflow Create/Edit | Workflow Delete | Normal Steps | Privileged Steps (`db_write`, `notify`) | Webhook Triggers | Trigger Run Action | Approve Step Action |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Owner** | Allowed | Allowed | Allowed | Allowed | Allowed | Allowed | Allowed | Allowed |
| **Editor** | Allowed | Allowed | Denied | Allowed | **Denied (403)** | **Denied (403)** | Allowed | Allowed |
| **Viewer** | Allowed | Denied | Denied | Denied | Denied | Denied | **Denied (403)** | **Denied (403)** |

---

## Executed Server-Side Authorization Handlers

1. **`triggerWorkflowRun` Action Handler** (`src/pages/api/actions/trigger-workflow.ts`):
   - Extracts `x-hasura-user-id` session header.
   - Loads workflow -> verifies organization membership and role.
   - Restricts `viewer` role (returns HTTP 403 Forbidden).
   - Atomically updates organization monthly quota limit.

2. **`approveStep` Action Handler** (`src/pages/api/actions/approve-step.ts`):
   - Extracts `x-hasura-user-id` session header.
   - Verifies target step is an `approval_gate` in `paused` state.
   - Restricts `viewer` role (returns HTTP 403 Forbidden).
   - Sets `status = 'completed'`, records `approved_by` and `approved_at`, resumes workflow run.

3. **Privileged Step API Handler** (`src/pages/api/workflows/steps.ts`):
   - Enforces owner-only permission for `db_write` and `notify` step types.

4. **Privileged Trigger API Handler** (`src/pages/api/workflows/triggers.ts`):
   - Enforces owner-only permission for `webhook` trigger types.
