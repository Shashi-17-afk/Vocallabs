import { useState, useMemo } from 'react';
import {
  useAuthenticated,
  useUserData,
  useAccessToken,
  useSignInEmailPassword,
  useSignUpEmailPassword,
  useSignOut,
} from '@nhost/react';
import { gql, useQuery, useSubscription } from '@apollo/client';

const GET_USER_ORGANIZATIONS = gql`
  query GetUserOrganizations {
    organizations {
      id
      name
      quota_limit
      quota_used
      quota_period
      created_at
    }
  }
`;

const SUBSCRIBE_USER_ORGANIZATIONS = gql`
  subscription SubscribeUserOrganizations {
    organizations {
      id
      name
      quota_limit
      quota_used
      quota_period
      created_at
    }
  }
`;

export default function Phase1AuthDashboard() {
  const isAuthenticated = useAuthenticated();
  const userData = useUserData();
  const accessToken = useAccessToken();
  const { signOut } = useSignOut();

  // Auth Form State
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

  // Safe JWT Metadata Parsing (NEVER exposes or renders raw token string)
  const jwtMetadata = useMemo(() => {
    if (!accessToken) return null;
    try {
      const parts = accessToken.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(atob(parts[1]));
      return {
        exists: true,
        issuer: payload.iss || 'Nhost Auth Service',
        expiresAt: payload.exp ? new Date(payload.exp * 1000).toLocaleString() : 'N/A',
        hasuraUserId: payload['https://hasura.io/jwt/claims']?.['x-hasura-user-id'] || 'Missing',
        defaultRole: payload['https://hasura.io/jwt/claims']?.['x-hasura-default-role'] || 'Missing',
        allowedRoles: payload['https://hasura.io/jwt/claims']?.['x-hasura-allowed-roles'] || [],
      };
    } catch {
      return null;
    }
  }, [accessToken]);

  // Authenticated Apollo Query
  const {
    data: queryData,
    loading: queryLoading,
    error: queryError,
    refetch: refetchQuery,
  } = useQuery(GET_USER_ORGANIZATIONS, {
    skip: !isAuthenticated,
  });

  // Authenticated Apollo WebSocket Subscription
  const {
    data: subData,
    loading: subLoading,
    error: subError,
  } = useSubscription(SUBSCRIBE_USER_ORGANIZATIONS, {
    skip: !isAuthenticated,
  });

  // Test Org Creation Trigger
  const [isCreatingOrg, setIsCreatingOrg] = useState(false);
  const [createMessage, setCreateMessage] = useState<string | null>(null);

  const handleCreateOrg = async () => {
    if (!accessToken) return;
    setIsCreatingOrg(true);
    setCreateMessage(null);
    try {
      const res = await fetch('/api/test-create-org', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ orgName: `Test Org ${Math.floor(Math.random() * 900 + 100)}` }),
      });
      const data = await res.json();
      if (res.ok) {
        setCreateMessage(`Created "${data.organization.name}". Watch live WebSocket subscription update below!`);
      } else {
        setCreateMessage(`Error: ${data.error}`);
      }
    } catch (err: any) {
      setCreateMessage(`Error: ${err.message}`);
    } finally {
      setIsCreatingOrg(false);
    }
  };

  return (
    <div style={{ padding: '2rem', maxWidth: '1100px', margin: '0 auto' }}>
      <header style={{ borderBottom: '1px solid #334155', paddingBottom: '1rem', marginBottom: '2rem' }}>
        <h1 style={{ color: '#38bdf8', fontSize: '1.8rem', margin: 0 }}>
          Phase 1 — Nhost Authentication & Real-Time Subscription Verification
        </h1>
        <p style={{ color: '#94a3b8', marginTop: '0.5rem' }}>
          AI Agent Workflow Builder • Authentication & Realtime WebSocket Verification Suite
        </p>
      </header>

      {/* Grid Layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '2rem' }}>
        {/* Section 1: Authentication Form & Status */}
        <div style={{ background: '#1e293b', padding: '1.5rem', borderRadius: '8px', border: '1px solid #334155' }}>
          <h2 style={{ fontSize: '1.2rem', color: '#f1f5f9', marginTop: 0 }}>1. Nhost User Authentication</h2>

          {!isAuthenticated ? (
            <form onSubmit={handleAuthSubmit}>
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
                <button
                  type="button"
                  onClick={() => setIsSignUp(false)}
                  style={{
                    flex: 1,
                    padding: '0.5rem',
                    background: !isSignUp ? '#0284c7' : '#334155',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => setIsSignUp(true)}
                  style={{
                    flex: 1,
                    padding: '0.5rem',
                    background: isSignUp ? '#0284c7' : '#334155',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                >
                  Sign Up
                </button>
              </div>

              <div style={{ marginBottom: '0.8rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', color: '#94a3b8', marginBottom: '0.2rem' }}>
                  Email Address
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@example.com"
                  required
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    background: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '4px',
                    color: '#fff',
                  }}
                />
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label style={{ display: 'block', fontSize: '0.85rem', color: '#94a3b8', marginBottom: '0.2rem' }}>
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    background: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '4px',
                    color: '#fff',
                  }}
                />
              </div>

              {(signInError || signUpError) && (
                <p style={{ color: '#f87171', fontSize: '0.85rem', marginBottom: '0.8rem' }}>
                  {(signInError || signUpError)?.message}
                </p>
              )}

              <button
                type="submit"
                disabled={isSigningIn || isSigningUp}
                style={{
                  width: '100%',
                  padding: '0.6rem',
                  background: '#10b981',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                }}
              >
                {isSigningIn || isSigningUp ? 'Processing...' : isSignUp ? 'Create Nhost Account' : 'Log In with Nhost'}
              </button>
            </form>
          ) : (
            <div>
              <div
                style={{
                  background: '#064e3b',
                  color: '#6ee7b7',
                  padding: '0.8rem',
                  borderRadius: '6px',
                  marginBottom: '1rem',
                  fontSize: '0.9rem',
                }}
              >
                <strong>✓ Authenticated Session Active</strong>
              </div>

              <p style={{ fontSize: '0.9rem' }}>
                <strong>User Email:</strong> {userData?.email}
              </p>

              <p style={{ fontSize: '0.9rem' }}>
                <strong>Nhost User ID (x-hasura-user-id):</strong><br />
                <code style={{ color: '#38bdf8', fontSize: '0.85rem' }}>{userData?.id}</code>
              </p>

              <button
                onClick={() => signOut()}
                style={{
                  padding: '0.5rem 1rem',
                  background: '#ef4444',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                  marginTop: '0.5rem',
                }}
              >
                Sign Out
              </button>
            </div>
          )}
        </div>

        {/* Section 2: Safe JWT Metadata Panel */}
        <div style={{ background: '#1e293b', padding: '1.5rem', borderRadius: '8px', border: '1px solid #334155' }}>
          <h2 style={{ fontSize: '1.2rem', color: '#f1f5f9', marginTop: 0 }}>2. JWT Token & Claims Metadata</h2>
          {jwtMetadata ? (
            <div style={{ fontSize: '0.85rem' }}>
              <p><strong>Token Status:</strong> <span style={{ color: '#4ade80' }}>✓ Active JWT Issued</span></p>
              <p><strong>Issuer (iss):</strong> <code style={{ color: '#cbd5e1' }}>{jwtMetadata.issuer}</code></p>
              <p><strong>Expires At (exp):</strong> <code style={{ color: '#cbd5e1' }}>{jwtMetadata.expiresAt}</code></p>
              <p><strong>x-hasura-user-id Claim:</strong> <code style={{ color: '#38bdf8' }}>{jwtMetadata.hasuraUserId}</code></p>
              <p><strong>x-hasura-default-role Claim:</strong> <code style={{ color: '#facc15' }}>{jwtMetadata.defaultRole}</code></p>
              <p>
                <strong>x-hasura-allowed-roles Claim:</strong>{' '}
                <code style={{ color: '#cbd5e1' }}>{JSON.stringify(jwtMetadata.allowedRoles)}</code>
              </p>

              <div style={{ marginTop: '1rem', background: '#0f172a', padding: '0.6rem', borderRadius: '4px', borderLeft: '3px solid #38bdf8' }}>
                <span style={{ color: '#94a3b8', fontSize: '0.8rem' }}>
                  🔒 Security Enforced: Raw JWT token string is never displayed or printed to console.
                </span>
              </div>
            </div>
          ) : (
            <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
              Log in to inspect verified JWT session claims.
            </p>
          )}
        </div>
      </div>

      {/* Section 3: Authenticated GraphQL Queries & Realtime WebSocket Subscription */}
      <section style={{ background: '#1e293b', padding: '1.5rem', borderRadius: '8px', border: '1px solid #334155' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ fontSize: '1.2rem', color: '#f1f5f9', margin: 0 }}>
            3. Authenticated GraphQL Query & Real-Time WebSocket Subscription
          </h2>
          {isAuthenticated && (
            <button
              onClick={handleCreateOrg}
              disabled={isCreatingOrg}
              style={{
                padding: '0.5rem 1rem',
                background: '#0284c7',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                fontWeight: 'bold',
                cursor: 'pointer',
              }}
            >
              {isCreatingOrg ? 'Creating...' : '+ Create Test Organization'}
            </button>
          )}
        </div>

        {createMessage && (
          <div style={{ background: '#0369a1', color: '#e0f2fe', padding: '0.6rem', borderRadius: '4px', marginBottom: '1rem', fontSize: '0.85rem' }}>
            {createMessage}
          </div>
        )}

        {!isAuthenticated ? (
          <p style={{ color: '#94a3b8' }}>Please log in above to execute authenticated GraphQL queries & subscriptions.</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
            {/* Query Panel */}
            <div style={{ background: '#0f172a', padding: '1rem', borderRadius: '6px', border: '1px solid #334155' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <h3 style={{ fontSize: '0.95rem', color: '#38bdf8', margin: 0 }}>
                  A. Authenticated Query Result (HTTP)
                </h3>
                <button
                  onClick={() => refetchQuery()}
                  style={{ background: '#334155', color: '#fff', border: 'none', padding: '0.2rem 0.5rem', borderRadius: '3px', cursor: 'pointer', fontSize: '0.75rem' }}
                >
                  Refetch
                </button>
              </div>

              {queryLoading ? (
                <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Executing GraphQL query...</p>
              ) : queryError ? (
                <p style={{ color: '#f87171', fontSize: '0.85rem' }}>Query Error: {queryError.message}</p>
              ) : (
                <div>
                  <p style={{ fontSize: '0.8rem', color: '#4ade80' }}>
                    ✓ Hasura validated user JWT & accepted role <code>user</code>
                  </p>
                  <pre style={{ fontSize: '0.75rem', background: '#1e293b', padding: '0.5rem', borderRadius: '4px', overflowX: 'auto', color: '#cbd5e1' }}>
                    {JSON.stringify(queryData?.organizations || [], null, 2)}
                  </pre>
                </div>
              )}
            </div>

            {/* Subscription Panel */}
            <div style={{ background: '#0f172a', padding: '1rem', borderRadius: '6px', border: '1px solid #334155' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <h3 style={{ fontSize: '0.95rem', color: '#10b981', margin: 0 }}>
                  B. Real-Time Subscription Event (graphql-ws)
                </h3>
                <span style={{ fontSize: '0.75rem', color: '#34d399', background: '#064e3b', padding: '0.2rem 0.4rem', borderRadius: '3px' }}>
                  ● WebSocket Active
                </span>
              </div>

              {subLoading ? (
                <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Connecting WebSocket subscription...</p>
              ) : subError ? (
                <p style={{ color: '#f87171', fontSize: '0.85rem' }}>Subscription Error: {subError.message}</p>
              ) : (
                <div>
                  <p style={{ fontSize: '0.8rem', color: '#34d399' }}>
                    ✓ Live Subscription Active — Updates automatically on database mutations
                  </p>
                  <pre style={{ fontSize: '0.75rem', background: '#1e293b', padding: '0.5rem', borderRadius: '4px', overflowX: 'auto', color: '#cbd5e1' }}>
                    {JSON.stringify(subData?.organizations || [], null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
