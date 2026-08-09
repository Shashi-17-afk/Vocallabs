import { useEffect, useState } from 'react';
import { useAuthenticated, useUserData, useAccessToken } from '@nhost/react';

export default function Phase1Dashboard() {
  const isAuthenticated = useAuthenticated();
  const userData = useUserData();
  const accessToken = useAccessToken();

  const [healthData, setHealthData] = useState<any>(null);
  const [loadingHealth, setLoadingHealth] = useState(true);

  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json())
      .then((data) => {
        setHealthData(data);
        setLoadingHealth(false);
      })
      .catch((err) => {
        setHealthData({ error: err.message });
        setLoadingHealth(false);
      });
  }, []);

  return (
    <div style={{ padding: '2rem', maxWidth: '1000px', margin: '0 auto' }}>
      <header style={{ borderBottom: '1px solid #334155', paddingBottom: '1rem', marginBottom: '2rem' }}>
        <h1 style={{ color: '#38bdf8', fontSize: '1.8rem', margin: 0 }}>
          Phase 1 — Infrastructure & Authentication Verification
        </h1>
        <p style={{ color: '#94a3b8', marginTop: '0.5rem' }}>
          AI Agent Workflow Builder Platform • Live Diagnostic Verification Dashboard
        </p>
      </header>

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '2rem' }}>
        {/* Environment & Services Status */}
        <div style={{ background: '#1e293b', padding: '1.5rem', borderRadius: '8px', border: '1px solid #334155' }}>
          <h2 style={{ fontSize: '1.2rem', color: '#f1f5f9', marginTop: 0 }}>1. Infrastructure & Database Feasibility</h2>
          {loadingHealth ? (
            <p style={{ color: '#94a3b8' }}>Running diagnostic checks...</p>
          ) : healthData?.diagnostics ? (
            <div style={{ fontSize: '0.9rem' }}>
              <div style={{ marginBottom: '0.8rem' }}>
                <strong>Supabase PostgreSQL:</strong>
                <span
                  style={{
                    display: 'block',
                    padding: '0.4rem',
                    borderRadius: '4px',
                    marginTop: '0.2rem',
                    background: healthData.diagnostics.supabase_database.success ? '#064e3b' : '#7f1d1d',
                    color: healthData.diagnostics.supabase_database.success ? '#6ee7b7' : '#fca5a5',
                  }}
                >
                  {healthData.diagnostics.supabase_database.message}
                </span>
              </div>

              <div style={{ marginBottom: '0.8rem' }}>
                <strong>Hasura GraphQL Engine:</strong>
                <span
                  style={{
                    display: 'block',
                    padding: '0.4rem',
                    borderRadius: '4px',
                    marginTop: '0.2rem',
                    background: healthData.diagnostics.hasura_graphql.success ? '#064e3b' : '#7f1d1d',
                    color: healthData.diagnostics.hasura_graphql.success ? '#6ee7b7' : '#fca5a5',
                  }}
                >
                  {healthData.diagnostics.hasura_graphql.message}
                </span>
              </div>

              <div>
                <strong>Nhost Auth JWKS Endpoint:</strong>
                <span
                  style={{
                    display: 'block',
                    padding: '0.4rem',
                    borderRadius: '4px',
                    marginTop: '0.2rem',
                    background: healthData.diagnostics.nhost_jwks_auth.success ? '#064e3b' : '#7f1d1d',
                    color: healthData.diagnostics.nhost_jwks_auth.success ? '#6ee7b7' : '#fca5a5',
                  }}
                >
                  {healthData.diagnostics.nhost_jwks_auth.message}
                </span>
              </div>
            </div>
          ) : (
            <p style={{ color: '#fca5a5' }}>Failed to load health check: {healthData?.error}</p>
          )}
        </div>

        {/* Auth & Hasura Identity Status */}
        <div style={{ background: '#1e293b', padding: '1.5rem', borderRadius: '8px', border: '1px solid #334155' }}>
          <h2 style={{ fontSize: '1.2rem', color: '#f1f5f9', marginTop: 0 }}>2. Nhost Auth & Hasura JWT Identity</h2>
          <div style={{ fontSize: '0.9rem' }}>
            <p>
              <strong>Auth Session Status:</strong>{' '}
              <span style={{ color: isAuthenticated ? '#4ade80' : '#fbbf24' }}>
                {isAuthenticated ? 'Authenticated' : 'Unauthenticated (Public)'}
              </span>
            </p>

            <p>
              <strong>Current User ID (x-hasura-user-id):</strong>{' '}
              <code style={{ background: '#0f172a', padding: '0.2rem 0.4rem', borderRadius: '4px', color: '#38bdf8' }}>
                {userData?.id || 'N/A (Not logged in)'}
              </code>
            </p>

            <p>
              <strong>JWT Access Token:</strong>{' '}
              <code style={{ background: '#0f172a', padding: '0.2rem 0.4rem', borderRadius: '4px', color: '#cbd5e1', wordBreak: 'break-all' }}>
                {accessToken ? `${accessToken.substring(0, 30)}...` : 'None'}
              </code>
            </p>
          </div>
        </div>
      </section>

      {/* Environment Variable Audit */}
      <section style={{ background: '#1e293b', padding: '1.5rem', borderRadius: '8px', border: '1px solid #334155' }}>
        <h2 style={{ fontSize: '1.2rem', color: '#f1f5f9', marginTop: 0 }}>3. Environment Configuration Audit</h2>
        {healthData?.environment && (
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #334155', color: '#94a3b8' }}>
                <th style={{ padding: '0.5rem' }}>Variable Name</th>
                <th style={{ padding: '0.5rem' }}>Configured</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(healthData.environment).map(([key, isSet]) => (
                <tr key={key} style={{ borderBottom: '1px solid #1e293b' }}>
                  <td style={{ padding: '0.5rem', fontFamily: 'monospace' }}>{key}</td>
                  <td style={{ padding: '0.5rem' }}>
                    <span style={{ color: isSet ? '#4ade80' : '#f87171' }}>
                      {isSet ? '✓ Set' : '✗ Missing'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
