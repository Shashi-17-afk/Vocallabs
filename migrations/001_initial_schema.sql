-- Phase 2: Database Schema SQL Migration
-- Enables pgcrypto extension for UUID generation if needed
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Organizations
CREATE TABLE IF NOT EXISTS public.organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    quota_limit INTEGER NOT NULL DEFAULT 100,
    quota_used INTEGER NOT NULL DEFAULT 0,
    quota_period TEXT NOT NULL DEFAULT 'monthly',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Organization Members
CREATE TABLE IF NOT EXISTS public.org_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT org_members_org_user_unique UNIQUE (org_id, user_id)
);

-- 3. Workflows
CREATE TABLE IF NOT EXISTS public.workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Workflow Steps
CREATE TABLE IF NOT EXISTS public.workflow_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate')),
    name TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Workflow Triggers
CREATE TABLE IF NOT EXISTS public.workflow_triggers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('manual', 'webhook')),
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Workflow Runs
CREATE TABLE IF NOT EXISTS public.workflow_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id UUID NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
    trigger_type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    error TEXT,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Step Runs
CREATE TABLE IF NOT EXISTS public.step_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_run_id UUID NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
    workflow_step_id UUID NOT NULL REFERENCES public.workflow_steps(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed')),
    input JSONB NOT NULL DEFAULT '{}'::jsonb,
    output JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- 8. DB Write Audit Logs (Destination table for db_write steps)
CREATE TABLE IF NOT EXISTS public.db_write_audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    workflow_run_id UUID NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
    step_run_id UUID NOT NULL REFERENCES public.step_runs(id) ON DELETE CASCADE,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_org_members_user_id ON public.org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org_user ON public.org_members(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_workflows_org_id ON public.workflows(org_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_wf_pos ON public.workflow_steps(workflow_id, position);
CREATE INDEX IF NOT EXISTS idx_workflow_triggers_wf_id ON public.workflow_triggers(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf_status ON public.workflow_runs(workflow_id, status);
CREATE INDEX IF NOT EXISTS idx_step_runs_run_step ON public.step_runs(workflow_run_id, workflow_step_id);

-- 9. PostgreSQL View for Monthly Usage Aggregation
CREATE OR REPLACE VIEW public.org_monthly_usage AS
SELECT 
    o.id AS org_id,
    o.name AS org_name,
    o.quota_limit,
    o.quota_used,
    o.quota_period,
    COUNT(r.id) AS total_runs_this_month,
    COUNT(CASE WHEN r.status = 'completed' THEN 1 END) AS successful_runs_this_month,
    COUNT(CASE WHEN r.status = 'failed' THEN 1 END) AS failed_runs_this_month
FROM public.organizations o
LEFT JOIN public.workflows w ON w.org_id = o.id
LEFT JOIN public.workflow_runs r ON r.workflow_id = w.id 
    AND r.created_at >= date_trunc('month', CURRENT_DATE)
GROUP BY o.id, o.name, o.quota_limit, o.quota_used, o.quota_period;
