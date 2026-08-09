# Layer 1 Security Verification Report

This document records the empirical verification results for Hasura row-level permission rules and multi-tenant organization isolation.

## Security Verification Matrix

| Test | JWT User | Operation | Target Org | Expected | Actual | Result |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Test 1 — Direct workflow UUID guessing** | User B (Org B Owner) | `workflows_by_pk(id: Org A UUID)` | Org A Workflow | null (0 rows) | `null` | **PASS** |
| **Test 2 — Workflow list isolation** | User B (Org B Owner) | `query workflows` | Org A Workflows | 0 Org A workflows | `Returned 0 total workflows, 0 from Org A` | **PASS** |
| **Test 3 — Child resource guessing** | User B (Org B Owner) | `by_pk query on steps, triggers, runs, step_runs` | Org A Child Resources | null for all child resources | `all null` | **PASS** |
| **Test 4 — UPDATE attack** | User B (Org B Owner) | `update_workflows_by_pk` | Org A Workflow | null / 0 affected rows | `null` | **PASS** |
| **Test 5 — DELETE attack** | User B (Org B Owner) | `delete_workflows_by_pk` | Org A Workflow | null / 0 affected rows | `null` | **PASS** |
| **Test 6 — INSERT attack** | User B (Org B Owner) | `insert workflow into Org A` | Org A Resources | ALL DENIED | `DENIED: unexpected variables in variableValues: wfId` | **PASS** |
| **Test 7 — org_members escalation** | User B (Org B Owner) | `insert into org_members (Org A)` | Org A Membership | ALL DENIED | `DENIED: check constraint of an insert/update permission has failed` | **PASS** |
| **Test 8 — Legitimate Org A access** | User A (Org A Owner) | `workflows_by_pk(id: Org A UUID)` | Org A Workflow | Returned Org A workflow | `{"id":"e954f7a2-3d83-4d24-a53a-39c1cf30fb69","name":"Org A Confidential Workflow","org_id":"b3dc90cb-2a8a-4449-963b-8bddeb2fc126"}` | **PASS** |

---

## Executed GraphQL Operations

### Test 1 — Direct Workflow UUID Guessing
```graphql
query GuessWorkflow($id: uuid!) {
  workflows_by_pk(id: $id) {
    id
    name
    org_id
  }
}
```

### Test 2 — Workflow List Isolation
```graphql
query ListWorkflows {
  workflows {
    id
    name
    org_id
  }
}
```

### Test 3 — Child Resource Guessing
```graphql
query GuessChildResources($stepId: uuid!, $trigId: uuid!, $runId: uuid!, $stepRunId: uuid!) {
  workflow_steps_by_pk(id: $stepId) { id name }
  workflow_triggers_by_pk(id: $trigId) { id type }
  workflow_runs_by_pk(id: $runId) { id status }
  step_runs_by_pk(id: $stepRunId) { id status }
}
```

### Test 4 — UPDATE Attack
```graphql
mutation AttackUpdateWorkflow($id: uuid!, $name: String!) {
  update_workflows_by_pk(pk_columns: { id: $id }, _set: { name: $name }) {
    id
    name
  }
}
```

### Test 5 — DELETE Attack
```graphql
mutation AttackDeleteWorkflow($id: uuid!) {
  delete_workflows_by_pk(id: $id) {
    id
  }
}
```

### Test 6 — INSERT Attack
```graphql
mutation AttackInsertIntoOrgA($orgId: uuid!, $wfId: uuid!, $userIdB: uuid!) {
  insert_workflows_one(object: { org_id: $orgId, name: "Malicious Workflow", created_by: $userIdB }) { id }
}
```

### Test 7 — org_members Escalation
```graphql
mutation AttackOrgMembers($orgId: uuid!, $userIdB: uuid!) {
  insert_org_members_one(object: { org_id: $orgId, user_id: $userIdB, role: "owner" }) { id }
}
```

### Test 8 — Legitimate Org A Access
```graphql
query LegitimateOrgARead($id: uuid!) {
  workflows_by_pk(id: $id) {
    id
    name
    org_id
  }
}
```
