import { useState, useMemo, useEffect } from 'react';
import {
  useAuthenticated,
  useUserData,
  useAccessToken,
  useSignInEmailPassword,
  useSignUpEmailPassword,
  useSignOut,
} from '@nhost/react';
import { gql, useQuery, useSubscription, useMutation } from '@apollo/client';

// =================================================================
// GraphQL Queries & Subscriptions
// =================================================================
const GET_USER_MEMBERSHIPS = gql`
  query GetUserMemberships {
    org_members {
      id
      org_id
      role
      organization {
        id
        name
        quota_limit
        quota_used
      }
    }
  }
`;

const SUBSCRIBE_WORKFLOWS = gql`
  subscription SubscribeWorkflows($org_id: uuid!) {
    workflows(where: { org_id: { _eq: $org_id } }, order_by: { created_at: desc }) {
      id
      name
      description
      created_at
      steps(order_by: { position: asc }) {
        id
        position
        type
        name
        config
      }
      triggers {
        id
        type
        config
        enabled
      }
      runs(order_by: { created_at: desc }, limit: 1) {
        id
        trigger_type
        status
        started_at
        completed_at
        error
      }
    }
  }
`;

const SUBSCRIBE_ACTIVE_RUN = gql`
  subscription SubscribeActiveRun($run_id: uuid!) {
    workflow_runs_by_pk(id: $run_id) {
      id
      status
      trigger_type
      started_at
      completed_at
      error
      step_runs(order_by: { started_at: asc }) {
        id
        workflow_step_id
        status
        input
        output
        attempt_count
        error
        approved_by
        approved_at
        started_at
        completed_at
        workflow_step {
          id
          position
          type
          name
        }
      }
    }
  }
`;

const INSERT_WORKFLOW = gql`
  mutation InsertWorkflow($org_id: uuid!, $name: String!, $description: String) {
    insert_workflows_one(object: { org_id: $org_id, name: $name, description: $description }) {
      id
    }
  }
`;

const INSERT_STEP = gql`
  mutation InsertStep($workflow_id: uuid!, $position: Int!, $type: String!, $name: String!, $config: jsonb) {
    insert_workflow_steps_one(object: { workflow_id: $workflow_id, position: $position, type: $type, name: $name, config: $config }) {
      id
    }
  }
`;

const REORDER_STEPS = gql`
  mutation ReorderSteps($updates: [workflow_steps_updates!]!) {
    update_workflow_steps_many(updates: $updates) {
      affected_rows
    }
  }
`;

const DELETE_STEP = gql`
  mutation DeleteStep($id: uuid!) {
    delete_workflow_steps_by_pk(id: $id) {
      id
    }
  }
`;

const INSERT_TRIGGER = gql`
  mutation InsertTrigger($workflow_id: uuid!, $type: String!, $config: jsonb) {
    insert_workflow_triggers_one(object: { workflow_id: $workflow_id, type: $type, config: $config, enabled: true }) {
      id
    }
  }
`;

