# Hasura Database Event Trigger Verification Report

This document records the empirical verification results for the Hasura PostgreSQL Database Event Trigger backing `notify` workflow steps.

## Event Trigger Specification
- **Event Trigger Name**: `notify_step_completed`
- **Watched Table**: `public.step_runs`
- **Watched Operation**: `UPDATE`
- **Trigger Condition**: `step_runs.workflow_step.type = 'notify' AND step_runs.status = 'completed'`
- **Handler Endpoint**: `/api/events/notify` (`http://host.docker.internal:3000/api/events/notify`)
- **Authentication Mechanism**: Secret header `x-hasura-event-secret` evaluated against `process.env.EVENT_SECRET`
- **Idempotency Mechanism**: PostgreSQL table `public.notification_logs` with atomic `INSERT ... ON CONFLICT (event_id) DO NOTHING`

---

## Empirical Verification Matrix

| Test | Expected | Actual Result | Status |
| :--- | :--- | :--- | :--- |
| **1. Successful Event Delivery for Completed Notify Step** | HTTP 200, status delivered, notification_logs entry created | `HTTP 200, status: delivered, log recorded: true` | **PASS** |
| **2. Idempotency Check on Duplicate Event Delivery** | HTTP 200, status idempotent_skip, zero duplicate notification | `HTTP 200, status: idempotent_skip` | **PASS** |
| **3. Negative Test — Non-Notify Step Completion** | HTTP 200, status ignored (step type not notify) | `HTTP 200, status: ignored` | **PASS** |
| **4. Negative Test — Notify Step Status Not Completed** | HTTP 200, status ignored (status running) | `HTTP 200, status: ignored` | **PASS** |
| **5. Negative Test — Unauthenticated Request** | HTTP 401 Unauthorized | `HTTP 401` | **PASS** |

---

## Hasura Reproducible Metadata
Reproducible Hasura metadata for this Database Event Trigger has been registered against the live Hasura instance and exported to:
- `hasura/metadata/event_triggers.yaml`
- `hasura/metadata/event_triggers.json`
