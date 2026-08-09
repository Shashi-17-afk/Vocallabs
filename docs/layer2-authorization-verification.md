# Native Hasura GraphQL Engine Workflow CRUD & Layer 2 Authorization Report

This document records the empirical verification results for Phase 7 (Native Hasura GraphQL Engine Workflow CRUD Operations) and Phase 6 (Layer 2 Server-Side Authorization Rules).

## Hasura GraphQL Operations Verification Matrix

| Test | User Role | GraphQL Operation | Expected | Actual Result | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Owner creates workflow** | Owner A | `GraphQL insert_workflows_one` | PASS | `Created UUID 9f644919-7ea9-409a-8073-7a7c894ff1b8` | **PASS** |
| **2. Editor creates workflow** | Editor A | `GraphQL insert_workflows_one` | PASS | `Created UUID 76f885ca-8120-4d3a-b84e-e951b7dfd98d` | **PASS** |
| **3. Editor edits workflow** | Editor A | `GraphQL update_workflows_by_pk` | PASS | `{"id":"9f644919-7ea9-409a-8073-7a7c894ff1b8","name":"Updated Org A Workflow Name"}` | **PASS** |
| **4. Editor creates normal step** | Editor A | `GraphQL insert_workflow_steps_one` | PASS | `Created Step UUID 184fd214-459f-4715-9d77-482e72f47f34` | **PASS** |
| **5. Editor edits normal step** | Editor A | `GraphQL update_workflow_steps_by_pk` | PASS | `{"id":"184fd214-459f-4715-9d77-482e72f47f34","name":"Renamed LLM Step"}` | **PASS** |
| **6. Editor reorders steps** | Editor A | `GraphQL update_workflow_steps_many` | PASS | `{"update_workflow_steps_many":[{"affected_rows":1},{"affected_rows":1}]}` | **PASS** |
| **7. Editor cannot create db_write** | Editor A | `GraphQL insert_workflow_steps_one (db_write)` | DENIED | `DENIED: check constraint of an insert/update permission has failed` | **PASS** |
| **8. Editor cannot create notify** | Editor A | `GraphQL insert_workflow_steps_one (notify)` | DENIED | `DENIED: check constraint of an insert/update permission has failed` | **PASS** |
| **9. Editor cannot create webhook trigger** | Editor A | `GraphQL insert_workflow_triggers_one (webhook)` | DENIED | `DENIED: check constraint of an insert/update permission has failed` | **PASS** |
| **10. Owner creates db_write** | Owner A | `GraphQL insert_workflow_steps_one (db_write)` | PASS | `Created Step UUID 970b382a-8f12-4a01-a1b3-35061ce48ffc` | **PASS** |
| **11. Owner creates notify** | Owner A | `GraphQL insert_workflow_steps_one (notify)` | PASS | `Created Step UUID 943cc3a7-2616-46fc-a5d8-2019b1869d9a` | **PASS** |
| **12. Owner creates webhook trigger** | Owner A | `GraphQL insert_workflow_triggers_one (webhook)` | PASS | `Created Trigger UUID b422e5f7-c0fd-419b-886d-2f158cbbb350` | **PASS** |
| **13. Owner/editor edits trigger** | Owner A | `GraphQL update_workflow_triggers_by_pk` | PASS | `{"id":"b422e5f7-c0fd-419b-886d-2f158cbbb350","enabled":false}` | **PASS** |
| **14. Viewer cannot mutate** | Viewer A | `GraphQL insert_workflows_one` | DENIED | `DENIED: check constraint of an insert/update permission has failed` | **PASS** |
| **15. Org B cross-org mutation** | Owner B (Org B) | `GraphQL update_workflows_by_pk` | DENIED (null) | `null` | **PASS** |
| **16. Workflow aggregate query** | Editor A | `GraphQL workflows_by_pk with nested steps, triggers, runs` | PASS (Returned steps + triggers + recent run) | `Steps: 4, Triggers: 1, Run Status: completed` | **PASS** |

---

## Architecture: Native Hasura GraphQL API vs Internal Server Endpoints

### 1. Primary Assignment Hasura GraphQL Engine Interface (`/v1/graphql`)
All workflow, step, and trigger CRUD operations are executed directly against Hasura GraphQL Engine using standard GraphQL queries and mutations:

* **Create Workflow**: `mutation { insert_workflows_one(object: { org_id, name, created_by }) { id } }`
* **Update Workflow**: `mutation { update_workflows_by_pk(pk_columns: { id }, _set: { name, description }) { id } }`
* **Delete Workflow**: `mutation { delete_workflows_by_pk(id) { id } }`
* **Create Step**: `mutation { insert_workflow_steps_one(object: { workflow_id, position, type, name, config }) { id } }`
* **Update Step**: `mutation { update_workflow_steps_by_pk(pk_columns: { id }, _set: { name, config }) { id } }`
* **Reorder Steps**: `mutation { update_workflow_steps_many(updates: [{ where: { id: { _eq: "step1" } }, _set: { position: 1 } }, { where: { id: { _eq: "step2" } }, _set: { position: 2 } }]) { affected_rows } }`
* **Delete Step**: `mutation { delete_workflow_steps_by_pk(id) { id } }`
* **Create Trigger**: `mutation { insert_workflow_triggers_one(object: { workflow_id, type, config, enabled }) { id } }`
* **Update Trigger**: `mutation { update_workflow_triggers_by_pk(pk_columns: { id }, _set: { enabled, config }) { id } }`
* **Delete Trigger**: `mutation { delete_workflow_triggers_by_pk(id) { id } }`
* **Aggregate Query**:
  ```graphql
  query GetWorkflowAggregate($id: uuid!) {
    workflows_by_pk(id: $id) {
      id
      name
      org_id
      steps(order_by: { position: asc }) { id position type name config }
      triggers { id type config enabled }
      runs(order_by: { created_at: desc }, limit: 1) { id trigger_type status started_at completed_at }
    }
  }
  ```

---

### 2. Internal Server Endpoints & Hasura Actions
* **Hasura Action `triggerWorkflowRun`** (`/api/actions/trigger-workflow`): Verifies caller role, checks quota limit, initializes workflow run.
* **Hasura Action `approveStep`** (`/api/actions/approve-step`): Verifies approver role, checks `approval_gate` paused status, updates `step_runs` and resumes execution.

---

## Declarative Hasura Permission Matrix

| Role | Read Workflow / Steps / Triggers | Insert Normal Step (`llm_call`, `http_request`) | Insert Privileged Step (`db_write`, `notify`) | Insert Webhook Trigger | Reorder Steps | Delete Workflow |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Owner** | Allowed | Allowed | **Allowed** | **Allowed** | Allowed | Allowed |
| **Editor** | Allowed | Allowed | **DENIED (Hasura Check)** | **DENIED (Hasura Check)** | Allowed | Denied |
| **Viewer** | Allowed | Denied | Denied | Denied | Denied | Denied |