export default function Dashboard() {
  const isAuthenticated = useAuthenticated();
  const userData = useUserData();
  const accessToken = useAccessToken();
  const { signOut } = useSignOut();

  // Auth State
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { signInEmailPassword, isLoading: isSigningIn, error: signInError } = useSignInEmailPassword();
  const { signUpEmailPassword, isLoading: isSigningUp, error: signUpError } = useSignUpEmailPassword();

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSignUp) {
      await signUpEmailPassword(email, password);
    } else {
      await signInEmailPassword(email, password);
    }
  };

  // Selected Org & Workflow State
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // Modals & UI States
  const [showNewWfModal, setShowNewWfModal] = useState(false);
  const [newWfName, setNewWfName] = useState('');
  const [newWfDesc, setNewWfDesc] = useState('');

  const [showNewStepModal, setShowNewStepModal] = useState(false);
  const [newStepType, setNewStepType] = useState('llm_call');
  const [newStepName, setNewStepName] = useState('');
  const [newStepConfigStr, setNewStepConfigStr] = useState('{"prompt": "Hello AI"}');

  const [showNewTriggerModal, setShowNewTriggerModal] = useState(false);
  const [newTriggerSecret, setNewTriggerSecret] = useState('webhook_secret_123');

  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);

  // Fetch Memberships
  const { data: memData, loading: memLoading } = useQuery(GET_USER_MEMBERSHIPS, {
    skip: !isAuthenticated,
  });

  useEffect(() => {
    if (memData?.org_members?.length > 0 && !selectedOrgId) {
      setSelectedOrgId(memData.org_members[0].org_id);
    }
  }, [memData, selectedOrgId]);

  const activeMembership = useMemo(() => {
    return memData?.org_members?.find((m: any) => m.org_id === selectedOrgId);
  }, [memData, selectedOrgId]);

  const activeRole = activeMembership?.role || 'viewer';

  // Subscriptions
  const { data: wfData, loading: wfLoading } = useSubscription(SUBSCRIBE_WORKFLOWS, {
    skip: !isAuthenticated || !selectedOrgId,
    variables: { org_id: selectedOrgId || '00000000-0000-0000-0000-000000000000' },
  });

  const workflows = wfData?.workflows || [];

  const activeWorkflow = useMemo(() => {
    return workflows.find((w: any) => w.id === selectedWorkflowId) || workflows[0] || null;
  }, [workflows, selectedWorkflowId]);

  const { data: runData } = useSubscription(SUBSCRIBE_ACTIVE_RUN, {
    skip: !isAuthenticated || !activeRunId,
    variables: { run_id: activeRunId || '00000000-0000-0000-0000-000000000000' },
  });

  const activeRun = runData?.workflow_runs_by_pk || null;

  // Mutations
  const [insertWorkflow] = useMutation(INSERT_WORKFLOW);
  const [insertStep] = useMutation(INSERT_STEP);
  const [reorderSteps] = useMutation(REORDER_STEPS);
  const [deleteStep] = useMutation(DELETE_STEP);
  const [insertTrigger] = useMutation(INSERT_TRIGGER);

  // Workflow Handlers
  const handleCreateWorkflow = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrgId || !newWfName) return;
    try {
      const res = await insertWorkflow({
        variables: { org_id: selectedOrgId, name: newWfName, description: newWfDesc },
      });
      setShowNewWfModal(false);
      setNewWfName('');
      setNewWfDesc('');
      if (res.data?.insert_workflows_one?.id) {
        setSelectedWorkflowId(res.data.insert_workflows_one.id);
      }
    } catch (err: any) {
      setActionError(err.message);
    }
  };

  const handleAddStep = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeWorkflow || !newStepName) return;
    try {
      const nextPos = (activeWorkflow.steps?.length || 0) + 1;
      let parsedConfig = {};
      try {
        parsedConfig = JSON.parse(newStepConfigStr);
      } catch {
        parsedConfig = { prompt: newStepConfigStr };
      }

      await insertStep({
        variables: {
          workflow_id: activeWorkflow.id,
          position: nextPos,
          type: newStepType,
          name: newStepName,
          config: parsedConfig,
        },
      });
      setShowNewStepModal(false);
      setNewStepName('');
    } catch (err: any) {
      setActionError(err.message);
    }
  };

  const handleMoveStep = async (stepId: string, direction: 'up' | 'down') => {
    if (!activeWorkflow?.steps) return;
    const steps = [...activeWorkflow.steps];
    const idx = steps.findIndex((s: any) => s.id === stepId);
    if (idx === -1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= steps.length) return;

    const updates = [
      { where: { id: { _eq: steps[idx].id } }, _set: { position: steps[targetIdx].position } },
      { where: { id: { _eq: steps[targetIdx].id } }, _set: { position: steps[idx].position } },
    ];

    try {
      await reorderSteps({ variables: { updates } });
    } catch (err: any) {
      setActionError(err.message);
    }
  };

  const handleDeleteStep = async (stepId: string) => {
    try {
      await deleteStep({ variables: { id: stepId } });
    } catch (err: any) {
      setActionError(err.message);
    }
  };

  const handleAddTrigger = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeWorkflow) return;
    try {
      await insertTrigger({
        variables: {
          workflow_id: activeWorkflow.id,
          type: 'webhook',
          config: { secret: newTriggerSecret },
        },
      });
      setShowNewTriggerModal(false);
    } catch (err: any) {
      setActionError(err.message);
    }
  };

  const handleTriggerRun = async () => {
    if (!activeWorkflow || !accessToken) return;
    setIsTriggering(true);
    setActionError(null);
    try {
      const res = await fetch('/api/actions/trigger-workflow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ input: { workflow_id: activeWorkflow.id } }),
      });
      const data = await res.json();
      if (res.ok) {
        setActiveRunId(data.run_id);
        setActionSuccess(`Workflow Run started (ID: ${data.run_id})`);
      } else {
        setActionError(data.message || 'Failed to trigger workflow');
      }
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setIsTriggering(false);
    }
  };

  const handleApproveStep = async (stepRunId: string) => {
    if (!accessToken) return;
    setActionError(null);
    try {
      const res = await fetch('/api/actions/approve-step', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ input: { step_run_id: stepRunId } }),
      });
      const data = await res.json();
      if (res.ok) {
        setActionSuccess(`Approval granted for Step Run '${stepRunId}'! Execution resumed.`);
      } else {
        setActionError(data.message || 'Failed to approve step');
      }
    } catch (err: any) {
      setActionError(err.message);
    }
  };

  if (!isAuthenticated) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', background: '#0b0f19', padding: '1rem' }}>
        <div className="glass-panel" style={{ width: '100%', maxWidth: '420px' }}>
          <h1 style={{ color: '#38bdf8', fontSize: '1.5rem', textAlign: 'center', marginBottom: '0.5rem' }}>
            ⚡ Vocallabs Workflow Engine
          </h1>
          <p style={{ color: '#94a3b8', fontSize: '0.85rem', textAlign: 'center', marginBottom: '1.5rem' }}>
            Sign in to access your multi-tenant AI workflow workspace
          </p>

          <form onSubmit={handleAuthSubmit}>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <button
                type="button"
                className={!isSignUp ? 'btn-primary' : 'btn-secondary'}
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => setIsSignUp(false)}
              >
                Sign In
              </button>
              <button
                type="button"
                className={isSignUp ? 'btn-primary' : 'btn-secondary'}
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => setIsSignUp(true)}
              >
                Sign Up
              </button>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.8rem', color: '#94a3b8', display: 'block', marginBottom: '0.3rem' }}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
                required
                style={{ width: '100%', padding: '0.6rem', background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', color: '#fff' }}
              />
            </div>

            <div style={{ marginBottom: '1.2rem' }}>
              <label style={{ fontSize: '0.8rem', color: '#94a3b8', display: 'block', marginBottom: '0.3rem' }}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••••"
                required
                style={{ width: '100%', padding: '0.6rem', background: '#1e293b', border: '1px solid #334155', borderRadius: '6px', color: '#fff' }}
              />
            </div>

            {(signInError || signUpError) && (
              <div style={{ color: '#f87171', fontSize: '0.8rem', marginBottom: '1rem', background: 'rgba(239, 68, 68, 0.1)', padding: '0.5rem', borderRadius: '4px' }}>
                {(signInError || signUpError)?.message}
              </div>
            )}

            <button type="submit" className="btn-primary" style={{ width: '100%', justifyContent: 'center' }} disabled={isSigningIn || isSigningUp}>
              {isSigningIn || isSigningUp ? 'Authenticating...' : isSignUp ? 'Create Account' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1400px', margin: '0 auto' }}>
      {/* Top Header Bar */}
      <header className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', color: '#38bdf8', margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            ⚡ Vocallabs Workflow Execution Engine
          </h1>
          <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Multi-Tenant AI Workflow Orchestrator</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          {/* Org Selector */}
          <div>
            <select
              value={selectedOrgId || ''}
              onChange={(e) => setSelectedOrgId(e.target.value)}
              style={{ padding: '0.5rem 1rem', background: '#1e293b', border: '1px solid #334155', color: '#fff', borderRadius: '6px', cursor: 'pointer' }}
            >
              {memData?.org_members?.map((m: any) => (
                <option key={m.org_id} value={m.org_id}>
                  {m.organization?.name} ({m.role})
                </option>
              ))}
            </select>
          </div>

          <span className={`badge badge-${activeRole}`}>{activeRole}</span>

          <span style={{ fontSize: '0.85rem', color: '#cbd5e1' }}>{userData?.email}</span>

          <button className="btn-secondary" onClick={() => signOut()} style={{ fontSize: '0.8rem' }}>
            Sign Out
          </button>
        </div>
      </header>

      {/* Quota Progress Banner */}
      {activeMembership?.organization && (
        <div className="glass-panel" style={{ marginBottom: '1.5rem', padding: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '0.3rem' }}>
            <span>
              <strong>Organization Quota:</strong> {activeMembership.organization.quota_used} / {activeMembership.organization.quota_limit} Monthly Executions
            </span>
            <span style={{ color: activeMembership.organization.quota_used >= activeMembership.organization.quota_limit ? '#ef4444' : '#10b981' }}>
              {Math.round((activeMembership.organization.quota_used / activeMembership.organization.quota_limit) * 100)}% Used
            </span>
          </div>
          <div className="progress-bar-container">
            <div
              className="progress-bar-fill"
              style={{
                width: `${Math.min(100, (activeMembership.organization.quota_used / activeMembership.organization.quota_limit) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {actionError && (
        <div style={{ background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.4)', color: '#f87171', padding: '0.8rem', borderRadius: '6px', marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>⚠️ {actionError}</span>
          <button onClick={() => setActionError(null)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {actionSuccess && (
        <div style={{ background: 'rgba(16, 185, 129, 0.15)', border: '1px solid rgba(16, 185, 129, 0.4)', color: '#34d399', padding: '0.8rem', borderRadius: '6px', marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>✓ {actionSuccess}</span>
          <button onClick={() => setActionSuccess(null)} style={{ background: 'none', border: 'none', color: '#34d399', cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {/* Main Grid: Left Workflow Selector + Middle Builder + Right Live Visualizer */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr 400px', gap: '1.5rem' }}>
        {/* Left Panel: Workflow List */}
        <div className="glass-panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ fontSize: '1rem', margin: 0, color: '#f1f5f9' }}>Workflows</h3>
            {['owner', 'editor'].includes(activeRole) && (
              <button className="btn-primary" style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }} onClick={() => setShowNewWfModal(true)}>
                + New
              </button>
            )}
          </div>

          {wfLoading ? (
            <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Loading workflows...</p>
          ) : workflows.length === 0 ? (
            <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No workflows found. Create one to get started!</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {workflows.map((wf: any) => {
                const isSelected = activeWorkflow?.id === wf.id;
                const lastRun = wf.runs?.[0];
                return (
                  <div
                    key={wf.id}
                    onClick={() => {
                      setSelectedWorkflowId(wf.id);
                      if (lastRun) setActiveRunId(lastRun.id);
                    }}
                    style={{
                      padding: '0.8rem',
                      borderRadius: '8px',
                      background: isSelected ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255, 255, 255, 0.03)',
                      border: isSelected ? '1px solid #38bdf8' : '1px solid transparent',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                    }}
                  >
                    <div style={{ fontWeight: 'bold', fontSize: '0.9rem', color: isSelected ? '#38bdf8' : '#f1f5f9' }}>{wf.name}</div>
                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.2rem' }}>
                      {wf.steps?.length || 0} steps • {wf.triggers?.length || 0} triggers
                    </div>
                    {lastRun && (
                      <div style={{ marginTop: '0.4rem' }}>
                        <span className={`badge badge-${lastRun.status}`}>{lastRun.status}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Middle Panel: Visual Workflow Builder & Reordering Canvas */}
        <div className="glass-panel">
          {activeWorkflow ? (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid #334155', paddingBottom: '0.8rem' }}>
                <div>
                  <h2 style={{ fontSize: '1.2rem', margin: 0, color: '#f1f5f9' }}>{activeWorkflow.name}</h2>
                  <p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: '0.2rem 0 0 0' }}>{activeWorkflow.description || 'No description provided'}</p>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {['owner', 'editor'].includes(activeRole) && (
                    <button className="btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => setShowNewStepModal(true)}>
                      + Add Step
                    </button>
                  )}
                  {activeRole === 'owner' && (
                    <button className="btn-secondary" style={{ fontSize: '0.8rem' }} onClick={() => setShowNewTriggerModal(true)}>
                      + Webhook Trigger
                    </button>
                  )}
                  {['owner', 'editor'].includes(activeRole) && (
                    <button className="btn-primary" onClick={handleTriggerRun} disabled={isTriggering}>
                      {isTriggering ? 'Triggering...' : '▶ Run Workflow'}
                    </button>
                  )}
                </div>
              </div>

              {/* Triggers Bar */}
              {activeWorkflow.triggers?.length > 0 && (
                <div style={{ background: '#0f172a', padding: '0.8rem', borderRadius: '6px', marginBottom: '1rem', border: '1px solid #334155' }}>
                  <div style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.3rem' }}>Workflow Triggers:</div>
                  {activeWorkflow.triggers.map((t: any) => (
                    <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem' }}>
                      <span>⚡ <strong>Webhook Trigger Secret:</strong> <code>{t.config?.secret || 'secret_webhook_key_123'}</code></span>
                      <button
                        className="btn-secondary"
                        style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem' }}
                        onClick={() => {
                          const curl = `curl -X POST "http://localhost:3000/api/triggers/webhook?workflow_id=${activeWorkflow.id}&secret=${t.config?.secret || 'secret_webhook_key_123'}"`;
                          navigator.clipboard.writeText(curl);
                          setActionSuccess('Copied Webhook cURL command to clipboard!');
                        }}
                      >
                        Copy cURL
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Ordered Steps Visual Cards */}
              <h3 style={{ fontSize: '0.95rem', color: '#cbd5e1', marginBottom: '0.8rem' }}>Steps Flowchart</h3>

              {activeWorkflow.steps?.length === 0 ? (
                <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No steps added yet. Click "+ Add Step" above to build your workflow!</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                  {activeWorkflow.steps.map((step: any, idx: number) => (
                    <div
                      key={step.id}
                      style={{
                        background: '#1e293b',
                        border: '1px solid #334155',
                        borderRadius: '8px',
                        padding: '1rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: '#38bdf8', color: '#0f172a', fontWeight: 'bold', display: 'flex', justifyContent: 'center', alignItems: 'center', fontSize: '0.85rem' }}>
                          {step.position}
                        </div>
                        <div>
                          <div style={{ fontWeight: 'bold', fontSize: '0.9rem' }}>{step.name}</div>
                          <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                            Type: <code>{step.type}</code> • Config: {JSON.stringify(step.config || {})}
                          </div>
                        </div>
                      </div>

                      {['owner', 'editor'].includes(activeRole) && (
                        <div style={{ display: 'flex', gap: '0.3rem' }}>
                          <button className="btn-secondary" style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem' }} disabled={idx === 0} onClick={() => handleMoveStep(step.id, 'up')}>
                            ▲
                          </button>
                          <button className="btn-secondary" style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem' }} disabled={idx === activeWorkflow.steps.length - 1} onClick={() => handleMoveStep(step.id, 'down')}>
                            ▼
                          </button>
                          <button className="btn-secondary" style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem', color: '#ef4444' }} onClick={() => handleDeleteStep(step.id)}>
                            ✕
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p style={{ color: '#94a3b8' }}>Select a workflow from the left sidebar to edit and visualize.</p>
          )}
        </div>

        {/* Right Panel: Live Real-Time Execution Engine Visualizer */}
        <div className="glass-panel">
          <h3 style={{ fontSize: '1rem', margin: '0 0 1rem 0', color: '#f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Live Execution Visualizer</span>
            <span style={{ fontSize: '0.75rem', color: '#34d399', background: '#064e3b', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
              ● WebSocket Active
            </span>
          </h3>

          {!activeRun ? (
            <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No active run selected. Click "Run Workflow" to trigger execution.</p>
          ) : (
            <div>
              <div style={{ background: '#0f172a', padding: '0.8rem', borderRadius: '6px', marginBottom: '1rem', border: '1px solid #334155' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                  <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>Run ID: <code>{activeRun.id.slice(0, 8)}...</code></span>
                  <span className={`badge badge-${activeRun.status}`}>{activeRun.status}</span>
                </div>
                <div style={{ fontSize: '0.75rem', color: '#cbd5e1' }}>
                  Trigger: <strong>{activeRun.trigger_type}</strong> • Started: {activeRun.started_at ? new Date(activeRun.started_at).toLocaleTimeString() : 'N/A'}
                </div>
                {activeRun.error && (
                  <div style={{ marginTop: '0.5rem', color: '#f87171', fontSize: '0.75rem', background: 'rgba(239,68,68,0.1)', padding: '0.4rem', borderRadius: '4px' }}>
                    Error: {activeRun.error}
                  </div>
                )}
              </div>

              {/* Step Runs Realtime Progress */}
              <h4 style={{ fontSize: '0.85rem', color: '#cbd5e1', marginBottom: '0.5rem' }}>Step Runs Execution Stream</h4>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                {activeRun.step_runs?.map((sr: any) => (
                  <div
                    key={sr.id}
                    style={{
                      background: '#1e293b',
                      padding: '0.8rem',
                      borderRadius: '6px',
                      borderLeft: `4px solid ${
                        sr.status === 'completed' ? '#10b981' : sr.status === 'paused' ? '#f59e0b' : sr.status === 'failed' ? '#ef4444' : '#38bdf8'
                      }`,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
                      <span style={{ fontWeight: 'bold', fontSize: '0.85rem' }}>
                        Step {sr.workflow_step?.position || '?'}: {sr.workflow_step?.name || 'Step'}
                      </span>
                      <span className={`badge badge-${sr.status}`}>{sr.status}</span>
                    </div>

                    <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                      Attempts: {sr.attempt_count || 1} • Type: <code>{sr.workflow_step?.type}</code>
                    </div>

                    {/* Live Approval Gate Control */}
                    {sr.status === 'paused' && sr.workflow_step?.type === 'approval_gate' && (
                      <div style={{ marginTop: '0.6rem', background: 'rgba(245, 158, 11, 0.15)', padding: '0.6rem', borderRadius: '4px', border: '1px solid rgba(245, 158, 11, 0.4)' }}>
                        <div style={{ fontSize: '0.8rem', color: '#fbbf24', marginBottom: '0.4rem', fontWeight: 'bold' }}>
                          ⏸️ Paused at Approval Gate
                        </div>
                        {['owner', 'editor'].includes(activeRole) ? (
                          <button className="btn-success" style={{ width: '100%', fontSize: '0.8rem', padding: '0.4rem' }} onClick={() => handleApproveStep(sr.id)}>
                            ✓ Approve Step Execution
                          </button>
                        ) : (
                          <p style={{ color: '#94a3b8', fontSize: '0.75rem', margin: 0 }}>Viewer role cannot approve steps.</p>
                        )}
                      </div>
                    )}

                    {sr.output && (
                      <pre style={{ fontSize: '0.7rem', background: '#0f172a', padding: '0.4rem', borderRadius: '4px', marginTop: '0.5rem', color: '#cbd5e1', overflowX: 'auto' }}>
                        {JSON.stringify(sr.output, null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* New Workflow Modal */}
      {showNewWfModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ marginTop: 0 }}>Create Workflow</h3>
            <form onSubmit={handleCreateWorkflow}>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.3rem' }}>Workflow Name</label>
                <input
                  type="text"
                  value={newWfName}
                  onChange={(e) => setNewWfName(e.target.value)}
                  placeholder="e.g. Lead Qualification Pipeline"
                  required
                  style={{ width: '100%', padding: '0.6rem', background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#fff' }}
                />
              </div>

              <div style={{ marginBottom: '1.2rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.3rem' }}>Description</label>
                <textarea
                  value={newWfDesc}
                  onChange={(e) => setNewWfDesc(e.target.value)}
                  placeholder="Describe workflow purpose..."
                  rows={3}
                  style={{ width: '100%', padding: '0.6rem', background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#fff' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button type="button" className="btn-secondary" onClick={() => setShowNewWfModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Create Workflow
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New Step Modal */}
      {showNewStepModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ marginTop: 0 }}>Add Workflow Step</h3>
            <form onSubmit={handleAddStep}>
              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.3rem' }}>Step Type</label>
                <select
                  value={newStepType}
                  onChange={(e) => setNewStepType(e.target.value)}
                  style={{ width: '100%', padding: '0.6rem', background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#fff' }}
                >
                  <option value="llm_call">llm_call (AI Prompt)</option>
                  <option value="http_request">http_request (API Webhook)</option>
                  <option value="approval_gate">approval_gate (Pause Gate)</option>
                  <option value="conditional_branch">conditional_branch (If/Else)</option>
                  <option value="db_write" disabled={activeRole !== 'owner'}>
                    db_write (Owner Only)
                  </option>
                  <option value="notify" disabled={activeRole !== 'owner'}>
                    notify (Owner Only)
                  </option>
                </select>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.3rem' }}>Step Name</label>
                <input
                  type="text"
                  value={newStepName}
                  onChange={(e) => setNewStepName(e.target.value)}
                  placeholder="e.g. Generate AI Summary"
                  required
                  style={{ width: '100%', padding: '0.6rem', background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#fff' }}
                />
              </div>

              <div style={{ marginBottom: '1.2rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.3rem' }}>Config JSON</label>
                <textarea
                  value={newStepConfigStr}
                  onChange={(e) => setNewStepConfigStr(e.target.value)}
                  rows={4}
                  style={{ width: '100%', padding: '0.6rem', background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#fff', fontFamily: 'monospace', fontSize: '0.8rem' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button type="button" className="btn-secondary" onClick={() => setShowNewStepModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Add Step
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New Webhook Trigger Modal */}
      {showNewTriggerModal && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3 style={{ marginTop: 0 }}>Add Webhook Trigger</h3>
            <form onSubmit={handleAddTrigger}>
              <div style={{ marginBottom: '1.2rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.3rem' }}>Trigger Secret Key</label>
                <input
                  type="text"
                  value={newTriggerSecret}
                  onChange={(e) => setNewTriggerSecret(e.target.value)}
                  required
                  style={{ width: '100%', padding: '0.6rem', background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: '#fff' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button type="button" className="btn-secondary" onClick={() => setShowNewTriggerModal(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary">
                  Create Webhook Trigger
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
